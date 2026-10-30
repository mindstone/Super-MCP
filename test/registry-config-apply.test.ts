import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/logging.js', () => {
  const record = (...args: unknown[]) => { loggerCalls.push(args); };
  return { getLogger: () => ({ info: record, warn: record, error: record, debug: record, setLevel: () => {} }) };
});

const constructed = vi.hoisted(() => [] as Array<{
  id: string;
  env?: Record<string, string>;
  close: ReturnType<typeof vi.fn>;
}>);
const callTool = vi.hoisted(() => vi.fn());
vi.mock('../src/clients/stdioClient.js', () => ({
  StdioMcpClient: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(id: string, config: { env?: Record<string, string> }) {
      constructed.push({ id, env: config.env ? { ...config.env } : undefined, close: this.close });
    }
    async connect() {}
    async listTools() { return []; }
    callTool = callTool;
    hasPendingRequests() { return true; }
  },
}));

import { PackageRegistry } from '../src/registry.js';

function initialServers() {
  return {
    Alpha: { command: 'node', args: ['alpha.js'], env: { TOKEN: 'old-token' } },
    Beta: { command: 'node', args: ['beta.js'] },
    Remote: { url: 'https://example.com/mcp' },
  };
}

describe('PackageRegistry.applyConfigFromFiles', () => {
  let dir: string;
  let configPath: string;
  let registry: PackageRegistry;
  const write = async (mcpServers: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers, ...extra }));
  };

  beforeEach(async () => {
    constructed.length = 0;
    loggerCalls.length = 0;
    callTool.mockReset().mockResolvedValue({ content: [] });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-config-apply-'));
    configPath = path.join(dir, 'config.json');
    await write(initialServers());
    registry = await PackageRegistry.fromConfigFiles([configPath]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await registry.closeAll();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('admits an added package while another live client keeps running', async () => {
    const live = await registry.getClient('Alpha');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    callTool.mockImplementationOnce(async () => {
      entered();
      await pending;
      return { content: [{ type: 'text', text: 'finished' }] };
    });
    const reply = live.callTool('wait', {});
    await started;
    try {
      vi.stubEnv('CONFIG_APPLY_TEST_TOKEN', 'initial-value');
      await write({ ...initialServers(), Added: { command: 'node', args: ['added.js'], env: { TOKEN: '${CONFIG_APPLY_TEST_TOKEN}' } } });
      expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: ['Added'], needsReload: [] });
      expect(constructed.map((entry) => entry.id)).toEqual(['Alpha']);
      expect(constructed[0].close).not.toHaveBeenCalled();
      expect(await registry.getClient('Alpha')).toBe(live);
      await (await registry.getClient('Added')).callTool('ping', {});
      expect(constructed[0].close).not.toHaveBeenCalled();
    } finally {
      release();
      await expect(reply).resolves.toEqual({ content: [{ type: 'text', text: 'finished' }] });
    }
    vi.stubEnv('CONFIG_APPLY_TEST_TOKEN', 'rotated-value');
    expect((await registry.restartPackage('Added')).success).toBe(true);
    expect(registry.getPackage('Added')?.args).toEqual(['added.js']);
    // Restart must re-expand the admitted raw entry, rather than retain the
    // already-normalized config when no raw entry was copied.
    expect(registry.getPackage('Added')?.env).toEqual({ TOKEN: 'rotated-value' });
  });

  it('reports a removal without removing the package', async () => {
    const { Beta: _beta, ...remaining } = initialServers();
    const before = registry.getPackage('Beta');
    await write(remaining);
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [{ packageId: 'Beta', reason: 'removed' }] });
    expect(registry.getPackage('Beta')).toBe(before);
  });

  it.each([
    ['command', 'Alpha', { command: 'other-node' }],
    ['URL', 'Remote', { url: 'https://example.org/mcp' }],
    ['auth', 'Remote', { auth: { mode: 'oauth2', method: 'authorization_code_pkce', scopes: ['read'], client_id: 'alpha-client' } }],
    ['setupStatus', 'Alpha', { setupStatus: { state: 'blocked', reason: 'missing_managed_credentials' } }],
    ['command and env', 'Alpha', { command: 'other-node', env: { TOKEN: 'new-token' } }],
  ])('reports a change to %s without applying it', async (_label, id, change) => {
    const servers = initialServers();
    const before = registry.getPackage(id);
    await write({ ...servers, [id]: { ...servers[id as keyof typeof servers], ...change } });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [{ packageId: id, reason: 'changed' }] });
    expect(registry.getPackage(id)).toBe(before);
    await registry.restartPackage(id);
    expect(registry.getPackage(id)).toEqual(before);
  });

  it('reports env-only changes before refreshing the next spawn env', async () => {
    const live = await registry.getClient('Alpha');
    await write({ ...initialServers(), Alpha: { ...initialServers().Alpha, env: { TOKEN: 'new-token' } } });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [{ packageId: 'Alpha', reason: 'env_changed' }] });
    expect(await registry.getClient('Alpha')).toBe(live);
    expect(constructed[0].close).not.toHaveBeenCalled();
    expect(registry.getPackage('Alpha')?.env).toEqual({ TOKEN: 'new-token' });
    await registry.restartPackage('Alpha');
    await registry.getClient('Alpha');
    expect(constructed.at(-1)?.env).toEqual({ TOKEN: 'new-token' });
    expect(JSON.stringify(loggerCalls)).not.toContain('new-token');
  });

  it('copies only the added raw entry when the same write edits an existing package', async () => {
    await write({
      ...initialServers(),
      Alpha: { command: 'other-node', args: ['changed.js'] },
      Added: { command: 'node', args: ['added.js'] },
    });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({
      status: 'ok', added: ['Added'], needsReload: [{ packageId: 'Alpha', reason: 'changed' }],
    });
    await registry.restartPackage('Alpha');
    await registry.restartPackage('Added');
    expect(registry.getPackage('Alpha')?.command).toBe('node');
    expect(registry.getPackage('Alpha')?.args).toEqual(['alpha.js']);
    expect(registry.getPackage('Added')?.args).toEqual(['added.js']);
  });

  it('ignores a disabled addition', async () => {
    await write({ ...initialServers(), Added: { command: 'node' } }, { disabledServers: ['Added'] });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [] });
    expect(registry.getPackage('Added')).toBeUndefined();
  });

  it.each([false, true])('reports an invalid addition alongside valid additions: %s', async (includeValid) => {
    await write({ ...initialServers(), Invalid: { url: 'private-invalid-url' }, ...(includeValid ? { Added: { command: 'node' } } : {}) });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: includeValid ? ['Added'] : [], needsReload: [{ packageId: 'Invalid', reason: 'invalid' }] });
    expect(registry.getPackage('Invalid')).toBeUndefined();
    expect(JSON.stringify(loggerCalls)).not.toContain('private-invalid-url');
  });

  it('does not report a previously skipped invalid package as a new invalid addition', async () => {
    await registry.closeAll();
    await write({ ...initialServers(), Invalid: { command: '' } });
    registry = await PackageRegistry.fromConfigFiles([configPath]);
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [] });
    await write({ ...initialServers(), Invalid: { command: 'node' } });
    await registry.applyConfigFromFiles([configPath]);
    expect(registry.getSkippedPackages()).toEqual([]);
  });

  it('reports a new configPaths reference', async () => {
    await fs.writeFile(path.join(dir, 'extra.json'), '{}');
    await write(initialServers(), { configPaths: ['./extra.json'] });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'ok', added: [], needsReload: [{ reason: 'config_files_changed' }] });
  });

  it.each(['malformed', 'missing'])('keeps cached configs on a %s file, without logging content', async (failure) => {
    const before = registry.getPackage('Alpha');
    if (failure === 'malformed') await fs.writeFile(configPath, '{"mcpServers": "private-parser-content');
    else await fs.unlink(configPath);
    loggerCalls.length = 0;
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'failed' });
    expect(registry.getPackage('Alpha')).toBe(before);
    expect(JSON.stringify(loggerCalls)).not.toContain('private-parser-content');
  });

  it('fails after terminal shutdown', async () => {
    await registry.closeAll();
    await write({ ...initialServers(), Added: { command: 'node' } });
    expect(await registry.applyConfigFromFiles([configPath])).toEqual({ status: 'failed' });
    expect(registry.getPackage('Added')).toBeUndefined();
  });

  it('shares the queue with env refresh', async () => {
    const loader = vi.spyOn(PackageRegistry as any, 'loadMergedConfigFiles');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    loader.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return { mergedConfig: { mcpServers: initialServers() }, loadOrder: [configPath] };
    });
    const first = registry.applyConfigFromFiles([configPath]);
    await started;
    const second = registry.refreshPackageEnvFromConfigFiles([configPath]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('never admits an addition during pre-spawn refresh', async () => {
    await write({ ...initialServers(), Added: { command: 'node' } });
    await registry.getClient('Beta');
    expect(registry.getPackage('Added')).toBeUndefined();
    expect(constructed.map((entry) => entry.id)).toEqual(['Beta']);
  });
});
