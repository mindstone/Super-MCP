import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { PackageHomeRefusedError } from '../src/dispatchErrors.js';
import { PackageRegistry } from '../src/registry.js';
import type { PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// FOX-11496: the cloud's refusal is honoured only as the direct answer to one tools/call POST.
const fixture = (name: string) => JSON.parse(readFileSync(path.resolve('test/fixtures', name), 'utf8'));
const refusal: { status: number; headers: Record<string, string>; body: unknown } = fixture('home-refusal-v1.json');
const marker = fixture('registry-closed-v1.json');
const paused = "Your cloud isn't reachable, so Fictional Notes is paused for now. An action that was in progress may already have happened; check its outcome before trying again.";
const config = { id: 'notebook', name: 'Fictional Notes', transport: 'stdio', command: 'unused' } as PackageConfig;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Answer = (rpc: Rpc, req: http.IncomingMessage, res: http.ServerResponse) => boolean | void;

function refuse(res: http.ServerResponse, overrides: { headers?: Record<string, string>; body?: unknown } = {}) {
  res.writeHead(refusal.status, { 'content-type': 'application/json', ...refusal.headers, ...overrides.headers })
    .end(JSON.stringify(overrides.body ?? refusal.body));
}

/** A minimal Streamable HTTP MCP server that answers in JSON; `answer` may take over any request first. */
async function home(answer: Answer = () => false, options: { onOther?: (req: http.IncomingMessage, res: http.ServerResponse) => void } = {}) {
  const seen: Array<{ method: string; url: string; rpc?: Rpc | Rpc[] }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const parsed = raw ? JSON.parse(raw) as Rpc | Rpc[] : undefined;
    seen.push({ method: req.method!, url: req.url!, rpc: parsed });
    if (req.method !== 'POST' || Array.isArray(parsed) || !parsed) {
      if (options.onOther) return options.onOther(req, res);
      return res.writeHead(405).end();
    }
    if (answer(parsed, req, res)) return;
    const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
    if (parsed.id === undefined) return res.writeHead(202).end();
    if (parsed.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {}, experimental: { 'files/forwardedInputs': { version: 1 }, 'rebel/homeMarkerGuard': { version: 1 } } }, serverInfo: { name: 'fictional', version: '1.0.0' } });
    if (parsed.method === 'tools/list') return reply({ tools: [{ name: 'read_note', inputSchema: { type: 'object' } }] });
    if (parsed.method === 'tools/call') return reply({ content: [{ type: 'text', text: `ran ${String(parsed.params?.arguments?.text)}` }] });
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/packages/notebook`, seen };
}

async function connected(url: string) {
  const client = new PackageHomeClient(config, { url });
  cleanup.push(() => client.close());
  await client.connect();
  return client;
}

const isCall = (rpc: Rpc) => rpc.method === 'tools/call';

describe('the cloud refusal on the wire', () => {
  it('a valid refusal on a tools/call POST becomes PackageHomeRefusedError', async () => {
    const { url } = await home((rpc, _req, res) => isCall(rpc) && (refuse(res), true));
    const client = await connected(url);
    const error = await client.callTool('read_note', { text: 'a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageHomeRefusedError);
    expect(error).toMatchObject({ reason: 'shutting_down', message: "Your cloud was restarting, so Fictional Notes didn't start that action." });
    expect(await client.healthCheck()).toBe('ok');
  });

  it('a thrown registry-closed marker becomes PackageHomeRefusedError', async () => {
    const { url } = await home((rpc, _req, res) => isCall(rpc) && (res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'MCP package registry is closed', data: marker } })), true));
    const client = await connected(url);
    const error = await client.callTool('read_note', { text: 'a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageHomeRefusedError);
    expect(error).toMatchObject({ reason: 'registry_closed' });
    expect(await client.healthCheck()).toBe('ok');
  });
});

describe('everything else stays as it is today', () => {
  for (const status of [307, 308]) {
    it(`a same-origin ${status} to another path, whose final hop answers a valid refusal, is not a refusal`, async () => {
      const { url, seen } = await home((rpc, req, res) => {
        if (!isCall(rpc)) return false;
        if (req.url!.endsWith('/moved')) refuse(res);
        else res.writeHead(status, { location: `${req.url}/moved` }).end();
        return true;
      });
      const client = await connected(url);
      await expect(client.callTool('read_note', { text: 'a' })).rejects.toThrow(paused);
      expect(seen.filter(entry => entry.url.endsWith('/moved'))).toHaveLength(1);
    });

    it(`a same-origin ${status} back to the same URL, whose final hop answers a valid refusal, is not a refusal`, async () => {
      let hops = 0;
      const { url } = await home((rpc, req, res) => {
        if (!isCall(rpc)) return false;
        if (hops++ === 0) res.writeHead(status, { location: req.url! }).end();
        else refuse(res);
        return true;
      });
      const client = await connected(url);
      await expect(client.callTool('read_note', { text: 'a' })).rejects.toThrow(paused);
      expect(hops).toBe(2);
    });
  }

  it('a batch body is not a refusal', async () => {
    const { url } = await home(undefined, { onOther: (_req, res) => refuse(res) });
    const client = await connected(url);
    const transport = (client as unknown as { transport: { send: (message: unknown) => Promise<void> } }).transport;
    const error = await transport.send([{ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'read_note', arguments: {} } }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error).toMatchObject({ code: 503 });
  });

  it('a resumption GET is not a refusal', async () => {
    const { url, seen } = await home(undefined, { onOther: (_req, res) => refuse(res) });
    const client = await connected(url);
    const errors: unknown[] = [];
    (client as unknown as { client: { onerror: (error: unknown) => void } }).client.onerror = error => { errors.push(error); };
    const transport = (client as unknown as { transport: { send: (message: unknown, options: object) => Promise<void> } }).transport;
    await transport.send({ jsonrpc: '2.0', id: 98, method: 'tools/call', params: { name: 'read_note', arguments: {} } }, { resumptionToken: 'event-1' });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(seen.some(entry => entry.method === 'GET')).toBe(true);
    expect(errors.some(error => error instanceof PackageHomeRefusedError)).toBe(false);
  });

  it('a DELETE is not a refusal', async () => {
    const { url } = await home(undefined, { onOther: (_req, res) => refuse(res) });
    const client = await connected(url);
    const transport = (client as unknown as { transport: { terminateSession: () => Promise<void> } }).transport;
    const error = await transport.terminateSession().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error).toMatchObject({ code: 503 });
  });

  it('a refusal of initialize is not a refusal', async () => {
    const { url } = await home((rpc, _req, res) => rpc.method === 'initialize' && (refuse(res), true));
    const client = new PackageHomeClient(config, { url });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toThrow(paused);
  });

  it('a refusal of tools/list, with header and body valid, is not a refusal', async () => {
    const { url } = await home((rpc, _req, res) => rpc.method === 'tools/list' && (refuse(res), true));
    const client = await connected(url);
    await expect(client.listTools()).rejects.toThrow(paused);
  });

  const invalid: Array<[string, { headers?: Record<string, string>; body?: unknown }]> = [
    ['an unknown version in the header', { headers: { 'rebel-admission': 'not-admitted; v=2' } }],
    ['an unknown version in the body', { body: { admission: { v: 2, disposition: 'not_admitted', reason: 'shutting_down', retryAfterMs: 30000 } } }],
    ['the header with a body that is not valid', { body: { admission: { v: 1, disposition: 'not_admitted', reason: 'shutting_down', retryAfterMs: -1 } } }],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label} is not a refusal`, async () => {
      const { url } = await home((rpc, _req, res) => isCall(rpc) && (refuse(res, overrides), true));
      const client = await connected(url);
      await expect(client.callTool('read_note', { text: 'a' })).rejects.toThrow(paused);
    });
  }

  it('a valid body without the header is not a refusal', async () => {
    const { url } = await home((rpc, _req, res) => isCall(rpc) &&
      (res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }).end(JSON.stringify(refusal.body)), true));
    const client = await connected(url);
    await expect(client.callTool('read_note', { text: 'a' })).rejects.toThrow(paused);
  });

  const listingWithMarker: Answer = (rpc, _req, res) => rpc.method === 'tools/list' && (res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'MCP package registry is closed', data: marker } })), true);

  it('the marker on a tools/list error stays an ordinary error', async () => {
    const { url } = await home(listingWithMarker);
    const client = await connected(url);
    const error = await client.listTools().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect(error).not.toBeInstanceOf(PackageHomeRefusedError);
  });

  it('the marker on the tool listing a call makes first stays an ordinary error', async () => {
    const { url, seen } = await home(listingWithMarker);
    const client = await connected(url);
    const error = await client.callTool('read_note', { text: path.resolve('note.txt') }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect(error).not.toBeInstanceOf(PackageHomeRefusedError);
    expect(seen.some(entry => !Array.isArray(entry.rpc) && entry.rpc?.method === 'tools/call')).toBe(false);
  });
});

// Only fetch is stubbed below; the SDK client, its request correlation and its Streamable HTTP transport, which
// follows a same-origin 307 or 308 by sending the POST again, are real.
const homeUrl = 'https://home.example.com/mcp/packages/notebook';
const guarded = { 'rebel/homeMarkerGuard': { version: 1 } };
const answerWith = (rpc: Rpc, body: object, init: ResponseInit = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...body }), {
  ...init, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
});
const markerError = (rpc: Rpc) => answerWith(rpc, { error: { code: -32000, message: 'Connection closed', data: { ...marker, detail: 'kept' } } });
const redirect = (to: string, status = 307) => new Response(null, { status, headers: { location: to } });
type Stub = (rpc: Rpc, url: string) => Response | Promise<Response> | undefined;

function stubHome(answer: Stub, experimental: Record<string, unknown> | undefined = guarded) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init.body)) as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const own = await answer(rpc, String(input));
    if (own) return own;
    if (rpc.method === 'initialize') return answerWith(rpc, { result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {}, ...(experimental ? { experimental } : {}) }, serverInfo: { name: 'fictional', version: '1' },
    } });
    if (rpc.method === 'tools/list') return answerWith(rpc, { result: { tools: [{ name: 'read_note', inputSchema: { type: 'object' } }] } });
    if (rpc.method === 'tools/call') return answerWith(rpc, { result: { content: [{ type: 'text', text: `ran ${String(rpc.params?.arguments?.text)}` }] } });
    throw new Error(`Unexpected request: ${rpc.method}`);
  }));
}

async function ordinaryMarkerError(pending: Promise<unknown>) {
  const error = await pending.then(() => { throw new Error('Expected the call to fail'); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpError);
  expect(error).not.toBeInstanceOf(PackageHomeRefusedError);
  expect(error).toMatchObject({ code: -32000, data: { ...marker, detail: 'kept' } });
}

describe('the thrown marker is proof only from an endpoint that guards it, with no redirect', () => {
  it('a connector\'s closed-connection error carrying the marker, from an endpoint that declared no marker guard, stays an ordinary error', async () => {
    stubHome(rpc => (rpc.method === 'tools/call' ? markerError(rpc) : undefined), { 'files/forwardedInputs': { version: 1 } });
    const client = await connected(homeUrl);
    await ordinaryMarkerError(client.callTool('read_note', { text: 'a' }));
  });

  it('the same marker from an endpoint that declared the guard is a refusal', async () => {
    stubHome(rpc => (rpc.method === 'tools/call' ? markerError(rpc) : undefined));
    const client = await connected(homeUrl);
    await expect(client.callTool('read_note', { text: 'a' })).rejects.toMatchObject({ name: 'PackageHomeRefusedError', reason: 'registry_closed' });
    expect(await client.healthCheck()).toBe('ok');
  });

  it('an unknown guard version is not honoured', async () => {
    stubHome(rpc => (rpc.method === 'tools/call' ? markerError(rpc) : undefined), { 'rebel/homeMarkerGuard': { version: 2 } });
    const client = await connected(homeUrl);
    await ordinaryMarkerError(client.callTool('read_note', { text: 'a' }));
  });

  for (const status of [307, 308]) {
    it(`the marker on an answer that arrived after a ${status} redirect is not honoured`, async () => {
      stubHome((rpc, url) => {
        if (rpc.method !== 'tools/call') return undefined;
        return url.endsWith('/moved') ? markerError(rpc) : redirect(`${homeUrl}/moved`, status);
      });
      const client = await connected(homeUrl);
      await ordinaryMarkerError(client.callTool('read_note', { text: 'a' }));
    });
  }

  it('after any redirect, a later direct marker on the same client is not honoured', async () => {
    let listings = 0;
    stubHome(rpc => {
      if (rpc.method === 'tools/list' && listings++ === 0) return redirect(homeUrl);
      return rpc.method === 'tools/call' ? markerError(rpc) : undefined;
    });
    const client = await connected(homeUrl);
    await expect(client.listTools()).resolves.toHaveLength(1);
    expect(listings).toBe(2);
    await ordinaryMarkerError(client.callTool('read_note', { text: 'a' }));
  });

  it('a redirect on the connection\'s first request turns marker trust off', async () => {
    const urls: string[] = [];
    stubHome((rpc, url) => {
      if (rpc.method === 'initialize') urls.push(url);
      if (rpc.method === 'initialize' && !url.endsWith('/moved')) return redirect(`${homeUrl}/moved`);
      return rpc.method === 'tools/call' ? markerError(rpc) : undefined;
    });
    const client = await connected(homeUrl);
    expect(urls).toEqual([homeUrl, `${homeUrl}/moved`]);
    await ordinaryMarkerError(client.callTool('read_note', { text: 'a' }));
  });

  it('a redirected 503 refusal turns marker trust off for later answers', async () => {
    let calls = 0;
    stubHome((rpc, url) => {
      if (rpc.method !== 'tools/call') return undefined;
      if (url.endsWith('/moved')) {
        return new Response(JSON.stringify(refusal.body), { status: refusal.status, headers: { 'content-type': 'application/json', ...refusal.headers } });
      }
      return calls++ === 0 ? redirect(`${homeUrl}/moved`) : markerError(rpc);
    });
    const client = await connected(homeUrl);
    const first = await client.callTool('read_note', { text: 'a' }).catch((caught: unknown) => caught);
    expect(first).not.toBeInstanceOf(PackageHomeRefusedError);
    expect(first).toMatchObject({ message: paused });
    await ordinaryMarkerError(client.callTool('read_note', { text: 'b' }));
  });
});

describe('a refusal leaves the connection as it was', () => {
  const forms: Array<[string, (rpc: Rpc) => Response]> = [
    ['the 503 refusal', () => new Response(JSON.stringify(refusal.body), { status: refusal.status, headers: { 'content-type': 'application/json', ...refusal.headers } })],
    ['the registry-closed marker', rpc => answerWith(rpc, { error: { code: -32603, message: 'MCP package registry is closed', data: marker } })],
  ];
  for (const [form, refuseCall] of forms) {
    it(`a call the cloud accepted survives a neighbour's refusal and the next lookup (${form})`, async () => {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let arrived!: () => void;
      const sent = new Promise<void>(resolve => { arrived = resolve; });
      stubHome(async rpc => {
        if (rpc.method !== 'tools/call') return undefined;
        if (rpc.params?.arguments?.text !== 'accepted') return refuseCall(rpc);
        arrived();
        await held;
        return answerWith(rpc, { result: { content: [{ type: 'text', text: 'ran accepted' }] } });
      });
      const registry = new PackageRegistry({
        mcpServers: { notebook: { command: '/must-never-run', name: 'Fictional Notes' } },
        packageHomes: { notebook: { url: homeUrl } },
      } as never);
      cleanup.push(() => registry.closeAll());
      const standalone = { kind: 'standalone' } as const;
      const accepted = registry.callTool('notebook', 'read_note', { text: 'accepted' }, standalone);
      await sent;
      await expect(registry.callTool('notebook', 'read_note', { text: 'refused' }, standalone)).rejects.toBeInstanceOf(PackageHomeRefusedError);
      await expect(registry.callTool('notebook', 'read_note', { text: 'also refused' }, standalone)).rejects.toBeInstanceOf(PackageHomeRefusedError);
      release();
      await expect(accepted).resolves.toEqual({ content: [{ type: 'text', text: 'ran accepted' }] });
    });
  }
});
