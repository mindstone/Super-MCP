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
vi.mock('../src/clients/stdioClient.js', () => {
  class FakeStdioMcpClient {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(id: string, config: { env?: Record<string, string>; args?: string[] }) {
      constructed.push({ id, env: config.env ? { ...config.env } : undefined, args: config.args, client: this as any });
    }
    async connect(): Promise<void> {}
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
    loggerCalls.length = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-env-refresh-'));
    configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, configWith());
    registry = await PackageRegistry.fromConfigFiles([configPath]);
  });

  afterEach(async () => {
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

  it('seam: rotate, persist, watcher fires, reap, respawn sees the new token', async () => {
    await registry.getClient('QuickBooks');
    const refreshed = new Promise<void>((resolve) => {
      const catalogRefresher = { configurationChanged: () => resolve() };
      // The same handler server.ts wires to the watcher.
      const watcher = new ConfigWatcher([configPath], () =>
        handleConfigurationChange(registry, catalogRefresher, [configPath]),
      );
      // Persist the rotated token, then fire the watcher's change path
      // (debounce, security reload, then the change callback).
      void fs
        .writeFile(configPath, configWith({ qbEnv: { QUICKBOOKS_REFRESH_TOKEN: NEW_TOKEN, QUICKBOOKS_REALM: 'r1' } }))
        .then(() => (watcher as any).scheduleReload());
    });
    await refreshed;

    expect(spawnsOf('QuickBooks')[0].client.close).not.toHaveBeenCalled();
    reapIdle(registry);
    await registry.getClient('QuickBooks');
    expect(spawnsOf('QuickBooks')).toHaveLength(2);
    expect(spawnsOf('QuickBooks')[1].env?.QUICKBOOKS_REFRESH_TOKEN).toBe(NEW_TOKEN);
  });
});
