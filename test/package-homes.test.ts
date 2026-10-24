import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PackageRegistry } from '../src/registry.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { getValidator } from '../src/validator.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  setSecurityPolicy(new SecurityPolicy({}));
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'package-homes-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function keep(registry: PackageRegistry) {
  cleanup.push(() => registry.closeAll());
  return registry;
}
async function router(extra: object = {}) {
  const dir = await temp();
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const config = path.join(dir, 'config.json');
  const entry = { command: process.execPath, args: [path.resolve('test/fixtures/package-home/server.mjs')], catalogId: 'fictional-notebook' };
  await writeFile(config, JSON.stringify({ mcpServers: { notebook: entry, journal: entry }, ...extra }));
  const child = spawn(process.execPath, ['dist/cli.js', '--config', config, '--transport', 'http', '--port', String(port), '--log-level', 'error'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr!.on('data', data => { output += data; });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const base = `http://127.0.0.1:${port}`;
  await vi.waitFor(async () => {
    if (child.exitCode !== null) throw new Error(output);
    expect((await fetch(`${base}/health`)).ok).toBe(true);
  }, { timeout: 15_000 });
  return base;
}
async function rawClient(url: string) {
  const client = new Client({ name: 'fictional-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { client, transport };
}
const paused = "Your cloud isn't reachable, so Fictional Notes is paused for now. It'll pick up again when the cloud's back.";


// fetch() drops a caller-set Host header, so the rebinding check needs a raw request.
function statusWithHost(url: string, host: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { ...headers, host } }, response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('package homes and raw package endpoint', () => {
  it('forwards tool discovery, calls and resources through a real second registry without starting stdio locally', async () => {
    const base = await router();
    const localSpawn = vi.spyOn(StdioMcpClient.prototype, 'connect').mockRejectedValue(new Error('Local spawn is forbidden'));
    const registry = keep(new PackageRegistry({
      mcpServers: { notebook: { name: 'Fictional Notes', command: '/must-never-run' } },
      packageHomes: { notebook: { url: `${base}/mcp/packages/notebook` } },
    }));
    const client = await registry.getClient('notebook');
    const [tool] = await client.listTools();
    expect(tool.name).toBe('write_note');
    expect(tool.inputSchema.required).toEqual(['text']);
    expect(tool.annotations).toEqual({ title: 'Write note', readOnlyHint: false, destructiveHint: false });
    expect(tool._meta).toEqual({ ui: { resourceUri: 'ui://notebook/view' }, fictional: { value: 7 } });
    expect(await registry.callTool('notebook', 'write_note', { text: 'hello' })).toMatchObject({ content: [{ text: 'hello' }], _meta: { fictional: 'call-meta' } });
    expect(await client.listResources!()).toMatchObject({ resources: [{ uri: 'ui://notebook/view' }] });
    expect(await client.readResource!('ui://notebook/view')).toMatchObject({ contents: [{ text: '<p>Fictional notebook</p>', _meta: { ui: { prefersBorder: true } } }], _meta: { fictional: 'resource-meta' } });
    expect(localSpawn).not.toHaveBeenCalled();
    expect(registry.getPackage('notebook')?.transport).toBe('stdio');
  }, 25_000);

  it('starts no session to the original HTTP server and sends the home headers', async () => {
    const base = await router();
    let connections = 0;
    const original = http.createServer((_req, res) => { res.writeHead(500).end(); });
    original.on('connection', () => { connections++; });
    const origin = await listen(original);
    const seenHeaders: string[] = [];
    const home = http.createServer(async (req, res) => {
      seenHeaders.push(String(req.headers.authorization));
      const response = await fetch(`${base}/mcp/packages/notebook`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? await new Promise<string>(resolve => { let body = ''; req.on('data', data => body += data); req.on('end', () => resolve(body)); }) : undefined });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // Closing the optional SSE stream is sufficient for this discovery test.
      if (req.method === 'GET') { await response.body?.cancel(); res.end(); return; }
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    const homeUrl = await listen(home);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: { url: origin, oauth: true } }, packageHomes: { notebook: { url: homeUrl, headers: { Authorization: 'Bearer fictional-home' } } } }));
    expect((await (await registry.getClient('notebook')).listTools())[0].name).toBe('write_note');
    expect(connections).toBe(0);
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders.every(value => value === 'Bearer fictional-home')).toBe(true);
  }, 25_000);

  it('binds sessions to the package and refuses unknown or homed packages and invalid hosts', async () => {
    const base = await router({ packageHomes: { journal: { url: 'http://127.0.0.1:1/mcp' } } });
    const { transport } = await rawClient(`${base}/mcp/packages/notebook`);
    const headers = { 'mcp-session-id': transport.sessionId!, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await fetch(`${base}/mcp/packages/missing`, { method: 'POST', headers, body })).status).toBe(404);
    expect((await fetch(`${base}/mcp/packages/journal`, { method: 'POST', headers, body })).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers, body })).status).toBe(404);
    expect(await statusWithHost(`${base}/mcp/packages/notebook`, 'evil.example.test', headers, body)).toBe(403);
    expect((await fetch(`${base}/mcp/packages/notebook`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body })).status).toBe(415);
    const other = await router();
    const session = await rawClient(`${other}/mcp/packages/notebook`);
    expect((await fetch(`${other}/mcp/packages/journal`, { method: 'POST', headers: { ...headers, 'mcp-session-id': session.transport.sessionId! }, body })).status).toBe(404);
    expect((await fetch(`${other}/mcp/packages/journal`, { method: 'POST', headers: { ...headers, 'mcp-session-id': session.transport.sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }) })).status).toBe(404);
  }, 25_000);

  it.each([
    { security: { blockedTools: ['write_note'] } },
    { userDisabledToolsByServer: { notebook: ['write_note'] } },
    { adminDisabledToolsByCatalogId: { 'fictional-notebook': ['write_note'] } },
    { security: { blockedPackages: ['notebook'] } },
  ])('enforces the same restriction as use_tool: %j', async restrictions => {
    const base = await router(restrictions);
    const { client } = await rawClient(`${base}/mcp/packages/notebook`);
    expect((await client.callTool({ name: 'write_note', arguments: { text: 'blocked' } })).isError).toBe(true);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: { command: 'unused', catalogId: 'fictional-notebook' } } }));
    const policy = new SecurityPolicy(restrictions.security ?? {});
    policy.setUserDisabledTools(restrictions.userDisabledToolsByServer ?? {});
    policy.setAdminDisabledTools(restrictions.adminDisabledToolsByCatalogId ?? {});
    setSecurityPolicy(policy);
    await expect(handleUseTool({ package_id: 'notebook', tool_id: 'write_note', args: { text: 'blocked' } }, registry, new Catalog(registry), getValidator())).rejects.toMatchObject({ code: -33008 });
    expect((await client.listTools()).tools).toEqual([]);
  }, 25_000);

  it('returns the paused message for a refused connection and 502/503/504', async () => {
    const refusal = http.createServer();
    refusal.listen(0, '127.0.0.1'); await once(refusal, 'listening');
    const port = (refusal.address() as { port: number }).port;
    await new Promise<void>(resolve => refusal.close(() => resolve()));
    for (const status of [0, 502, 503, 504]) {
      const url = status === 0 ? `http://127.0.0.1:${port}` : await listen(http.createServer((_req, res) => res.writeHead(status).end()));
      const registry = keep(new PackageRegistry({ mcpServers: { notebook: { name: 'Fictional Notes', command: 'unused' } }, packageHomes: { notebook: { url } } }));
      await expect(registry.callTool('notebook', 'write_note', {})).rejects.toThrow(paused);
    }
  });

  it('does not replay a call whose response is lost after execution', async () => {
    const base = await router();
    let executions = 0;
    const proxy = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const response = await fetch(`${base}/mcp/packages/notebook`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? body : undefined });
      if (body.includes('tools/call')) { executions++; await response.body?.cancel(); res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (req.method === 'GET') { await response.body?.cancel(); res.end(); return; }
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    const url = await listen(proxy);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: { name: 'Fictional Notes', command: 'unused' } }, packageHomes: { notebook: { url } } }));
    await expect(registry.callTool('notebook', 'write_note', { text: 'run once' })).rejects.toThrow(paused);
    expect(executions).toBe(1);
  }, 25_000);

  it('merges homes with later files winning and incrementally changes only the affected package', async () => {
    const base = await router();
    const dir = await temp();
    const configPath = path.join(dir, 'config.json');
    const overlay = path.join(dir, 'overlay.json');
    const entry = { command: process.execPath, args: [path.resolve('test/fixtures/package-home/server.mjs')] };
    await writeFile(configPath, JSON.stringify({ mcpServers: { notebook: entry, journal: entry }, packageHomes: { notebook: { url: 'http://127.0.0.1:1' } } }));
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: { url: `${base}/mcp/packages/notebook` } } }));
    const registry = keep(await PackageRegistry.fromConfigFiles([configPath, overlay]));
    const homeClient = await registry.getClient('notebook');
    const otherClient = await registry.getClient('journal');
    const otherClose = vi.spyOn(otherClient, 'close');
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: { url: `${base}/mcp/packages/notebook`, headers: { Authorization: 'Bearer new-fictional-value' } } } }));
    await registry.refreshPackageEnvFromConfigFiles([configPath, overlay]);
    expect(await registry.getClient('notebook')).not.toBe(homeClient);
    await writeFile(configPath, JSON.stringify({ mcpServers: { notebook: entry, journal: entry } }));
    await writeFile(overlay, '{}');
    await registry.refreshPackageEnvFromConfigFiles([configPath, overlay]);
    const local = await registry.getClient('notebook');
    expect(local).toBeInstanceOf(StdioMcpClient);
    const localClose = vi.spyOn(local, 'close');
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: { url: `${base}/mcp/packages/notebook` } } }));
    await registry.refreshPackageEnvFromConfigFiles([configPath, overlay]);
    expect(localClose).toHaveBeenCalledOnce();
    expect(await registry.getClient('notebook')).not.toBeInstanceOf(StdioMcpClient);
    expect(await registry.getClient('journal')).toBe(otherClient);
    expect(otherClose).not.toHaveBeenCalled();
  }, 25_000);

  it('contains no provider or connector names in new mechanism files', async () => {
    const denied = /notion|google|slack|hubspot|microsoft|granola|fireflies|salesforce|zendesk|quickbooks|workday/i;
    for (const file of ['src/packageEndpoint.ts', 'src/clients/packageHomeClient.ts', 'src/toolAccess.ts']) {
      expect(await readFile(file, 'utf8'), file).not.toMatch(denied);
    }
  });
});
