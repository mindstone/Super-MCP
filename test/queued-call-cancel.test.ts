import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type PQueue from 'p-queue';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { CONNECTOR_WAIT_META } from '../src/clients/requestQueueProgress.js';
import { captureToolDispatch, type ToolDispatchContext } from '../src/fileReadProtocol.js';
import { preflightLocalTool } from '../src/fileReadPreflight.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { Validator } from '../src/validator.js';
import type { PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// Once its caller has stopped or timed out, a call still waiting for a
// connector slot must never reach the connector. Stop also reaches a running child request.

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tool = { name: 'write', inputSchema: { type: 'object' as const, properties: { label: { type: 'string' } } } };

/** A connector whose every slot is held by a running call, so the next call has to queue. */
async function busyConnector(transport: 'stdio' | 'http', { registered = false } = {}) {
  const config: PackageConfig = transport === 'stdio'
    ? { id: 'acme', name: 'Acme', transport, visibility: 'default', command: 'unused', cwd: '/connector' }
    : { id: 'acme', name: 'Acme', transport, visibility: 'default', base_url: 'https://connector.example/mcp' };
  const connector = new Server({ name: 'acme', version: '1' }, { capabilities: { tools: {} } });
  const sent: string[] = [];
  const cancelled: string[] = [];
  const progress = new Map<string, (value?: number) => Promise<void>>();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  connector.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
  connector.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const label = String(params.arguments?.label);
    sent.push(label);
    progress.set(label, (value = 1) => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: params._meta!.progressToken!, progress: value } }));
    extra.signal.addEventListener('abort', () => cancelled.push(label), { once: true });
    if (label.startsWith('running')) await held;
    return { content: [{ type: 'text', text: label }] };
  });
  const local = transport === 'stdio' ? new StdioMcpClient('acme', config) : new HttpMcpClient('acme', config);
  const internals = local as unknown as { client: Client; requestQueue: PQueue; isConnected: boolean };
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([connector.connect(left), internals.client.connect(right)]);
  internals.isConnected = true;
  if (local instanceof StdioMcpClient) vi.spyOn(local, 'isTransportClosed').mockReturnValue(false);
  const registry = new PackageRegistry({ mcpServers: { acme: transport === 'stdio'
    ? { command: 'unused', cwd: '/connector' } : { url: 'https://connector.example/mcp' } } });
  // `registered` keeps the registry's own client lookup, health check included, as a real call meets it.
  if (registered) (registry as unknown as { clients: Map<string, unknown> }).clients.set('acme', local);
  else vi.spyOn(registry, 'getClient').mockResolvedValue(local);
  cleanup.push(() => connector.close(), () => internals.client.close(), () => registry.closeAll());
  return { registry, sent, cancelled, release, internals, progress, connector, local, config };
}

/** Fills every connector slot through `call`, then waits until each running call has reached the connector. */
async function fillSlots(fixture: Awaited<ReturnType<typeof busyConnector>>, call: (label: string) => Promise<unknown>) {
  const slots = fixture.internals.requestQueue.concurrency;
  const running = Array.from({ length: slots }, (_, i) => call(`running-${i}`));
  await vi.waitFor(() => expect(fixture.sent).toHaveLength(slots));
  return running;
}

async function waitingInQueue(fixture: Awaited<ReturnType<typeof busyConnector>>) {
  await vi.waitFor(() => expect(fixture.internals.requestQueue.size).toBe(1));
}

/** Serves `registry` as a package home reached over streamable HTTP. */
function packageHome(registry: PackageRegistry) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().json() : undefined;
    let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (body?.method === 'initialize') {
      const server = createPackageServer(registry, 'acme');
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await server.connect(transport);
      cleanup.push(() => server.close());
    }
    if (!transport) return new Response('Session not found', { status: 404 });
    const response = await transport.handleRequest(request);
    const id = response.headers.get('mcp-session-id');
    if (id) sessions.set(id, transport);
    return response;
  });
  const other = new PackageRegistry({
    mcpServers: { acme: { command: '/must-never-run' } },
    packageHomes: { acme: { url: 'https://cloud.example.test/mcp/packages/acme', headers: {} } },
  });
  cleanup.push(() => other.closeAll());
  return other;
}

describe.each([
  ['stdio', 'directly'], ['http', 'directly'], ['stdio', 'through its package home'], ['http', 'through its package home'],
] as const)('%s connector reached %s: a queued call whose caller has gone', (transport, route) => {
  async function throughPackageEndpoint() {
    const fixture = await busyConnector(transport);
    const entry = route === 'directly' ? fixture.registry : packageHome(fixture.registry);
    const router = createPackageServer(entry, 'acme');
    const host = new Client({ name: 'host', version: '1' });
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
    cleanup.push(() => router.close(), () => host.close());
    const call = (label: string, options?: { signal?: AbortSignal; timeout?: number; onprogress?: (progress: { progress: number; message?: string }) => void; resetTimeoutOnProgress?: boolean }) =>
      host.callTool({ name: 'write', arguments: { label } }, undefined, options);
    return { ...fixture, call };
  }

  it.each([true, false])('renews a waiting call only on real queue movement (running progress: %s)', async progressing => {
    const fixture = await throughPackageEndpoint();
    const stop = new AbortController();
    const running = await fillSlots(fixture, label => fixture.call(label, { signal: stop.signal }).catch(error => error));
    const notifications: { progress: number; message?: string }[] = [];
    const idleMs = 30 * 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const next = fixture.call('waiting', { timeout: idleMs, resetTimeoutOnProgress: true, onprogress: progress => notifications.push(progress) })
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(fixture.internals.requestQueue.size).toBe(1));
      await vi.waitFor(() => expect(notifications).toHaveLength(1)); // The notice, at once, that it is queued.
      for (let minute = 0; minute < 35; minute++) {
        if (progressing) {
          await fixture.progress.get('running-0')!();
          await vi.waitFor(() => expect(notifications).toHaveLength(minute + 2));
        }
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(settled).toBe(!progressing);
      if (progressing) expect(notifications.every(item => item.message === undefined)).toBe(true);
      else { expect(notifications).toHaveLength(1); expect(await next).toBeInstanceOf(Error); }
      stop.abort();
      await Promise.all(running);
      if (progressing) {
        expect(await next).not.toBeInstanceOf(Error);
        expect(notifications.length).toBeGreaterThan(35); // Settlement and own admission.
        expect(fixture.sent).toContain('waiting');
      }
    } finally { stop.abort(); fixture.release(); await Promise.all(running); await next; vi.useRealTimers(); }
  });

  it('keeps a queued call\'s progress increasing once the connector starts reporting its own', async () => {
    const fixture = await throughPackageEndpoint();
    fixture.internals.requestQueue.concurrency = 1;
    const stop = new AbortController(), seen: { progress: number; total?: number }[] = [];
    const first = fixture.call('running-first', { signal: stop.signal }).catch(error => error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const second = fixture.call('running-second', { onprogress: progress => seen.push(progress) }).catch(error => error);
    await waitingInQueue(fixture);
    await vi.waitFor(() => expect(seen).toHaveLength(1)); // The notice, at once, that it is queued.
    await fixture.progress.get('running-first')!();
    await fixture.progress.get('running-first')!();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    stop.abort();
    expect(await first).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fixture.sent).toContain('running-second'));
    await vi.waitFor(() => expect(seen).toHaveLength(5)); // The first call's settlement, then its own admission.
    await fixture.progress.get('running-second')!(0); // A connector may start counting at 0.
    await vi.waitFor(() => expect(seen).toHaveLength(6));
    const values = seen.map(item => item.progress);
    expect(values.every((value, i) => i === 0 || value > values[i - 1])).toBe(true);
    fixture.release();
    await second;
  });

  it('tells a waiting caller at once that it is queued behind another request, then that the connector took it', async () => {
    const fixture = await throughPackageEndpoint();
    fixture.internals.requestQueue.concurrency = 1;
    const stop = new AbortController(), seen: { progress: number; _meta?: Record<string, unknown> }[] = [];
    const first = fixture.call('running-first', { signal: stop.signal }).catch(error => error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const second = fixture.call('running-second', { onprogress: progress => seen.push(progress) }).catch(error => error);
    await waitingInQueue(fixture);
    // The running call is silent, yet the waiting caller hears why it waits.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]._meta?.['com.mindstone/connectorWait']).toEqual({ version: 1, phase: 'queued', name: 'Acme' });
    stop.abort();
    expect(await first).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(seen.some(item => (item._meta?.['com.mindstone/connectorWait'] as { phase?: string } | undefined)?.phase === 'admitted')).toBe(true));
    const admittedAt = seen.length;
    await fixture.progress.get('running-second')!();
    await vi.waitFor(() => expect(seen).toHaveLength(admittedAt + 1));
    expect(seen.at(-1)?._meta?.['com.mindstone/connectorWait']).toBeUndefined(); // The connector's own progress carries no wait marker.
    fixture.release();
    await second;
  });

  it('says nothing about waiting to a call that a free slot takes at once', async () => {
    const fixture = await throughPackageEndpoint();
    const seen: { _meta?: Record<string, unknown> }[] = [];
    const call = fixture.call('running-alone', { onprogress: progress => seen.push(progress) }).catch(error => error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-alone']));
    await fixture.progress.get('running-alone')!();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen.every(item => item._meta?.['com.mindstone/connectorWait'] === undefined)).toBe(true);
    fixture.release();
    await call;
  });

  it('runs the next two calls when the first of three parallel calls hangs and is cancelled', async () => {
    const fixture = await throughPackageEndpoint();
    fixture.internals.requestQueue.concurrency = 1;
    const stop = new AbortController(), secondProgress = vi.fn(), thirdProgress = vi.fn();
    const first = fixture.call('running-first', { signal: stop.signal }).catch(error => error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const second = fixture.call('second', { onprogress: secondProgress });
    const third = fixture.call('third', { onprogress: thirdProgress });
    await vi.waitFor(() => expect(fixture.internals.requestQueue.size).toBe(2));
    stop.abort();
    expect(await first).toBeInstanceOf(Error);
    await Promise.all([second, third]);
    expect(fixture.sent).toEqual(['running-first', 'second', 'third']);
    expect(secondProgress).toHaveBeenCalled();
    expect(thirdProgress).toHaveBeenCalled();
  });

  it('frees a hung running slot on outer request cancellation so queued work runs', async () => {
    const fixture = await throughPackageEndpoint();
    const stop = new AbortController();
    const running = await fillSlots(fixture, label => fixture.call(label, { signal: stop.signal }).catch(error => error));
    const next = fixture.call('healthy-next');
    await waitingInQueue(fixture);
    stop.abort();
    for (const answer of await Promise.all(running)) expect(answer).toBeInstanceOf(Error);
    await next;
    expect(fixture.sent).toContain('healthy-next');
    await vi.waitFor(() => expect(fixture.internals.requestQueue.pending).toBe(0));
    // The hung handler is never released: cancellation of the relay freed its slot.
  });

  it('is never sent after the person presses Stop', async () => {
    const fixture = await throughPackageEndpoint();
    const running = await fillSlots(fixture, label => fixture.call(label));
    const stop = new AbortController();
    const queued = fixture.call('queued-write', { signal: stop.signal }).catch(error => error);
    await waitingInQueue(fixture);
    stop.abort(); // The SDK sends notifications/cancelled to Super-MCP.
    expect(await queued).toBeInstanceOf(Error);
    fixture.release();
    await Promise.all(running);
    await vi.waitFor(() => expect(fixture.internals.requestQueue.size + fixture.internals.requestQueue.pending).toBe(0));
    expect(fixture.sent).not.toContain('queued-write');
  });

  it('is never sent after the request runs out of time', async () => {
    const fixture = await throughPackageEndpoint();
    const running = await fillSlots(fixture, label => fixture.call(label));
    const queued = fixture.call('queued-write', { timeout: 500 }).catch(error => error);
    await waitingInQueue(fixture);
    expect(await queued).toMatchObject({ message: expect.stringContaining('timed out') });
    fixture.release();
    await Promise.all(running);
    await vi.waitFor(() => expect(fixture.internals.requestQueue.size + fixture.internals.requestQueue.pending).toBe(0));
    expect(fixture.sent).not.toContain('queued-write');
  });
});

describe.each(['stdio', 'http'] as const)('%s connector: a queued use_tool call whose caller has gone', transport => {
  it('never dispatches the queued use_tool call and cancels running child calls on Stop', async () => {
    const fixture = await busyConnector(transport);
    const catalog = new Catalog(fixture.registry);
    catalog.commitReady('acme', [tool], catalog.getConfigurationGeneration());
    vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
    const useTool = (label: string, signal = new AbortController().signal) => handleUseTool(
      { package_id: 'acme', tool_id: 'write', args: { label } }, fixture.registry, catalog, new Validator(),
      { dispatch: captureToolDispatch(undefined, undefined, { sendRequest: vi.fn(), sendNotification: vi.fn(), signal }) });
    const runningStop = new AbortController();
    const running = await fillSlots(fixture, label => useTool(label, runningStop.signal).catch(error => error));
    const stop = new AbortController();
    const queued = useTool('queued-write', stop.signal).catch(error => error);
    await waitingInQueue(fixture);
    stop.abort(); runningStop.abort();
    const answers = await Promise.all(running);
    for (const answer of answers) expect(answer).toMatchObject({ message: expect.stringContaining('aborted') });
    await vi.waitFor(() => expect(fixture.cancelled).toHaveLength(running.length));
    fixture.release();
    await queued;
    expect(fixture.sent).not.toContain('queued-write');
  });
});

describe.each(['stdio', 'http'] as const)('%s connector, looked up as a real call looks it up', transport => {
  it('tells a call that arrives while the connector is busy that it waits, before the busy call ends', async () => {
    const fixture = await busyConnector(transport, { registered: true });
    fixture.internals.requestQueue.concurrency = 1;
    const router = createPackageServer(fixture.registry, 'acme');
    const host = new Client({ name: 'host', version: '1' });
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
    cleanup.push(() => router.close(), () => host.close());
    const stop = new AbortController(), seen: Array<{ progress: number; _meta?: Record<string, unknown> }> = [];
    const first = host.callTool({ name: 'write', arguments: { label: 'running-first' } }, undefined, { signal: stop.signal }).catch(error => error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const second = host.callTool({ name: 'write', arguments: { label: 'running-second' } }, undefined, { onprogress: progress => seen.push(progress) }).catch(error => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]._meta?.[CONNECTOR_WAIT_META]).toEqual({ version: 1, phase: 'queued', name: 'Acme' });
    stop.abort();
    expect(await first).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first', 'running-second']));
    await fixture.progress.get('running-second')!(1);
    await vi.waitFor(() => expect(seen.at(-1)?._meta?.[CONNECTOR_WAIT_META]).toBeUndefined());
    fixture.release();
    await second;
    // The wait ends before the call goes out (the first call's error path may queue it once more), and
    // the connector's own progress carries on from the last number sent.
    const phases = seen.map(progress => (progress._meta?.[CONNECTOR_WAIT_META] as { phase?: string } | undefined)?.phase);
    expect(phases.slice(-2)).toEqual(['admitted', undefined]);
    seen.slice(1).forEach((progress, i) => expect(progress.progress).toBeGreaterThan(seen[i].progress));
  });

  it('keeps the client when a caller leaves while its health check waits', async () => {
    const fixture = await busyConnector(transport, { registered: true });
    fixture.internals.requestQueue.concurrency = 1;
    const clients = (fixture.registry as unknown as { clients: Map<string, unknown> }).clients;
    const client = clients.get('acme');
    const router = createPackageServer(fixture.registry, 'acme');
    const host = new Client({ name: 'host', version: '1' });
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
    cleanup.push(() => router.close(), () => host.close());
    const leave = new AbortController(), seen: unknown[] = [];
    const first = host.callTool({ name: 'write', arguments: { label: 'running-first' } });
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const left = host.callTool({ name: 'write', arguments: { label: 'left' } }, undefined, { signal: leave.signal, onprogress: progress => { seen.push(progress); } }).catch(error => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    leave.abort();
    expect(await left).toBeInstanceOf(Error);
    fixture.release();
    await first;
    expect(clients.get('acme')).toBe(client);
    expect(await host.callTool({ name: 'write', arguments: { label: 'after' } })).toMatchObject({ content: [{ text: 'after' }] });
    expect(fixture.sent).toEqual(['running-first', 'after']);
  });
});

type Seen = { progress: number; _meta?: Record<string, unknown> };
const phase = (progress: Seen) => (progress._meta?.[CONNECTOR_WAIT_META] as { phase?: string } | undefined)?.phase;
const rises = (seen: Seen[]) => seen.slice(1).forEach((progress, i) => expect(progress.progress).toBeGreaterThan(seen[i].progress));

async function hostFor(registry: PackageRegistry) {
  const router = createPackageServer(registry, 'acme');
  const host = new Client({ name: 'host', version: '1' });
  const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
  cleanup.push(() => router.close(), () => host.close());
  return host;
}

describe('stdio connector: the steps before a call also tell it that it waits', () => {
  it('tells a call carrying forwarded files, whose tool details are looked up first', async () => {
    const fixture = await busyConnector('stdio', { registered: true });
    const host = await hostFor(fixture.registry);
    const first = host.callTool({ name: 'write', arguments: { label: 'running-first' } });
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const seen: Seen[] = [];
    const second = host.callTool({ name: 'write', arguments: { label: 'forwarded' }, _meta: { 'rebel/forwardedFiles': [] } }, undefined, { onprogress: progress => { seen.push(progress); } });
    await vi.waitFor(() => expect(seen).not.toHaveLength(0));
    expect(phase(seen[0])).toBe('queued');
    fixture.release();
    await first;
    expect(await second).toMatchObject({ content: [{ text: 'forwarded' }] });
    rises(seen);
  });

  it('tells a call whose file inputs are read from tool details not yet listed', async () => {
    const fixture = await busyConnector('stdio');
    const first = fixture.local.callTool('write', { label: 'running-first' });
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const seen: Seen[] = [];
    const context = { kind: 'origin', authority: { version: 1 }, signal: new AbortController().signal, sendRequest: vi.fn(), sendNotification: vi.fn(),
      metadata: { 'files/invocation': { version: 1, invocationId: 'active' } }, onprogress: (progress: Seen) => { seen.push(progress); } } as unknown as ToolDispatchContext;
    const prepared = preflightLocalTool(fixture.local, fixture.config, 'write', { label: 'x' }, context);
    await vi.waitFor(() => expect(seen).not.toHaveLength(0));
    expect(phase(seen[0])).toBe('queued');
    fixture.release();
    await first;
    await prepared;
  });

  it('tells a call sent to a package home whose tool details are listed there first', async () => {
    const fixture = await busyConnector('stdio', { registered: true });
    const router = packageHome(fixture.registry);
    const first = fixture.registry.callTool('acme', 'write', { label: 'running-first' }, { kind: 'standalone' });
    await vi.waitFor(() => expect(fixture.sent).toEqual(['running-first']));
    const seen: Seen[] = [];
    // A path in the arguments makes the router list the home's tools before the call.
    const second = router.callTool('acme', 'write', { label: 'home', note: '/elsewhere/notes.txt' }, { kind: 'standalone', onprogress: progress => { seen.push(progress); } });
    await vi.waitFor(() => expect(seen).not.toHaveLength(0));
    expect(phase(seen[0])).toBe('queued');
    fixture.release();
    await first;
    expect(await second).toMatchObject({ content: [{ text: 'home' }] });
    rises(seen);
  });

  it('keeps a call\'s progress rising when it waits again on a replacement client', async () => {
    const old = await busyConnector('stdio', { registered: true });
    const replacement = await busyConnector('stdio');
    vi.spyOn(old.registry as unknown as { createAndConnectClient: () => Promise<unknown> }, 'createAndConnectClient').mockResolvedValue(replacement.local);
    const host = await hostFor(old.registry);
    const first = host.callTool({ name: 'write', arguments: { label: 'running-a' } });
    await vi.waitFor(() => expect(old.sent).toEqual(['running-a']));
    // From now on the old connector fails its health checks, so the next calls move to a replacement.
    old.connector.setRequestHandler(ListToolsRequestSchema, async () => { throw new Error('connector stopped answering'); });
    const replaced = host.callTool({ name: 'write', arguments: { label: 'running-b' } });
    await vi.waitFor(() => expect(old.internals.requestQueue.size).toBe(1));
    const seen: Seen[] = [];
    // Straight to the registry, as `use_tool` calls it, without the router's own ordering.
    const late = old.registry.callTool('acme', 'write', { label: 'late' }, { kind: 'standalone', onprogress: progress => { seen.push(progress); } });
    await vi.waitFor(() => expect(seen).not.toHaveLength(0));
    old.release();
    await first;
    await vi.waitFor(() => expect(replacement.sent).toEqual(['running-b']));
    await vi.waitFor(() => expect(seen.slice(1).some(progress => phase(progress) === 'queued' && seen.some((earlier, i) => i < seen.indexOf(progress) && phase(earlier) === 'admitted'))).toBe(true));
    replacement.release();
    await replaced;
    expect(await late).toMatchObject({ content: [{ text: 'late' }] });
    rises(seen);
  });
});

describe('http connector whose session expires while every slot is busy', () => {
  it('opens a fresh session for a waiting call and tells it that it waits', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    let opened = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
      if (body?.method === 'initialize') {
        opened += 1;
        const connector = new Server({ name: 'acme', version: '1' }, { capabilities: { tools: {} } });
        connector.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
        connector.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          const label = String(params.arguments?.label);
          sent.push(label);
          if (label.startsWith('running')) await held;
          return { content: [{ type: 'text', text: label }] };
        });
        transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        await connector.connect(transport);
        cleanup.push(() => connector.close());
      }
      if (!transport) return new Response('Session not found', { status: 404 });
      const response = await transport.handleRequest(request);
      const id = response.headers.get('mcp-session-id');
      if (id) sessions.set(id, transport);
      return response;
    });
    const registry = new PackageRegistry({ mcpServers: { acme: { url: 'https://connector.example/mcp' } } });
    cleanup.push(() => registry.closeAll());
    const router = createPackageServer(registry, 'acme');
    const host = new Client({ name: 'host', version: '1' });
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
    cleanup.push(() => router.close(), () => host.close());
    await host.callTool({ name: 'write', arguments: { label: 'first' } });
    const running = Array.from({ length: 5 }, (_, i) => host.callTool({ name: 'write', arguments: { label: `running-${i}` } }));
    await vi.waitFor(() => expect(sent).toHaveLength(6));
    sessions.clear();
    const seen: Seen[] = [];
    const late = host.callTool({ name: 'write', arguments: { label: 'late' } }, undefined, { onprogress: progress => { seen.push(progress); } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]._meta?.[CONNECTOR_WAIT_META]).toMatchObject({ version: 1, phase: 'queued' });
    release();
    await Promise.all(running);
    expect(await late).toMatchObject({ content: [{ text: 'late' }] });
    expect(opened).toBe(2);
  });
});
