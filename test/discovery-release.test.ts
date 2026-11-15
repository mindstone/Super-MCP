/**
 * Catalog discovery stops each stdio server it started once its tools are
 * listed, so a router start no longer leaves every connector running until
 * the idle reaper (Rebel FOX-8354).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: () => {} }),
}));

const servers = vi.hoisted(() => ({
  live: new Set<object>(),
  peak: 0,
  spawned: [] as string[],
  holdConnect: new Map<string, Promise<void>>(),
  holdListTools: new Map<string, Promise<void>>(),
  closeDelayMs: 0,
}));
vi.mock('../src/clients/stdioClient.js', () => {
  class FakeStdioMcpClient {
    constructor(private readonly id: string) {
      servers.spawned.push(id);
    }
    async connect(): Promise<void> {
      await servers.holdConnect.get(this.id);
      servers.live.add(this);
      servers.peak = Math.max(servers.peak, servers.live.size);
    }
    async listTools(): Promise<unknown[]> {
      await servers.holdListTools.get(this.id);
      return [{ name: `${this.id}_tool`, inputSchema: { type: 'object' } }];
    }
    async callTool(): Promise<unknown> {
      return { content: [] };
    }
    hasPendingRequests(): boolean {
      return false;
    }
    async close(): Promise<void> {
      // A server counts as live until its close finishes.
      await new Promise((resolve) => setTimeout(resolve, servers.closeDelayMs));
      servers.live.delete(this);
    }
  }
  return { StdioMcpClient: FakeStdioMcpClient };
});

import { PackageRegistry } from '../src/registry.js';
import { Catalog } from '../src/catalog.js';
import { CatalogRefresher } from '../src/catalogRefresher.js';

const SERVER_COUNT = 12;
const DISCOVERY_LIMIT = 5; // the refresher's default concurrency

let tmpDir: string;
let registry: PackageRegistry;
let refresher: CatalogRefresher;

async function loadRegistry(): Promise<void> {
  const mcpServers: Record<string, unknown> = {};
  for (let i = 0; i < SERVER_COUNT; i += 1) mcpServers[`server-${i}`] = { command: 'node', args: [`s${i}.js`] };
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }));
  registry = await PackageRegistry.fromConfigFiles([configPath]);
}

async function startRouter(): Promise<Catalog> {
  await loadRegistry();
  const catalog = new Catalog(registry);
  refresher = new CatalogRefresher(catalog, registry);
  refresher.start();
  return catalog;
}

describe('catalog discovery releases the servers it started', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-discovery-'));
    servers.live.clear();
    servers.peak = 0;
    servers.spawned.length = 0;
    servers.holdConnect.clear();
    servers.holdListTools.clear();
    servers.closeDelayMs = 0;
  });

  afterEach(async () => {
    await refresher?.dispose();
    refresher = undefined as unknown as CatalogRefresher;
    await registry?.closeAll?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('leaves no discovery-only server running and never more than the discovery limit at once', async () => {
    const catalog = await startRouter();
    await refresher.whenCurrentGenerationReady();

    expect(servers.spawned).toHaveLength(SERVER_COUNT);
    // The catalog is ready at the last commit; that server's close finishes just after.
    await vi.waitFor(() => expect(servers.live.size).toBe(0));
    expect(servers.peak).toBeLessThanOrEqual(DISCOVERY_LIMIT);
    expect(catalog.isSnapshotComplete()).toBe(true);
  });

  it('stays within the discovery limit while closes take time', async () => {
    servers.closeDelayMs = 20;
    await startRouter();
    await refresher.whenCurrentGenerationReady();

    await vi.waitFor(() => expect(servers.live.size).toBe(0));
    expect(servers.peak).toBeLessThanOrEqual(DISCOVERY_LIMIT);
  });

  it('keeps a server that something asked for while discovery was still starting it', async () => {
    let release!: () => void;
    servers.holdConnect.set('server-0', new Promise<void>((resolve) => { release = resolve; }));
    await startRouter();
    await vi.waitFor(() => expect(servers.spawned).toContain('server-0'));

    const claimed = registry.getClient('server-0');
    release();
    await claimed;
    await refresher.whenCurrentGenerationReady();

    expect(servers.live.size).toBe(1);
  });

  it('stops a server that discovery started on an earlier attempt once a retry lists it', async () => {
    await loadRegistry();
    expect((await registry.connectForCatalog('server-1')).kind).toBe('connected');
    // The first listing failed, so nothing released it; the retry reuses the running server.
    expect((await registry.connectForCatalog('server-1')).kind).toBe('connected');
    await registry.releaseAfterDiscovery('server-1');

    expect(servers.spawned).toEqual(['server-1']);
    expect(servers.live.size).toBe(0);
  });

  it('keeps a server that something asked for during discovery', async () => {
    let release!: () => void;
    servers.holdListTools.set('server-0', new Promise<void>((resolve) => { release = resolve; }));
    await startRouter();
    await vi.waitFor(() => expect(servers.spawned).toContain('server-0'));

    await registry.getClient('server-0');
    release();
    await refresher.whenCurrentGenerationReady();

    expect(servers.live.size).toBe(1);
  });

  it('starts a server again for a call after discovery, and keeps it', async () => {
    await startRouter();
    await refresher.whenCurrentGenerationReady();

    await registry.getClient('server-3');

    expect(servers.spawned.filter((id) => id === 'server-3')).toHaveLength(2);
    expect(servers.live.size).toBe(1);
  });
});
