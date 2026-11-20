import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProgressNotificationSchema, type ProgressNotification, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { captureToolDispatch, childCallContext, relayToolProgress, type ToolDispatchContext } from '../src/fileReadProtocol.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';
import { Catalog } from '../src/catalog.js';
import { getValidator } from '../src/validator.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { createStreamedResultFixtureServer } from './fixtures/streamed-result-mcp-server.mjs';

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logs }));
const fixture = fileURLToPath(new URL('./fixtures/streamed-result-mcp-server.mjs', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
let root: string;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'progress-relay-'));
  vi.stubEnv('REBEL_WORKSPACE_PATH', root); setSecurityPolicy(new SecurityPolicy({}));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  setSecurityPolicy(new SecurityPolicy({})); await rm(root, { recursive: true, force: true });
});
async function workspace(name: string) {
  const dir = path.join(root, name); await mkdir(dir);
  return { workspace: dir, releaseFile: path.join(dir, 'release') };
}
function keep(registry: PackageRegistry) { cleanup.push(() => registry.closeAll()); return registry; }
type FixtureServer = ReturnType<typeof createPackageServer> | ReturnType<typeof createStreamedResultFixtureServer>;
async function serve(factory: () => FixtureServer, options: { loseFinal?: boolean; enrich?: boolean } = {}) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const calls: Array<{ params: { name: string }; id: number }> = [];
  const wireTokens: unknown[] = []; const responses = new Map<number, http.ServerResponse>();
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (body?.method === 'tools/call') { calls.push(body); responses.set(body.id, res); }
      let transport = sessions.get(String(req.headers['mcp-session-id']));
      if (body?.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => sessions.set(id, transport!),
        });
        const server = factory(); cleanup.push(() => server.close());
        const send = transport.send.bind(transport);
        transport.send = async (message, extra) => {
          if ('method' in message && message.method === 'notifications/progress') {
            wireTokens.push(message.params?.progressToken);
            if (options.enrich) message = { ...message, params: { ...message.params, total: 20,
              _meta: { ...message.params?._meta, 'example/opaque': { keep: ['all', 7] } },
            } };
          }
          if (options.loseFinal && 'id' in message && calls.some(call => call.id === message.id) && ('result' in message || 'error' in message)) {
            responses.get(message.id)?.destroy(); return;
          }
          await send(message, extra);
        };
        await server.connect(transport);
      }
      if (!transport) { res.writeHead(404).end(); return; }
      await transport.handleRequest(req, res, body);
    })().catch(error => { res.destroy(error); });
  });
  httpServer.listen(0, '127.0.0.1'); await once(httpServer, 'listening');
  cleanup.push(async () => {
    for (const transport of sessions.values()) await transport.close();
    httpServer.closeAllConnections(); await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/mcp`, calls, wireTokens };
}
async function setup(kind: 'stdio' | 'http', home: boolean, heartbeatMs = 0, timeout = 3000) {
  const upstream = kind === 'http' ? await serve(() => createStreamedResultFixtureServer({ heartbeatMs }), { enrich: true }) : undefined;
  const entry = kind === 'stdio'
    ? { command: process.execPath, args: [fixture], cwd: path.dirname(fixture), env: { FIXTURE_HEARTBEAT_MS: String(heartbeatMs) }, timeout }
    : { url: upstream!.url, type: 'http' as const, timeout };
  let registry = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
  let homeEndpoint: Awaited<ReturnType<typeof serve>> | undefined;
  if (home) {
    const inner = registry; homeEndpoint = await serve(() => createPackageServer(inner, 'notebook', root));
    registry = keep(new PackageRegistry({ mcpServers: { notebook: entry }, packageHomes: { notebook: { url: homeEndpoint.url } } }));
  }
  await registry.getClient('notebook'); return { registry, upstream, homeEndpoint };
}
async function topClient(registry: PackageRegistry) {
  const server = createPackageServer(registry, 'notebook', root);
  const client = new Client({ name: 'progress-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  cleanup.push(() => server.close()); cleanup.push(() => client.close()); return client;
}
const routes = [
  { kind: 'stdio' as const, home: false }, { kind: 'http' as const, home: false },
  { kind: 'stdio' as const, home: true }, { kind: 'http' as const, home: true },
];

describe.each(routes)('progress through $kind (home $home)', ({ kind, home }) => {
  it.each([0, 'parent-token'])('publishes before final release and remaps token %s', async token => {
    const { registry, upstream, homeEndpoint } = await setup(kind, home);
    const client = await topClient(registry); const args = await workspace('files');
    const messages: ProgressNotification[] = []; const ready = deferred(); let settled = false;
    client.setNotificationHandler(ProgressNotificationSchema, item => { messages.push(item); if (item.params.progress === 4) ready.resolve(); });
    const result = client.callTool({ name: 'stream-files', arguments: args, _meta: { progressToken: token } }).then(value => { settled = true; return value; });
    await Promise.race([ready.promise, result.then(() => { throw new Error('Premature final result'); })]);
    expect(settled).toBe(false); expect(messages.at(-1)!.params.progress).toBe(4);
    expect(await readFile(path.join(args.workspace, 'outputs/first.txt'), 'utf8')).toBe('first\n');
    await writeFile(args.releaseFile, 'go'); const final = await result;
    expect(final.isError).toBeUndefined(); expect(final.content).toEqual([{ type: 'text', text: 'Files written' }]);
    expect(final.structuredContent).toMatchObject({ files: [{ ref: 'outputs/first.txt', bytes: 11 }, { ref: 'outputs/second.txt', bytes: 12 }] });
    expect(messages.at(-1)!.params.progress).toBe(6);
    expect(messages.map(item => item.params.progressToken)).toEqual(Array(messages.length).fill(token));
    expect(messages.map(item => item.params.progress)).toEqual([...new Set(messages.map(item => item.params.progress))].sort((a, b) => a - b));
    expect(messages[0].params._meta?.['com.mindstone/stream']).toBeUndefined();
    expect(messages.at(-1)!.params._meta?.['com.mindstone/stream']).toMatchObject({ ref: 'outputs/second.txt', state: 'complete' });
    if (upstream) {
      expect(messages.every(item => item.params.total === 20)).toBe(true);
      expect(messages.every(item => JSON.stringify(item.params._meta?.['example/opaque']) === JSON.stringify({ keep: ['all', 7] }))).toBe(true);
      expect(upstream.wireTokens.every(value => typeof value === 'number')).toBe(true);
    }
    if (homeEndpoint) expect(homeEndpoint.wireTokens.every(value => typeof value === 'number')).toBe(true);
    const count = messages.length; await new Promise(resolve => setTimeout(resolve, 25)); expect(messages).toHaveLength(count);
  });
  it('isolates concurrent calls with the same tool name', async () => {
    const { registry } = await setup(kind, home); const client = await topClient(registry);
    const first = await workspace('first'); const second = await workspace('second');
    const counts = new Map<string | number, number>(); const ready = deferred();
    client.setNotificationHandler(ProgressNotificationSchema, item => {
      counts.set(item.params.progressToken, item.params.progress);
      if (counts.get(0) === 4) ready.resolve();
    });
    const one = client.callTool({ name: 'stream-files', arguments: first, _meta: { progressToken: 0 } }); await ready.promise;
    const two = client.callTool({ name: 'stream-files', arguments: second, _meta: { progressToken: 'other' } });
    if (kind === 'http') await vi.waitFor(() => expect(counts.get('other')).toBe(4));
    await writeFile(first.releaseFile, 'go'); await one;
    await vi.waitFor(() => expect(counts.get('other')).toBe(4)); expect(counts.get(0), JSON.stringify([...counts])).toBe(6);
    await writeFile(second.releaseFile, 'go'); await two; expect([...counts.entries()]).toEqual([[0, 6], ['other', 6]]);
  });
  it('drains a delayed upstream sender before settling the real child call', async () => {
    const { registry } = await setup(kind, home); const args = await workspace('delayed');
    const started = deferred(); const release = deferred(); const childFinal = deferred();
    const sdkCall = Client.prototype.callTool;
    vi.spyOn(Client.prototype, 'callTool').mockImplementation(async function (...args) {
      const value = await sdkCall.apply(this, args); childFinal.resolve(); return value;
    });
    const messages: Progress[] = []; let settled = false;
    const result = registry.callTool('notebook', 'stream-files', args, { kind: 'standalone', onprogress: async item => {
      if (messages.length === 0) { started.resolve(); await release.promise; } messages.push(item);
    } }).then(value => { settled = true; return value; });
    await started.promise; await writeFile(args.releaseFile, 'go'); await childFinal.promise;
    expect(settled).toBe(false); release.resolve(); await result;
    expect(messages[0].progress).toBe(1); expect(messages.at(-1)!.progress).toBe(6);
    expect(messages.map(item => item.progress)).toEqual([...new Set(messages.map(item => item.progress))].sort((a, b) => a - b));
  });
  it('Stop reaches an executing child and prevents later progress', async () => {
    const { registry } = await setup(kind, home); const args = { ...await workspace('stop'), cancelledFile: path.join(root, 'cancelled') };
    const abort = new AbortController(); const messages: Progress[] = []; const ready = deferred();
    const context: ToolDispatchContext = { kind: 'standalone', signal: abort.signal, onprogress: item => { messages.push(item); if (item.progress === 4) ready.resolve(); } };
    const result = registry.callTool('notebook', 'stream-files', args, context); const failed = expect(result).rejects.toThrow();
    await ready.promise; abort.abort(new Error('Stopped')); await failed;
    await vi.waitFor(async () => expect(await readFile(args.cancelledFile, 'utf8')).toBe('cancelled'));
    const count = messages.length; await writeFile(args.releaseFile, 'go');
    await new Promise(resolve => setTimeout(resolve, 30)); expect(messages).toHaveLength(count);
    expect(await readFile(path.join(args.workspace, 'outputs/first.txt'), 'utf8')).toBe('first\n');
  });
});

it('carries the optional callback through reconstructed package-home context', async () => {
  const { registry } = await setup('http', true); const client = await registry.getClient('notebook'); expect(client).toBeInstanceOf(PackageHomeClient);
  const args = await workspace('reconstructed'); const messages: Progress[] = [];
  const result = client.callTool('stream-files', args, { readMode: 'unnegotiated', onprogress: item => { messages.push(item); } });
  await vi.waitFor(() => expect(messages.at(-1)?.progress).toBe(4)); await writeFile(args.releaseFile, 'go'); await result; expect(messages.at(-1)?.progress).toBe(6);
});
it('Stop while queued never dispatches the waiting stdio call', async () => {
  const { registry } = await setup('stdio', true); const client = await registry.getClient('notebook');
  const first = await workspace('active'); const second = await workspace('queued');
  const ready = deferred(); let count = 0;
  const one = client.callTool('stream-files', first, { readMode: 'unnegotiated', onprogress: () => { if (++count === 4) ready.resolve(); } }); await ready.promise;
  const abort = new AbortController(); const secondProgress = vi.fn();
  const two = client.callTool('stream-files', second, { readMode: 'unnegotiated', signal: abort.signal, onprogress: secondProgress }); const stopped = expect(two).rejects.toThrow();
  abort.abort(new Error('Stopped while queued')); await stopped; await writeFile(first.releaseFile, 'go'); await one;
  await new Promise(resolve => setTimeout(resolve, 30)); expect(secondProgress).not.toHaveBeenCalled();
  await expect(readFile(path.join(second.workspace, 'outputs/first.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not replay after a lost package-home final response', async () => {
  const inner = await setup('http', false);
  const endpoint = await serve(() => createPackageServer(inner.registry, 'notebook', root), { loseFinal: true });
  const registry = keep(new PackageRegistry({ mcpServers: { notebook: { command: '/must-never-run' } }, packageHomes: { notebook: { url: endpoint.url } } }));
  const args = await workspace('lost'); const messages: Progress[] = [];
  const result = registry.callTool('notebook', 'stream-files', args, { kind: 'standalone', onprogress: item => { messages.push(item); } }); const failed = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(messages.at(-1)?.progress).toBe(4)); await writeFile(args.releaseFile, 'go'); await failed;
  expect(endpoint.calls).toHaveLength(1); expect(inner.upstream!.calls).toHaveLength(1);
  const count = messages.length; await new Promise(resolve => setTimeout(resolve, 30)); expect(messages).toHaveLength(count); expect(endpoint.calls).toHaveLength(1);
});
it('preserves success metadata and existing error hoisting suppression', async () => {
  const { registry } = await setup('http', true); const catalog = new Catalog(registry); await catalog.ensurePackageLoaded('notebook');
  const client = await registry.getClient('notebook') as PackageHomeClient; const real = client.callToolFromOrigin.bind(client);
  vi.spyOn(client, 'callToolFromOrigin').mockImplementation(async (...args) => ({ ...await real(...args), _meta: { ui: { resourceUri: 'ui://fixture/view' }, opaque: 'kept' } }));
  for (const outcome of ['complete', 'incomplete']) {
    const args = { ...await workspace(outcome), outcome }; await writeFile(args.releaseFile, 'go');
    const result = await handleUseTool({ package_id: 'notebook', tool_id: 'stream-files', args }, registry, catalog, getValidator());
    if (outcome === 'complete') { expect(result.structuredContent).toHaveProperty('files'); expect(result._meta?.ui).toEqual({ resourceUri: 'ui://fixture/view' }); }
    else { expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined(); expect(result._meta?.ui).toBeUndefined(); }
  }
});
it('drains delayed sends in order and remaps only the hop token', async () => {
  const release = deferred(); const started = deferred(); const seen: unknown[] = [];
  const dispatch = captureToolDispatch(undefined, { progressToken: 0 }, {
    signal: new AbortController().signal, sendRequest: vi.fn(), sendNotification: async item => {
      if (seen.length === 0) { started.resolve(); await release.promise; } seen.push(item);
    },
  });
  let callback!: (value: Progress) => void; let settled = false;
  const progress = { progress: 1, total: 5, message: 'Working', _meta: { arbitrary: { nested: [1] } } };
  const result = relayToolProgress(childCallContext(dispatch), 1000, async options => {
    callback = options.onprogress!; callback(progress); callback({ ...progress, progress: 2 }); return { structuredContent: { kept: true } };
  }).then(value => { settled = true; return value; });
  await started.promise; expect(settled).toBe(false); release.resolve(); expect(await result).toHaveProperty('structuredContent.kept', true);
  expect(seen).toEqual([1, 2].map(value => ({ method: 'notifications/progress', params: { ...progress, progress: value, progressToken: 0 } })));
  callback({ ...progress, progress: 3 }); await Promise.resolve(); expect(seen).toHaveLength(2);
});
it('logs asynchronous forwarding failures', async () => {
  logs.warn.mockClear(); const send = vi.fn().mockRejectedValue(new Error('Synthetic failure'));
  expect(await relayToolProgress({ onprogress: send }, 1000, async options => {
    options.onprogress!({ progress: 1 }); options.onprogress!({ progress: 2 }); return 'final';
  })).toBe('final');
  expect(send).toHaveBeenCalledTimes(2); expect(logs.warn).toHaveBeenCalledTimes(2);
});
it.each(['none', 'frequent', 'delayed sender', 'Stop'])('cleans the relay at a fixed scaled budget: %s', async mode => {
  vi.useFakeTimers(); const abort = new AbortController(); let relaySignal!: AbortSignal; let callback!: (value: Progress) => void;
  const send = vi.fn(mode === 'delayed sender' ? () => new Promise<void>(() => {}) : async () => {});
  const result = relayToolProgress({ signal: abort.signal, onprogress: send }, 100, async options => {
    relaySignal = options.signal; callback = options.onprogress!; expect(options.resetTimeoutOnProgress).toBe(false);
    if (mode === 'delayed sender') { callback({ progress: 1 }); return 'final'; } return new Promise<string>(() => {});
  });
  const outcome = mode === 'delayed sender' ? expect(result).resolves.toBe('final') : expect(result).rejects.toThrow(mode === 'Stop' ? 'Stopped' : 'Request timed out');
  for (let i = 0; i < 9; i++) { if (mode === 'frequent') callback({ progress: i }); await vi.advanceTimersByTimeAsync(10); }
  if (mode === 'Stop') abort.abort(new Error('Stopped'));
  else { expect(relaySignal.aborted).toBe(false); await vi.advanceTimersByTimeAsync(10); }
  await outcome;
  if (mode === 'delayed sender') expect(logs.warn).toHaveBeenCalledWith({ in_flight: true, queued: false }, 'Tool finished with undelivered progress');
  expect(relaySignal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  const count = send.mock.calls.length; callback({ progress: 100 }); await vi.runAllTimersAsync(); expect(send).toHaveBeenCalledTimes(count);
});
it.each(routes)('child budget stays fixed with frequent progress: %j', async ({ kind, home }) => {
  const { registry } = await setup(kind, home, 10, 150); const args = await workspace('timeout'); const messages: Progress[] = []; const start = Date.now();
  await expect(registry.callTool('notebook', 'stream-files', args, { kind: 'standalone', onprogress: item => { messages.push(item); } })).rejects.toThrow(/timed out|reachable/);
  expect(Date.now() - start).toBeLessThan(1500); expect(messages.length).toBeGreaterThan(4);
  const count = messages.length; await new Promise(resolve => setTimeout(resolve, 30)); expect(messages).toHaveLength(count);
});

it('preserves progress coalesced with the final SDK response in one transport read', async () => {
  const server = createStreamedResultFixtureServer();
  const client = new Client({ name: 'coalesced-progress', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  cleanup.push(() => server.close()); cleanup.push(() => client.close());
  const args = await workspace('coalesced'); const initial = deferred(); const messages: Progress[] = [];
  const send = remote.send.bind(remote); const batch: Parameters<typeof remote.send>[0][] = [];
  remote.send = async (message, options) => {
    if ('method' in message && message.method === 'notifications/progress' && Number(message.params?.progress) >= 5) { batch.push(message); return; }
    if ('result' in message && batch.length) {
      // A stdio read can synchronously deliver these three JSON lines together.
      for (const item of [...batch, message]) local.onmessage?.(item);
      return;
    }
    await send(message, options);
  };
  const result = relayToolProgress({ onprogress: item => { messages.push(item); if (item.progress === 4) initial.resolve(); } }, 1000,
    options => client.callTool({ name: 'stream-files', arguments: args }, undefined, options), local);
  await initial.promise; await writeFile(args.releaseFile, 'go'); await result;
  expect(messages.map(item => item.progress)).toEqual([1, 2, 3, 4, 5, 6]);
});

it.each([false, true])('omits child progress tokens without a parent consumer (home %s)', async home => {
  const { registry, upstream, homeEndpoint } = await setup('http', home);
  const args = await workspace('no-token'); await writeFile(args.releaseFile, 'go');
  const result = await registry.callTool('notebook', 'stream-files', args);
  expect(result.isError).toBeUndefined();
  for (const endpoint of [upstream, homeEndpoint].filter(Boolean)) {
    expect(endpoint!.calls).toHaveLength(1);
    expect(endpoint!.calls[0].params).not.toHaveProperty('_meta.progressToken');
    expect(endpoint!.wireTokens).toEqual([]);
  }
});
it('keeps only the latest queued update under a slow sender', async () => {
  const release = deferred(); const started = deferred(); const seen: number[] = [];
  const result = relayToolProgress({ onprogress: async item => {
    seen.push(item.progress); if (seen.length === 1) { started.resolve(); await release.promise; }
  } }, 1000, async options => {
    for (let progress = 1; progress <= 10000; progress++) options.onprogress!({ progress });
    return 'final';
  });
  await started.promise; expect(seen).toEqual([1]); release.resolve();
  expect(await result).toBe('final'); expect(seen).toEqual([1, 10000]);
});
it('keeps each stream terminal and latest update in slot order under a slow sender', async () => {
  const release = deferred(), started = deferred(); const seen: Progress[] = [];
  const update = (progress: number, ref: string, state: string): Progress => ({ progress, _meta: { 'com.mindstone/stream': { ref, state } } });
  const result = relayToolProgress({ onprogress: async item => {
    seen.push(item); if (seen.length === 1) { started.resolve(); await release.promise; }
  } }, 1000, async options => {
    for (const item of [update(1, 'A', 'running'), update(2, 'A', 'complete'), update(3, 'B', 'running'), update(4, 'B', 'running')]) options.onprogress!(item);
    return 'final';
  });
  await started.promise; release.resolve(); expect(await result).toBe('final');
  expect(seen.map(item => item.progress)).toEqual([1, 2, 4]);
});
it('caps replaceable slots, preserves overflow terminals and never replaces a terminal with a later running update', async () => {
  const release = deferred(), started = deferred(); const seen: number[] = [];
  const result = relayToolProgress({ onprogress: async item => {
    seen.push(item.progress); if (seen.length === 1) { started.resolve(); await release.promise; }
  } }, 1000, async options => {
    options.onprogress!({ progress: 0 });
    for (let progress = 1; progress <= 100; progress++) options.onprogress!({ progress, _meta: { 'com.mindstone/stream': { ref: `file-${progress}` } } });
    for (let progress = 101; progress <= 103; progress++) options.onprogress!({ progress, _meta: { 'com.mindstone/stream': { ref: `terminal-${progress}`, state: 'incomplete' } } });
    options.onprogress!({ progress: 104, _meta: { 'com.mindstone/stream': { ref: 'terminal-101', state: 'running' } } });
    return 'final';
  });
  await started.promise; release.resolve(); await result;
  expect(seen).toEqual([0, ...Array.from({ length: 15 }, (_, i) => i + 1), 101, 102, 103, 104]);
});
it.each(['repeated', 'fresh'] as const)('bounds %s terminal floods and delivers newest-per-ref in send order', async kind => {
  const release = deferred(), started = deferred(); const seen: number[] = [];
  const result = relayToolProgress({ onprogress: async item => {
    seen.push(item.progress); if (seen.length === 1) { started.resolve(); await release.promise; }
  } }, 1000, async options => {
    options.onprogress!({ progress: 0 });
    for (let progress = 1; progress <= 10000; progress++) options.onprogress!({ progress,
      _meta: { 'com.mindstone/stream': { ref: kind === 'repeated' ? `file-${progress % 3}` : `file-${progress}`, state: 'complete' } } });
    return 'final';
  });
  await started.promise; expect(seen).toEqual([0]); release.resolve(); expect(await result).toBe('final');
  expect(seen).toEqual(kind === 'repeated' ? [0, 9998, 9999, 10000] : [0, ...Array.from({ length: 256 }, (_, i) => i + 1), 10000]);
});
it('keeps package-home connected when only the successful call drain times out', async () => {
  const { registry } = await setup('http', true, 0, 200);
  const client = await registry.getClient('notebook') as PackageHomeClient;
  const args = await workspace('home-drain'); await writeFile(args.releaseFile, 'go');
  const send = vi.fn(() => new Promise<void>(() => {}));
  const result = await client.callTool('stream-files', args, { readMode: 'unnegotiated', onprogress: send });
  expect(result.isError).toBeUndefined(); expect(await client.healthCheck()).toBe('ok');
  expect(logs.warn).toHaveBeenCalledWith({ in_flight: true, queued: true }, 'Tool finished with undelivered progress');
  expect(send).toHaveBeenCalledTimes(1);
});
it('returns the finished result when Stop arrives during its drain', async () => {
  const abort = new AbortController(), started = deferred();
  const result = relayToolProgress({ signal: abort.signal, onprogress: async () => {
    started.resolve(); await new Promise<void>(() => {});
  } }, 1000, async options => { options.onprogress!({ progress: 1 }); return 'final'; });
  const finished = expect(result).resolves.toBe('final');
  await started.promise; await Promise.resolve(); abort.abort(new Error('Stopped')); await finished;
});
