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

const originalWorkspaceEnv = {
  rebel: process.env.REBEL_WORKSPACE_PATH,
  mcp: process.env.MCP_WORKSPACE_PATH,
};

function setWorkspaceEnv(options: { rebel?: string; mcp?: string }) {
  if (options.rebel === undefined) {
    delete process.env.REBEL_WORKSPACE_PATH;
  } else {
    process.env.REBEL_WORKSPACE_PATH = options.rebel;
  }

  if (options.mcp === undefined) {
    delete process.env.MCP_WORKSPACE_PATH;
  } else {
    process.env.MCP_WORKSPACE_PATH = options.mcp;
  }
}

function createConfig(env?: Record<string, string>): PackageConfig {
  return {
    id: 'nano-banana',
    name: 'Nano Banana',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mindstone/mcp-server-nano-banana'],
    visibility: 'default',
    ...(env ? { env } : {}),
  };
}

function createClient(env?: Record<string, string>) {
  const client = new StdioMcpClient('nano-banana', createConfig(env));
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

function getInfoPayload(message: string): Record<string, unknown> {
  const call = mocks.logger.info.mock.calls.find(([logMessage]) => logMessage === message);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe('StdioMcpClient workspace env propagation', () => {
  beforeEach(() => {
    setWorkspaceEnv({ rebel: originalWorkspaceEnv.rebel, mcp: originalWorkspaceEnv.mcp });
    mocks.transportCtor.mockClear();
    mocks.clientConnect.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.debug.mockClear();
  });

  afterEach(() => {
    setWorkspaceEnv({ rebel: originalWorkspaceEnv.rebel, mcp: originalWorkspaceEnv.mcp });
  });

  it('injects MCP_WORKSPACE_PATH from REBEL_WORKSPACE_PATH into the transport env', async () => {
    setWorkspaceEnv({ rebel: '/test/workspace', mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(mocks.clientConnect).toHaveBeenCalledTimes(1);
    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/test/workspace',
    });
  });

  it('does not propagate REBEL_WORKSPACE_PATH into the child process env', async () => {
    setWorkspaceEnv({ rebel: '/test/workspace', mcp: undefined });
    const client = createClient();

    await client.connect();

    const env = getConnectTransportOptions().env as Record<string, string>;
    expect(env.MCP_WORKSPACE_PATH).toBe('/test/workspace');
    expect(env).not.toHaveProperty('REBEL_WORKSPACE_PATH');
  });

  it('skips workspace injection when the parent workspace env is empty', async () => {
    setWorkspaceEnv({ rebel: '', mcp: undefined });
    const client = createClient({ FOO: 'bar' });

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({ FOO: 'bar' });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('uses MCP_WORKSPACE_PATH when only it is set on the parent env', async () => {
    setWorkspaceEnv({ rebel: undefined, mcp: '/user/workspace' });
    const client = createClient();

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/user/workspace',
    });
  });

  it('falls through to MCP_WORKSPACE_PATH when REBEL_WORKSPACE_PATH is empty string', async () => {
    setWorkspaceEnv({ rebel: '', mcp: '/user/workspace' });
    const client = createClient();

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/user/workspace',
    });
  });

  it('reads workspace env at connect() time, not at construction time', async () => {
    setWorkspaceEnv({ rebel: undefined, mcp: undefined });
    const client = createClient();

    setWorkspaceEnv({ rebel: '/late/workspace', mcp: undefined });

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/late/workspace',
    });
  });

  it('router value overrides catalog MCP_WORKSPACE_PATH and emits warn', async () => {
    setWorkspaceEnv({ rebel: '/user/workspace', mcp: undefined });
    const client = createClient({
      MCP_WORKSPACE_PATH: '/catalog/path',
      OTHER: 'keep-me',
    });

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/user/workspace',
      OTHER: 'keep-me',
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'catalog env MCP_WORKSPACE_PATH overridden by router',
      {
        package_id: 'nano-banana',
        had_catalog_value: true,
      },
    );
  });

  it('passes catalog env through when parent workspace env is unset', async () => {
    setWorkspaceEnv({ rebel: undefined, mcp: undefined });
    const client = createClient({
      MCP_WORKSPACE_PATH: '/catalog/path',
      OTHER: 'keep-me',
    });

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/catalog/path',
      OTHER: 'keep-me',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('coexists with REBEL_WORKSPACE_PATH in catalog env (openai-image scenario)', async () => {
    setWorkspaceEnv({ rebel: '/user/workspace', mcp: undefined });
    const client = createClient({
      REBEL_WORKSPACE_PATH: '/electron/workspace',
    });

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      REBEL_WORKSPACE_PATH: '/electron/workspace',
      MCP_WORKSPACE_PATH: '/user/workspace',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it("emits INFO log with workspace: 'set' when propagating", async () => {
    setWorkspaceEnv({ rebel: '/user/workspace', mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(getInfoPayload('Connecting to stdio MCP')).toEqual(
      expect.objectContaining({ workspace: 'set' }),
    );
    for (const call of mocks.logger.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('/user/workspace');
    }
  });

  it("emits INFO log with workspace: 'unset' when no workspace env is available", async () => {
    setWorkspaceEnv({ rebel: undefined, mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(getInfoPayload('Connecting to stdio MCP')).toEqual(
      expect.objectContaining({ workspace: 'unset' }),
    );
  });

  it('emits DEBUG log with raw workspace_path for diagnostics', async () => {
    setWorkspaceEnv({ rebel: '/diag/workspace', mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(mocks.logger.debug).toHaveBeenCalledWith(
      'stdio subprocess workspace env (debug only)',
      expect.objectContaining({
        package_id: 'nano-banana',
        workspace_path: '/diag/workspace',
      }),
    );
  });

  it('trims leading/trailing whitespace from workspace value', async () => {
    setWorkspaceEnv({ rebel: '  /user/workspace  ', mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(getConnectTransportOptions().env).toEqual({
      MCP_WORKSPACE_PATH: '/user/workspace',
    });
  });

  it('trims whitespace-only workspace values', async () => {
    setWorkspaceEnv({ rebel: '   ', mcp: undefined });
    const client = createClient();

    await client.connect();

    expect(getConnectTransportOptions().env).toBeUndefined();
  });
});
