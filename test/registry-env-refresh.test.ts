/**
 * A config change refreshes the cached env of stdio packages for their next
 * spawn only (Rebel plan 260924_wise-configure-route, Stage 5, review F6).
 *
 * The host persists a rotated OAuth refresh token into a connector's env in
 * the MCP config file. Without this, the registry kept the env it read at
 * startup, so after an idle reap the child respawned with the old token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { once } from 'node:events';
import type { FSWatcher } from 'chokidar';

const loggerCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/logging.js', () => {
  const record = (...args: unknown[]) => {
    loggerCalls.push(args);
  };
  return {
    getLogger: () => ({ info: record, warn: record, error: record, debug: record, setLevel: () => {} }),
  };
});

type Constructed = {
  id: string;
  env: Record<string, string> | undefined;
  args: string[] | undefined;
  client: { close: ReturnType<typeof vi.fn> };
};
const constructed = vi.hoisted(() => [] as Constructed[]);
const connectAttempt = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../src/clients/stdioClient.js', () => {
  class FakeStdioMcpClient {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(id: string, config: { env?: Record<string, string>; args?: string[] }) {
      constructed.push({ id, env: config.env ? { ...config.env } : undefined, args: config.args, client: this as any });
    }
    async connect(): Promise<void> { await connectAttempt(); }
    async listTools(): Promise<unknown[]> {
      return [];
    }
    async callTool(): Promise<unknown> {
      return { content: [] };
    }
    hasPendingRequests(): boolean {
      return false;
    }
  }
  return { StdioMcpClient: FakeStdioMcpClient };
});

import { PackageRegistry } from '../src/registry.js';
import { ConfigWatcher, handleConfigurationChange } from '../src/configWatcher.js';

const OLD_TOKEN = 'old-refresh-token-value';
const NEW_TOKEN = 'new-refresh-token-value';

function configWith(overrides: {
  qbEnv?: Record<string, string>;
  qbArgs?: string[];
  extraServers?: Record<string, unknown>;
  dropOther?: boolean;
} = {}): string {
  const mcpServers: Record<string, unknown> = {
    QuickBooks: {
      command: 'node',
      args: overrides.qbArgs ?? ['qb.js'],
      env: overrides.qbEnv ?? { QUICKBOOKS_REFRESH_TOKEN: OLD_TOKEN, QUICKBOOKS_REALM: 'r1' },
      catalogId: 'quickbooks',
    },
    ...(overrides.dropOther ? {} : { Other: { command: 'node', args: ['other.js'], env: { A: '1' } } }),
    Remote: { url: 'https://example.com/mcp' },
    ...(overrides.extraServers ?? {}),
  };
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Close idle stdio clients the way the idle reaper does. */
function reapIdle(registry: PackageRegistry): void {
  const lastActivity = (registry as any).lastActivity as Map<string, number>;
  for (const id of lastActivity.keys()) lastActivity.set(id, 0);
  (registry as any).sweepIdleClients();
}

function spawnsOf(id: string): Constructed[] {
  return constructed.filter((c) => c.id === id);
}

describe('PackageRegistry.refreshPackageEnvFromConfigFiles', () => {
  let dir: string;
  let configPath: string;
  let registry: PackageRegistry;

  beforeEach(async () => {
    constructed.length = 0;
    connectAttempt.mockReset().mockResolvedValue(undefined);
    loggerCalls.length = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-env-refresh-'));
    configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, configWith());
    registry = await PackageRegistry.fromConfigFiles([configPath]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.closeAll().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives the next spawn the new env, without touching the live client', async () => {
    const live = await registry.getClient('QuickBooks');
    expect(spawnsOf('QuickBooks')).toHaveLength(1);
    expect(spawnsOf('QuickBooks')[0].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
    const otherBefore = registry.getPackage('Other');
    const remoteBefore = registry.getPackage('Remote');

    await fs.writeFile(
      configPath,
      configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN, QUICKBOOKS_REALM: 'r1' } }),
    );
    const result = await registry.refreshPackageEnvFromConfigFiles([configPath]);

    expect(result).toEqual({
      status: 'ok',
      updated: [{ packageId: 'QuickBooks', changedKeys: ['QUICKBOOKS_REFRESH_TOKEN'] }],
      notApplied: [],
    });
    // The live client is neither closed nor replaced.
    expect(spawnsOf('QuickBooks')[0].client.close).not.toHaveBeenCalled();
    expect(await registry.getClient('QuickBooks')).toBe(live);
    expect(spawnsOf('QuickBooks')).toHaveLength(1);
    // Unchanged packages keep their cached config object.
    expect(registry.getPackage('Other')).toBe(otherBefore);
    expect(registry.getPackage('Remote')).toBe(remoteBefore);

    // Idle reap, then respawn: the new child gets the new token.
    reapIdle(registry);
    expect(spawnsOf('QuickBooks')[0].client.close).toHaveBeenCalledOnce();
    await registry.getClient('QuickBooks');
    expect(spawnsOf('QuickBooks')).toHaveLength(2);
    expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
    expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REALM).toBe('r1');

    // A later restartPackage re-normalises from the raw config: it must not
    // bring the old token back.
    await registry.restartPackage('QuickBooks');
    expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
  });

  it('never logs env values', async () => {
    await fs.writeFile(
      configPath,
      configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN, QUICKBOOKS_REALM: 'r1' } }),
    );
    await registry.refreshPackageEnvFromConfigFiles([configPath]);
    const logged = JSON.stringify(loggerCalls);
    expect(logged).toContain('QUICKBOOKS_REFRESH_TOKEN');
    expect(logged).not.toContain(NEW_TOKEN);
    expect(logged).not.toContain(OLD_TOKEN);
  });

  it('redacts normalization and validation diagnostics during refresh without changing validation', async () => {
    const config = JSON.parse(configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: '${s5-secret-value}' } }));
    config.mcpServers.Remote.url = 's5-private-invalid-url';
    await fs.writeFile(configPath, JSON.stringify(config));
    loggerCalls.length = 0;

    await registry.refreshPackageEnvFromConfigFiles([configPath]);

    expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe('${s5-secret-value}');
    expect(registry.getPackage('Remote')?.base_url).toBe('https://example.com/mcp');
    const logged = JSON.stringify(loggerCalls);
    expect(logged).not.toContain('s5-secret-value');
    expect(logged).not.toContain('s5-private-invalid-url');
    expect(logged).toContain('invalid field');
  });

  it('refreshes before an immediate respawn without waiting for watcher debounce, sharing one spawn', async () => {
    await registry.getClient('QuickBooks');
    await fs.writeFile(`${configPath}.tmp`, configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN } }));
    await fs.rename(`${configPath}.tmp`, configPath);
    reapIdle(registry);

    const [first, second] = await Promise.all([registry.getClient('QuickBooks'), registry.getClient('QuickBooks')]);

    expect(first).toBe(second);
    expect(spawnsOf('QuickBooks')).toHaveLength(2);
    expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
  });

  it('does not replace or mutate an in-progress spawn when env refreshes', async () => {
    let finishConnect!: () => void;
    connectAttempt.mockImplementationOnce(() => new Promise<void>((resolve) => { finishConnect = resolve; }));
    const connecting = registry.getClient('QuickBooks');
    await vi.waitFor(() => expect(spawnsOf('QuickBooks')).toHaveLength(1));
    try {
      await fs.writeFile(configPath, configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN } }));
      await registry.refreshPackageEnvFromConfigFiles([configPath]);
      expect(spawnsOf('QuickBooks')[0].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
      expect(spawnsOf('QuickBooks')[0].client.close).not.toHaveBeenCalled();
      const concurrent = registry.getClient('QuickBooks');
      finishConnect();
      expect(await concurrent).toBe(await connecting);
      reapIdle(registry);
      await registry.getClient('QuickBooks');
      expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
    } finally {
      finishConnect();
      await connecting;
    }
  });

  it('refreshes a token persisted during a failed connect before the retry spawn', async () => {
    connectAttempt.mockImplementationOnce(async () => {
      await fs.writeFile(configPath, configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN } }));
      throw new Error('temporary connection failure');
    });

    await registry.getClient('QuickBooks');

    expect(spawnsOf('QuickBooks')).toHaveLength(2);
    expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
  });

  it('serializes overlapping refreshes so an older snapshot cannot win last', async () => {
    const loader = vi.spyOn(PackageRegistry as any, 'loadMergedConfigFiles');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    loader.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return { mergedConfig: JSON.parse(configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: 'intermediate-token' } })), loadOrder: [] };
    });
    loader.mockResolvedValueOnce({ mergedConfig: JSON.parse(configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN } })), loadOrder: [] });
    const first = registry.refreshPackageEnvFromConfigFiles([configPath]);
    await started;
    const second = registry.refreshPackageEnvFromConfigFiles([configPath]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
  });

  it('does not apply a command/args change, nor add or remove packages', async () => {
    await fs.writeFile(
      configPath,
      configWith({
        qbArgs: ['qb-v2.js'],
        qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN, QUICKBOOKS_REALM: 'r1' },
        extraServers: { Added: { command: 'node', args: ['added.js'] } },
        dropOther: true,
      }),
    );
    const result = await registry.refreshPackageEnvFromConfigFiles([configPath]);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.updated).toEqual([]);
    expect(result.notApplied).toEqual(
      expect.arrayContaining([
        { packageId: 'QuickBooks', reason: 'identity_changed' },
        { packageId: 'Other', reason: 'removed' },
        { packageId: 'Added', reason: 'added' },
      ]),
    );
    const qb = registry.getPackage('QuickBooks');
    expect(qb?.args).toEqual(['qb.js']);
    expect(qb?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
    expect(registry.getPackage('Other')).toBeDefined();
    expect(registry.getPackage('Added')).toBeUndefined();

    // restartPackage must not pick the unapplied change up either.
    await registry.restartPackage('QuickBooks');
    expect(registry.getPackage('QuickBooks')?.args).toEqual(['qb.js']);
  });

  it('keeps the cached configs when the changed config cannot be read', async () => {
    await registry.getClient('QuickBooks');
    await fs.writeFile(configPath, '{ "mcpServers": { not json');

    const result = await registry.refreshPackageEnvFromConfigFiles([configPath]);

    expect(result.status).toBe('failed');
    expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
    expect(spawnsOf('QuickBooks')[0].client.close).not.toHaveBeenCalled();

    await fs.rm(configPath);
    const missing = await registry.refreshPackageEnvFromConfigFiles([configPath]);
    expect(missing.status).toBe('failed');
    expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
  });

  it('real watcher survives two atomic replacements; reap and respawn use each new token', async () => {
    await registry.getClient('QuickBooks');
    const catalogRefresher = { configurationChanged: vi.fn() };
    const watcher = new ConfigWatcher([configPath], () =>
      handleConfigurationChange(registry, catalogRefresher, [configPath]),
    );
    try {
      await watcher.start();
      await once((watcher as unknown as { watcher: FSWatcher }).watcher, 'ready');
      for (const token of [NEW_TOKEN, 'second-rotated-refresh-token']) {
        const live = spawnsOf('QuickBooks').at(-1)!;
        catalogRefresher.configurationChanged.mockClear();
        await fs.writeFile(`${configPath}.tmp`, configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: token } }));
        await fs.rename(`${configPath}.tmp`, configPath);
        await vi.waitFor(() => {
          expect(catalogRefresher.configurationChanged).toHaveBeenCalled();
          expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(token);
        }, { timeout: 5000 });
        expect(live.client.close).not.toHaveBeenCalled();
        reapIdle(registry);
        await registry.getClient('QuickBooks');
        expect(spawnsOf('QuickBooks').at(-1)?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(token);
      }
      expect(spawnsOf('QuickBooks')).toHaveLength(3);
    } finally {
      await watcher.stop();
    }
  }, 15000);

  it('keeps cached env and never logs credential text from malformed JSON, including the watcher', async () => {
    // Short invalid JSON forces V8 to quote source text in its parser error.
    const secret = 's5-secret-value';
    await fs.writeFile(configPath, `{"x":${secret}}`);
    const catalogRefresher = { configurationChanged: vi.fn() };
    const watcher = new ConfigWatcher([configPath], () =>
      handleConfigurationChange(registry, catalogRefresher, [configPath]),
    );
    try {
      (watcher as any).scheduleReload();
      await vi.waitFor(() => expect(catalogRefresher.configurationChanged).toHaveBeenCalled(), { timeout: 3000 });
      expect(registry.getPackage('QuickBooks')?.env?.QUICKBOOKS_REFRESH_TOKEN).toBe(OLD_TOKEN);
      expect(JSON.stringify(loggerCalls)).not.toContain(secret);
      expect(JSON.stringify(loggerCalls)).toContain('keeping cached configs');
      await handleConfigurationChange(
        { refreshPackageEnvFromConfigFiles: async () => { throw new Error(secret); } },
        catalogRefresher,
        [configPath],
      );
      expect(JSON.stringify(loggerCalls)).not.toContain(secret);
    } finally {
      await watcher.stop();
    }
  });
});
