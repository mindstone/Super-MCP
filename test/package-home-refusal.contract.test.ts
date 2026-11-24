import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { PackageHomeRefusedError } from '../src/dispatchErrors.js';
import type { PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const refusal = JSON.parse(readFileSync(new URL('./fixtures/home-refusal-v1.json', import.meta.url), 'utf8'));
const marker = JSON.parse(readFileSync(new URL('./fixtures/registry-closed-v1.json', import.meta.url), 'utf8'));
const config: PackageConfig = { id: 'notes', name: 'Fictional Notes', transport: 'http', base_url: 'https://notes.example.com/mcp' };
type Rpc = { id?: number | string; method: string; params?: { arguments?: { text?: string } } };
const clients: PackageHomeClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const result = (rpc: Rpc, value: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: value }), {
  headers: { 'content-type': 'application/json' },
});
const answer = (rpc: Rpc) => ({ content: [{ type: 'text', text: `answer:${rpc.params?.arguments?.text}` }] });
const refused = (header = 'not-admitted; v=1', body = JSON.stringify(refusal.body)) => new Response(body, {
  status: refusal.status, headers: { 'content-type': 'application/json', 'rebel-admission': header },
});

// Loopback sockets are denied in this sandbox. Only fetch is stubbed; the SDK's
// client, protocol request correlation and Streamable HTTP transport remain real.
async function home(call: (rpc: Rpc) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init.body)) as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') return result(rpc, {
      protocolVersion: '2025-06-18', capabilities: { tools: {}, experimental: { 'rebel/homeMarkerGuard': { version: 1 } } }, serverInfo: { name: 'notes', version: '1' },
    });
    if (rpc.method === 'tools/call') return call(rpc);
    throw new Error(`Unexpected request: ${rpc.method}`);
  }));
  const client = new PackageHomeClient(config, { url: 'https://home.example.com/mcp/packages/notes' });
  clients.push(client);
  await client.connect();
  return client;
}

it('a refusal settles before another pending call without stealing its answer or disabling later calls', async () => {
  const pending = deferred<Response>();
  const arrived = deferred<Rpc>();
  const client = await home(rpc => {
    if (rpc.params?.arguments?.text === 'pending') { arrived.resolve(rpc); return pending.promise; }
    return rpc.params?.arguments?.text === 'refuse' ? refused() : result(rpc, answer(rpc));
  });
  const other = client.callTool('read_note', { text: 'pending' });
  const rpc = await arrived.promise;
  try {
    const error = await client.callTool('read_note', { text: 'refuse' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageHomeRefusedError);
    expect(error).toMatchObject({
      name: 'PackageHomeRefusedError', reason: 'shutting_down',
    });
  } finally {
    pending.resolve(result(rpc, answer(rpc)));
    await expect(other).resolves.toEqual(answer(rpc));
  }
  await expect(client.callTool('read_note', { text: 'later' })).resolves.toEqual({ content: [{ type: 'text', text: 'answer:later' }] });
});

it('header value case or interior spacing and malformed JSON retain the original 503 cause', async () => {
  const replies = [refused('Not-Admitted; v=1'), refused('not-admitted;  v=1'), refused('not-admitted; v=1', '{broken-json')];
  const bodies = await Promise.all(replies.map(response => response.clone().text()));
  const client = await home(() => replies.shift()!);
  for (const body of bodies) {
    const error = await client.callTool('read_note', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PackageHomeRefusedError);
    expect(error).toMatchObject({ message: expect.stringContaining("Your cloud isn't reachable"), cause: expect.any(StreamableHTTPError) });
    expect((error as Error).cause).toMatchObject({ code: 503, message: expect.stringContaining(body) });
  }
});

it('only the v1 registry marker on a call error is converted, preserving unknown-version code and data', async () => {
  const client = await home(rpc => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: {
    code: -32603, message: 'Registry is closed', data: rpc.params?.arguments?.text === 'known'
      ? marker : { ...marker, rebelHome: { ...marker.rebelHome, v: 2 }, detail: 'retain me' },
  } }), { headers: { 'content-type': 'application/json' } }));
  await expect(client.callTool('read_note', { text: 'known' })).rejects.toBeInstanceOf(PackageHomeRefusedError);
  const error = await client.callTool('read_note', { text: 'unknown' }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpError);
  expect(error).toMatchObject({ code: -32603, data: { rebelHome: { v: 2, disposition: 'registry_closed' }, detail: 'retain me' } });
});
