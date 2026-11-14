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
import { captureToolDispatch } from '../src/fileReadProtocol.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { Validator } from '../src/validator.js';
import type { PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// FOX-7907: once its caller has stopped or timed out, a call still waiting for a
// connector slot must never reach the connector. A call already running is left alone.

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tool = { name: 'write', inputSchema: { type: 'object' as const, properties: { label: { type: 'string' } } } };

/** A connector whose every slot is held by a running call, so the next call has to queue. */
async function busyConnector(transport: 'stdio' | 'http') {
  const config: PackageConfig = transport === 'stdio'
    ? { id: 'acme', name: 'Acme', transport, visibility: 'default', command: 'unused', cwd: '/connector' }
    : { id: 'acme', name: 'Acme', transport, visibility: 'default', base_url: 'https://connector.example/mcp' };
  const connector = new Server({ name: 'acme', version: '1' }, { capabilities: { tools: {} } });
  const sent: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  connector.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
  connector.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const label = String(params.arguments?.label);
    sent.push(label);
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
  vi.spyOn(registry, 'getClient').mockResolvedValue(local);
  cleanup.push(() => connector.close(), () => internals.client.close(), () => registry.closeAll());
  return { registry, sent, release, internals };
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

/** Serves `registry` as the package home of another Rebel, which reaches it over streamable HTTP. */
function packageHome(registry: PackageRegistry) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().json() : undefined;
    let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (body?.method === 'initialize') {
      const server = createPackageServer(registry, 'acme');
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
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
    const host = new Client({ name: 'rebel', version: '1' });
    const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
    cleanup.push(() => router.close(), () => host.close());
    const call = (label: string, options?: { signal?: AbortSignal; timeout?: number }) =>
      host.callTool({ name: 'write', arguments: { label } }, undefined, options);
    return { ...fixture, call };
  }

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
  it('is never sent through use_tool after the person presses Stop, while a running call still finishes', async () => {
    const fixture = await busyConnector(transport);
    const catalog = new Catalog(fixture.registry);
    catalog.commitReady('acme', [tool], catalog.getConfigurationGeneration());
    vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
    const useTool = (label: string, signal = new AbortController().signal) => handleUseTool(
      { package_id: 'acme', tool_id: 'write', args: { label } }, fixture.registry, catalog, new Validator(),
      { dispatch: captureToolDispatch(undefined, undefined, { sendRequest: vi.fn(), signal }) });
    const runningStop = new AbortController();
    const running = await fillSlots(fixture, label => useTool(label, runningStop.signal));
    const stop = new AbortController();
    const queued = useTool('queued-write', stop.signal).catch(error => error);
    await waitingInQueue(fixture);
    stop.abort(); runningStop.abort();
    fixture.release();
    const answers = await Promise.all(running);
    expect(answers[0]).toMatchObject({ content: [{ text: expect.stringContaining('"text": "running-0"') }] });
    await queued;
    expect(fixture.sent).not.toContain('queued-write');
  });
});
