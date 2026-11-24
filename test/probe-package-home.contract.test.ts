import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/catalog.js';
import { CatalogRefresher } from '../src/catalogRefresher.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { handleProbePackageHome } from '../src/handlers/probePackageHome.js';
import { PackageRegistry } from '../src/registry.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';
import { startServer } from '../src/server.js';
import type { McpClient, PackageConfig } from '../src/types.js';

const routerIo = vi.hoisted(() => ({ transport: undefined as InMemoryTransport | undefined }));
const logger = vi.hoisted(() => ({ setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
// Replace process I/O only: both router and connector use real SDK protocols.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      if (!routerIo.transport) throw new Error('Install the in-memory router transport first');
      return routerIo.transport;
    }
  },
}));
vi.mock('../src/configWatcher.js', () => ({ ConfigWatcher: class { async start() {} async stop() {} } }));

const ID = 'Notes-work';
// The probe's answer shapes, shared with Rebel Core's wait (cloudConnectorWait.test.ts).
const probeAnswer = JSON.parse(readFileSync(new URL('./fixtures/probe-answer-v1.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, unknown>>;
const config: PackageConfig = {
  id: ID, name: 'Fictional Notes', transport: 'http',
  base_url: 'https://notes.example.test/mcp', visibility: 'default',
};
const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const, properties: {} } });
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const cleanup: Array<() => Promise<unknown>> = [];
const toolNames = (catalog: Catalog) => catalog.getPackageTools(ID).map(entry => entry.tool.name);
const unhealthy = (wrapper: PackageHomeClient) => { (wrapper as unknown as { connected: boolean }).connected = false; };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function connector() {
  const server = new Server({ name: 'contract-connector', version: '1' }, { capabilities: { tools: {} } });
  const listings: Array<() => Promise<ReturnType<typeof tool>[]>> = [];
  const received: string[] = [];
  const slowEntered = deferred<void>();
  const slowAnswer = deferred<void>();
  let listCount = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    listCount++;
    return { tools: await (listings.shift()?.() ?? Promise.resolve([tool('read_item')])) };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    received.push(request.params.name);
    if (request.params.name === 'slow_read') {
      slowEntered.resolve();
      await slowAnswer.promise;
    }
    return answer(request.params.name);
  });
  const wrapper = new PackageHomeClient(config, { url: 'https://cloud.example.test/mcp' });
  const sdk = (wrapper as unknown as { client: Client }).client;
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await sdk.connect(left);
  // Substitute the network connection, retaining the real wrapper's request,
  // queue, health and close behavior. Never replace close with a no-op: SDK
  // close must reject requests already written to this connector.
  (wrapper as unknown as { connected: boolean }).connected = true;
  const close = vi.spyOn(wrapper, 'close');
  cleanup.push(() => server.close(), () => wrapper.close());
  return { wrapper, sdk, left, close, listings, received, slowEntered, slowAnswer, listCount: () => listCount };
}

/** `clients: 'real'` lets the registry build its own home client, for a test that stubs `fetch`. */
function fixture(clients: McpClient[] | 'real', now?: () => number) {
  const registry = new PackageRegistry({ mcpServers: {}, packageHomes: { [ID]: { url: 'https://cloud.example.test/mcp' } } });
  (registry as unknown as { packages: PackageConfig[] }).packages = [config];
  const create = vi.spyOn(registry as unknown as { createAndConnectClient(): Promise<McpClient> }, 'createAndConnectClient');
  if (clients !== 'real') {
    for (const client of clients) create.mockResolvedValueOnce(client);
    // Unexpected reconnects fail at the construction boundary; never use a socket.
    create.mockRejectedValue(new Error('Unexpected client construction'));
  }
  const catalog = new Catalog(registry);
  const refresher = new CatalogRefresher(catalog, registry, { random: () => 0.5, now });
  cleanup.push(() => registry.closeAll(), () => refresher.dispose());
  const probe = async (signal?: AbortSignal) => {
    const result = await handleProbePackageHome({ package_id: ID }, registry, refresher, signal);
    expect(result.isError).toBe(false);
    return JSON.parse(result.content[0].text);
  };
  return { registry, catalog, refresher, create, probe };
}

beforeEach(() => { vi.clearAllMocks(); setSecurityPolicy(new SecurityPolicy()); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); routerIo.transport = undefined; }
});

describe('probe contracts through real SDK clients', () => {
  it('a held listing does not hold a second call, and later unhealthy probes preserve the first call answer', async () => {
    const old = await connector();
    const next = await connector();
    const { registry, probe, create } = fixture([old.wrapper, next.wrapper]);
    const entered = deferred<void>();
    const release = deferred<void>();
    old.listings.push(async () => { entered.resolve(); await release.promise; return [tool('read_item')]; });
    const first = registry.callTool(ID, 'slow_read', {}, { kind: 'standalone' })
      .then(value => ({ value }), error => ({ error }));
    let pending: Promise<unknown> | undefined;
    try {
      await old.slowEntered.promise;
      pending = probe();
      await entered.promise;
      // This must finish while both the first call and the probe are still held.
      await expect(registry.callTool(ID, 'fast_read', {}, { kind: 'standalone' }))
        .resolves.toEqual(answer('fast_read'));
      expect(old.received).toEqual(['slow_read', 'fast_read']);
      release.resolve();
      expect(await pending).toMatchObject({ status: 'ready' });

      // A session-loss response makes the real home wrapper unhealthy without
      // closing the SDK, while slow_read still has its request on the wire.
      const send = old.left.send.bind(old.left);
      vi.spyOn(old.left, 'send').mockImplementationOnce(async message => {
        if ('method' in message && message.method === 'tools/list') throw new StreamableHTTPError(404, 'Session not found');
        return send(message);
      });
      await expect(old.wrapper.listTools()).rejects.toBeInstanceOf(StreamableHTTPError);
      const probes = [];
      for (let i = 0; i < 5; i++) probes.push(await probe());
      old.slowAnswer.resolve();
      expect(await first).toEqual({ value: answer('slow_read') });
      expect(old.close).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(probes).toEqual(Array.from({ length: 5 }, () => ({ status: 'not_ready', reason: 'client_busy' })));
    } finally {
      release.resolve(); old.slowAnswer.resolve();
      await Promise.allSettled([first, ...(pending ? [pending] : [])]);
    }
  });

  it('a forced refresh asked during a probe waits for it, then forces its reconnect and has the last word', async () => {
    const old = await connector();
    const next = await connector();
    const { catalog, refresher, probe, create } = fixture([old.wrapper, next.wrapper]);
    refresher.start();
    await refresher.refreshNow(ID);
    expect(toolNames(catalog)).toEqual(['read_item']);
    const entered = deferred<void>();
    const release = deferred<void>();
    let closesDuringProbe: number | undefined;
    old.listings.push(async () => {
      entered.resolve(); await release.promise;
      closesDuringProbe = old.close.mock.calls.length;
      return [tool('old_schema')];
    });
    next.listings.push(async () => [tool('new_schema')]);
    const probing = probe();
    let forced: Promise<void> | undefined;
    try {
      await entered.promise;
      // As restart_package asks. It is queued behind the probe's slot, not run beside it.
      forced = refresher.refreshNow(ID, { reason: 'restart' });
      release.resolve();
      expect(await probing).toMatchObject({ status: 'ready' });
      await forced;
      expect(closesDuringProbe).toBe(0);
      expect(old.close).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(2);
      expect(toolNames(catalog)).toEqual(['new_schema']);
    } finally {
      release.resolve();
      await Promise.allSettled([probing, ...(forced ? [forced] : [])]);
    }
  });

  it('a probe during an ordinary refresh answers refresh_in_progress at once and leaves that refresh alone', async () => {
    const peer = await connector();
    const { catalog, refresher, probe } = fixture([peer.wrapper]);
    const entered = deferred<void>();
    const release = deferred<void>();
    peer.listings.push(async () => { entered.resolve(); await release.promise; return [tool('read_item')]; });
    refresher.start();
    try {
      await entered.promise;
      expect(await probe()).toEqual(probeAnswer.notReadyRefreshInProgress);
      expect(peer.listCount()).toBe(1);
      expect(catalog.getRefreshInFlight(ID)).toBe(true);
      release.resolve();
      await refresher.refreshNow(ID);
      expect(catalog.getPackageStatus(ID)).toBe('ready');
      expect(peer.listCount()).toBe(1);
    } finally { release.resolve(); }
  });

  it('a call that brings in a new client while the probe closes the old one keeps it, and the probe answers client_busy', async () => {
    const old = await connector();
    const next = await connector();
    const { registry, probe, create } = fixture([old.wrapper, next.wrapper]);
    await registry.getClient(ID);
    unhealthy(old.wrapper);
    const closing = deferred<void>();
    const closed = deferred<void>();
    old.close.mockImplementationOnce(async () => { closing.resolve(); await closed.promise; });
    const probing = probe();
    let call: Promise<unknown> | undefined;
    try {
      await closing.promise;
      call = registry.callTool(ID, 'slow_read', {}, { kind: 'standalone' }).then(value => ({ value }), error => ({ error }));
      await next.slowEntered.promise;
      unhealthy(next.wrapper);
      closed.resolve();
      expect(await probing).toEqual({ status: 'not_ready', reason: 'client_busy' });
      expect(next.close).not.toHaveBeenCalled();
      next.slowAnswer.resolve();
      expect(await call).toEqual({ value: answer('slow_read') });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      closed.resolve(); next.slowAnswer.resolve();
      await Promise.allSettled([probing, ...(call ? [call] : [])]);
    }
  });

  it('a probe and a call racing an unhealthy idle client close it once and send only to its replacement', async () => {
    const old = await connector();
    const next = await connector();
    const { registry, probe, create } = fixture([old.wrapper, next.wrapper]);
    await registry.getClient(ID);
    // This is an actual HTTP-session failure at the transport boundary.
    vi.spyOn(old.left, 'send').mockRejectedValueOnce(new StreamableHTTPError(404, 'Session not found'));
    await expect(old.wrapper.listTools()).rejects.toBeInstanceOf(StreamableHTTPError);
    const entered = deferred<void>();
    const release = deferred<void>();
    const health = old.wrapper.healthCheck.bind(old.wrapper);
    vi.spyOn(old.wrapper, 'healthCheck').mockImplementationOnce(async () => {
      const result = await health();
      entered.resolve();
      await release.promise;
      return result;
    });
    const probing = probe();
    try {
      await entered.promise;
      await expect(registry.callTool(ID, 'read_item', {}, { kind: 'standalone' }))
        .resolves.toEqual(answer('read_item'));
      release.resolve();
      expect(await probing).toMatchObject({ status: 'ready' });
      expect(old.close).toHaveBeenCalledTimes(1);
      expect(old.received).toEqual([]);
      expect(next.received).toEqual(['read_item']);
      expect(create).toHaveBeenCalledTimes(2);
    } finally { release.resolve(); await Promise.allSettled([probing]); }
  });

  it('a cloud 401 on the listing answers not_ready and leaves the catalog as the ordinary refresh left it', async () => {
    // The real home client over a stubbed fetch: the cloud accepts the session, then refuses every listing.
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      if (rpc.method !== 'initialize') return new Response('Unauthorized', { status: 401 });
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fictional-cloud', version: '1' },
      } }, { headers: { 'mcp-session-id': 'session-1' } });
    }));
    const now = Date.now();
    const { catalog, refresher, probe } = fixture('real', () => now);
    refresher.start();
    await refresher.refreshNow(ID);
    const state = () => ({ ...catalog.getPackageDiagnostics(ID), retry: catalog.getRetryHint(ID, now), tools: toolNames(catalog) });
    const before = state();
    expect(before.status).toBe('error');
    for (let i = 0; i < 3; i++) {
      expect(await probe()).toEqual({ status: 'not_ready', reason: 'list_failed' });
      expect(state()).toEqual(before);
    }
  });

  it('a probe racing shutdown cannot construct a connector', async () => {
    const { registry, refresher, create } = fixture([]);
    const closing = registry.closeAll();
    const result = await handleProbePackageHome({ package_id: ID }, registry, refresher);
    await closing;
    expect(create).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'not_ready', reason: 'connect_failed' });
  });

  it('the SDK host sees the unchanged router tool list and receives unknown-package probes as error results', async () => {
    const { registry } = fixture([]);
    // No connector is needed for listing the router or validating an unknown id.
    (registry as unknown as { packages: PackageConfig[] }).packages = [];
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    routerIo.transport = routerSide;
    vi.spyOn(PackageRegistry, 'fromConfigFiles').mockResolvedValue(registry);
    vi.spyOn(registry, 'startIdleReaper').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockReturnValue(process);
    const connect = Server.prototype.connect;
    vi.spyOn(Server.prototype, 'connect').mockImplementation(async function (transport) {
      if (transport === routerSide) cleanup.push(() => this.close());
      return connect.call(this, transport);
    });
    const start = CatalogRefresher.prototype.start;
    vi.spyOn(CatalogRefresher.prototype, 'start').mockImplementation(function () {
      cleanup.push(() => this.dispose());
      return start.call(this);
    });
    await startServer({ configPaths: [], transport: 'stdio' });
    const host = new Client({ name: 'contract-host', version: '1' });
    await host.connect(hostSide);
    cleanup.push(() => host.close());
    expect((await host.listTools()).tools.map(entry => entry.name)).toEqual([
      'list_tool_packages', 'list_tools', 'get_tool_details', 'use_tool', 'bulk_export', 'get_help',
      'health_check_all', 'health_check', 'authenticate', 'restart_package', 'record_tool_note', 'search_tools',
    ]);
    // A protocol error rejects callTool; this must resolve to an MCP error result.
    const result = await host.callTool({ name: 'probe_package_home', arguments: { package_id: 'Unknown-work' } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toMatchObject({ success: false });
    expect(content[0].text).toContain('Unknown-work');
  });
});
