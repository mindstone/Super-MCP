import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageConfig } from '../src/types.js';

const mocks = vi.hoisted(() => {
  const transportCtor = vi.fn();
  const clientConnect = vi.fn().mockResolvedValue(undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return { transportCtor, clientConnect, logger };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mocks.clientConnect;
    close = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn();
    callTool = vi.fn();
    readResource = vi.fn();
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    pid = 4321;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.transportCtor(options);
    }
  },
}));

vi.mock('../src/logging.js', () => ({
  getLogger: () => mocks.logger,
}));

import { StdioMcpClient } from '../src/clients/stdioClient.js';

const originalEnv = {
  rebelWorkspace: process.env.REBEL_WORKSPACE_PATH,
  mcpWorkspace: process.env.MCP_WORKSPACE_PATH,
  rebelRoots: process.env.REBEL_ALLOWED_SYMLINK_ROOTS,
};

function restoreEnv() {
  if (originalEnv.rebelWorkspace === undefined) {
    delete process.env.REBEL_WORKSPACE_PATH;
  } else {
    process.env.REBEL_WORKSPACE_PATH = originalEnv.rebelWorkspace;
  }
  if (originalEnv.mcpWorkspace === undefined) {
    delete process.env.MCP_WORKSPACE_PATH;
  } else {
    process.env.MCP_WORKSPACE_PATH = originalEnv.mcpWorkspace;
  }
  if (originalEnv.rebelRoots === undefined) {
    delete process.env.REBEL_ALLOWED_SYMLINK_ROOTS;
  } else {
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = originalEnv.rebelRoots;
  }
}

function createConfig(
  catalogId: string,
  env?: Record<string, string>,
): PackageConfig {
  return {
    id: catalogId,
    name: catalogId,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@mindstone/mcp-server-${catalogId}`],
    visibility: 'default',
    catalogId,
    ...(env ? { env } : {}),
  };
}

function createClient(catalogId: string, env?: Record<string, string>) {
  const client = new StdioMcpClient(catalogId, createConfig(catalogId, env));
  mocks.transportCtor.mockClear();
  mocks.clientConnect.mockClear();
  mocks.logger.info.mockClear();
  mocks.logger.warn.mockClear();
  mocks.logger.error.mockClear();
  mocks.logger.debug.mockClear();
  return client;
}

function getConnectTransportOptions(): Record<string, unknown> {
  expect(mocks.transportCtor).toHaveBeenCalledTimes(1);
  return mocks.transportCtor.mock.calls[0][0] as Record<string, unknown>;
}

describe('StdioMcpClient declared-Space symlink roots injection (Stage 4 contract)', () => {
  beforeEach(() => {
    restoreEnv();
    delete process.env.REBEL_WORKSPACE_PATH;
    delete process.env.MCP_WORKSPACE_PATH;
    delete process.env.REBEL_ALLOWED_SYMLINK_ROOTS;
    mocks.transportCtor.mockClear();
    mocks.clientConnect.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.debug.mockClear();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('injects MCP_ALLOWED_SYMLINK_ROOTS for catalogId === "openai-image-generation"', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '["/Users/me/Drive/CoS"]';
    const client = createClient('openai-image-generation');

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
    expect(env.MCP_ALLOWED_SYMLINK_ROOTS).toBe('["/Users/me/Drive/CoS"]');
  });

  it('does NOT inject MCP_ALLOWED_SYMLINK_ROOTS for an unrelated catalogId (F4 leak guard)', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '["/Users/me/Drive/CoS"]';
    const client = createClient('nano-banana');

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
    // The unrelated connector must NOT receive the declared-Space roots —
    // unscoped injection would leak every declared-Space absolute path
    // (which carries account/mount names) to third-party stdio connectors.
    expect(env).not.toHaveProperty('MCP_ALLOWED_SYMLINK_ROOTS');
    expect(env).not.toHaveProperty('REBEL_ALLOWED_SYMLINK_ROOTS');
  });

  it('does NOT inject MCP_ALLOWED_SYMLINK_ROOTS when the parent roots env is unset', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    delete process.env.REBEL_ALLOWED_SYMLINK_ROOTS;
    const client = createClient('openai-image-generation');

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
    expect(env).not.toHaveProperty('MCP_ALLOWED_SYMLINK_ROOTS');
  });

  it('does NOT inject MCP_ALLOWED_SYMLINK_ROOTS when the parent roots env is whitespace-only', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '   ';
    const client = createClient('openai-image-generation');

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
    expect(env).not.toHaveProperty('MCP_ALLOWED_SYMLINK_ROOTS');
  });

  it('coexists with catalog env (does not clobber existing keys)', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '["/mnt/CoS"]';
    const client = createClient('openai-image-generation', {
      OPENAI_API_KEY: 'sk-test',
    });

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.MCP_ALLOWED_SYMLINK_ROOTS).toBe('["/mnt/CoS"]');
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
  });

  it('does not log the raw roots value (sensitive — carries account/mount names)', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '["/Users/me/Drive/CoS"]';
    const client = createClient('openai-image-generation');

    await client.connect();

    for (const call of mocks.logger.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('/Users/me/Drive/CoS');
    }
    for (const call of mocks.logger.debug.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('/Users/me/Drive/CoS');
    }
  });

  it('injects the parent value verbatim (no re-serialisation or canonicalisation)', async () => {
    process.env.REBEL_WORKSPACE_PATH = '/test/workspace';
    // A value with a colon in the path — the host serialises via JSON.stringify,
    // the router forwards verbatim, the connector re-canonicalises per call.
    process.env.REBEL_ALLOWED_SYMLINK_ROOTS = '["/a:b/c"]';
    const client = createClient('openai-image-generation');

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_ALLOWED_SYMLINK_ROOTS).toBe('["/a:b/c"]');
  });
});
