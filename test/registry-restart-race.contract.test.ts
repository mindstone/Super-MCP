import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { NeverSentError } from '../src/dispatchErrors.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';
import { startServer } from '../src/server.js';
import type { McpClient, PackageConfig } from '../src/types.js';

const state = vi.hoisted(() => ({ transport: undefined as InMemoryTransport | undefined }));
const logger = vi.hoisted(() => ({ setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
// Only replace process I/O and background services. The router Server, SDK
// Client, catalog, use_tool handler, registry, and egress are real.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      if (!state.transport) throw new Error('Router transport was not installed');
      return state.transport;
    }
  },
}));
vi.mock('../src/configWatcher.js', () => ({ ConfigWatcher: class { async start() {} } }));
vi.mock('../src/catalogRefresher.js', () => ({ CatalogRefresher: class { start() {} } }));

const cleanup: Array<() => Promise<unknown>> = [];
const packageId = 'Acme';
const config: PackageConfig = { id: packageId, name: packageId, transport: 'stdio', command: '/must-not-spawn', cwd: '/tmp', visibility: 'default' };
const fresh = { content: [{ type: 'text' as const, text: 'fresh connector answer' }] };
const labels = JSON.parse(readFileSync(new URL('./fixtures/dispatch-label-v1.json', import.meta.url), 'utf8'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { setSecurityPolicy(new SecurityPolicy()); vi.clearAllMocks(); });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function connector(home: boolean, annotations: Record<string, boolean> = { readOnlyHint: true }) {
  const tool = { name: 'read_item', inputSchema: { type: 'object' as const, properties: {} }, annotations };
  const server = new Server({ name: 'contract-connector', version: '1' }, { capabilities: { tools: {} } });
  const received: unknown[] = [];
  const written = deferred<void>();
  const answer = deferred<typeof fresh>();
  let holdAnswer = false;
  let failure: string | undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    received.push(request.params);
    written.resolve();
    if (failure) throw new Error(failure);
    return holdAnswer ? answer.promise : fresh;
  });
  const wrapper = home
    ? new PackageHomeClient(config, { url: 'https://cloud.example.test/mcp' })
    : new StdioMcpClient(packageId, config);
  const sdk = (wrapper as unknown as { client: Client }).client;
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await sdk.connect(left);
  // A subprocess is deliberately replaced by an SDK transport pair. Its real
  // queue, close(), and SDK error propagation still run; no mock rejects calls.
  if (wrapper instanceof StdioMcpClient) {
    (wrapper as unknown as { transport: unknown }).transport = left;
    // The in-memory peer has no subprocess pid. Derive the corresponding
    // liveness signal from the SDK transport instead.
    vi.spyOn(wrapper, 'isTransportClosed').mockImplementation(() => !sdk.transport);
  } else {
    (wrapper as unknown as { connected: boolean }).connected = true;
  }
  cleanup.push(() => server.close(), () => wrapper.close());
  return { wrapper, sdk, left, received, written, answer, holdAnswer: () => { holdAnswer = true; }, fail: (message: string) => { failure = message; } };
}

async function fixture(home: boolean, annotations?: Record<string, boolean>) {
  const old = await connector(home, annotations);
  const next = await connector(home, annotations);
  const registry = new PackageRegistry({ mcpServers: {},
    ...(home ? { packageHomes: { [packageId]: { url: 'https://cloud.example.test/mcp' } } } : {}),
  });
  (registry as unknown as { packages: PackageConfig[] }).packages = [config];
  const create = vi.spyOn(registry as unknown as { createAndConnectClient(): Promise<McpClient> }, 'createAndConnectClient')
    .mockResolvedValueOnce(old.wrapper).mockResolvedValueOnce(next.wrapper);
  cleanup.push(() => registry.closeAll());
  await registry.getClient(packageId);
  return { registry, old, next, create };
}

function holdBeforeSdkSend(sdk: Client, onReject?: () => void) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = sdk.callTool.bind(sdk);
  const errors: unknown[] = [];
  vi.spyOn(sdk, 'callTool').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    try { return await original(...args); }
    catch (error) { errors.push(error); onReject?.(); throw error; }
  });
  // Closing while held here is after the wrapper's queue admission, before the
  // SDK's synchronous protocol send. Never replace this with a canned error.
  return { entered, release, errors };
}

async function routerHost(registry: PackageRegistry) {
  const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
  state.transport = routerSide;
  vi.spyOn(PackageRegistry, 'fromConfigFiles').mockResolvedValue(registry);
  vi.spyOn(registry, 'startIdleReaper').mockImplementation(() => {});
  const original = Server.prototype.connect;
  vi.spyOn(Server.prototype, 'connect').mockImplementation(async function (transport) {
    if (transport === routerSide) cleanup.push(() => this.close());
    return original.call(this, transport);
  });
  // Do not install startServer's process-exiting signal handlers in this suite.
  vi.spyOn(process, 'on').mockReturnValue(process);
  await startServer({ configPaths: [], transport: 'stdio' });
  const host = new Client({ name: 'contract-host', version: '1' });
  await host.connect(hostSide);
  cleanup.push(() => host.close());
  return () => host.callTool({ name: 'use_tool', arguments: { package_id: packageId, tool_id: 'read_item', args: {} } });
}

describe('restart contracts through real SDK clients', () => {
  it.each([false, true])('use_tool replays a read on the fresh client after an SDK pre-send close (home=%s)', async home => {
    const { registry, old, next } = await fixture(home);
    const call = await routerHost(registry);
    const gate = holdBeforeSdkSend(old.sdk);
    const result = call();
    const settled = result.then(value => ({ value }), error => ({ error }));
    await gate.entered.promise;
    await registry.restartPackage(packageId);
    // A replay retaining its first lease deadlocks on this real eviction.
    const eviction = registry.evictClient(packageId, 'restart');
    gate.release.resolve();
    const outcome = await settled;
    await eviction;
    expect(outcome).toHaveProperty('value');
    if (!('value' in outcome)) throw outcome.error;
    const content = outcome.value.content as Array<{ text: string }>;
    expect(JSON.parse(content[0].text).result).toEqual(fresh);
    expect(gate.errors).toHaveLength(1);
    expect(gate.errors[0]).toEqual(new Error('Not connected'));
    expect((gate.errors[0] as Error).constructor).toBe(Error);
    expect(old.received).toHaveLength(0);
    expect(next.received).toHaveLength(1);
  });

  it('a non-read-safe use_tool call leaves real egress with the fixture never_sent verdict and zero connector sends', async () => {
    const { registry, old, next } = await fixture(false, { readOnlyHint: false, destructiveHint: true });
    const call = await routerHost(registry);
    const gate = holdBeforeSdkSend(old.sdk);
    const outcome = call().catch((error: unknown) => error);
    await gate.entered.promise;
    await registry.restartPackage(packageId);
    gate.release.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).toMatchObject({ rebelDispatchV1: labels.neverSent });
    expect(old.received).toHaveLength(0);
    expect(next.received).toHaveLength(0);
  });

  it('a read whose never-sent replay fails leaves real egress with the fixture label carrying no verdict or reason', async () => {
    const { registry, old, next } = await fixture(false);
    next.fail('connector exploded');
    const call = await routerHost(registry);
    const oldCalls = vi.spyOn(old.wrapper, 'callTool');
    const nextCalls = vi.spyOn(next.wrapper, 'callTool');
    const gate = holdBeforeSdkSend(old.sdk);
    const outcome = call().catch((error: unknown) => error);
    await gate.entered.promise;
    await registry.restartPackage(packageId);
    gate.release.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toContain('connector exploded');
    // The label describes the last attempt, which reached the connector: home only.
    expect((error as McpError).data.rebelDispatchV1).toEqual(labels.local);
    expect(gate.errors).toEqual([new Error('Not connected')]);
    expect(oldCalls).toHaveBeenCalledTimes(1);
    expect(nextCalls).toHaveBeenCalledTimes(1);
    expect(old.received).toHaveLength(0);
    expect(next.received).toHaveLength(1);
  });

  it('closing a real SDK after tools/call was written preserves ConnectionClosed and never sends a replay', async () => {
    const { registry, old, next } = await fixture(true);
    old.holdAnswer();
    const outcome = registry.callTool(packageId, 'read_item', {}, { kind: 'standalone' }, { replayNeverSent: true })
      .catch((error: unknown) => error);
    await old.written.promise;
    await registry.restartPackage(packageId);
    const error = await outcome;
    old.answer.resolve(fresh);
    expect(error).not.toBeInstanceOf(NeverSentError);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(ErrorCode.ConnectionClosed);
    expect(old.received).toHaveLength(1);
    expect(next.received).toHaveLength(0);
  });

  it('cancellation between the never-sent failure and replay prevents all sends', async () => {
    const { registry, old, next, create } = await fixture(true);
    const controller = new AbortController();
    const cancelled = new Error('Caller cancelled at replay');
    const gate = holdBeforeSdkSend(old.sdk, () => controller.abort(cancelled));
    const outcome = registry.callTool(packageId, 'read_item', {}, { kind: 'standalone', signal: controller.signal }, { replayNeverSent: true })
      .catch((error: unknown) => error);
    await gate.entered.promise;
    await registry.restartPackage(packageId);
    gate.release.resolve();
    expect(await outcome).toBe(cancelled);
    expect(create).toHaveBeenCalledTimes(1);
    expect(old.received).toHaveLength(0);
    expect(next.received).toHaveLength(0);
  });

  it('the never-sent replay retains the existing home-session 404 replay: two wire attempts, one connector execution', async () => {
    const { registry, old, next, create } = await fixture(true);
    const last = await connector(true);
    create.mockResolvedValueOnce(last.wrapper);
    const gate = holdBeforeSdkSend(old.sdk);
    // Fail at the transport boundary before delivering to the mock connector,
    // as an expired HTTP session does. The real SDK request rejects this call.
    const originalSend = next.left.send.bind(next.left);
    let refused = 0;
    vi.spyOn(next.left, 'send').mockImplementation(async (...args) => {
      if ('method' in args[0] && args[0].method === 'tools/call') {
        refused++;
        throw new StreamableHTTPError(404, 'Session not found');
      }
      return originalSend(...args);
    });
    const outcome = registry.callTool(packageId, 'read_item', {}, { kind: 'standalone' }, { replayNeverSent: true });
    const settled = outcome.then(value => ({ value }), error => ({ error }));
    await gate.entered.promise;
    await registry.restartPackage(packageId);
    gate.release.resolve();
    expect(await settled).toMatchObject({ value: fresh });
    expect(refused).toBe(1);
    expect(old.received).toHaveLength(0);
    expect(next.received).toHaveLength(0);
    expect(last.received).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
