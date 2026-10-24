import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PackageRegistry } from '../src/registry.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { Catalog } from '../src/catalog.js';
import { getValidator } from '../src/validator.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { handleReadResource } from '../src/handlers/readResource.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const rawTool = {
  name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { title: 'Write note', readOnlyHint: false, destructiveHint: false },
  _meta: { ui: { resourceUri: 'ui://notebook/view' }, fictional: { value: 7 } },
};
beforeEach(() => {
  vi.spyOn(StdioMcpClient.prototype, 'connect').mockImplementation(async function () {
    if ((this as any).config.command === '/must-never-run') throw new Error('Local spawn is forbidden');
  });
  vi.spyOn(StdioMcpClient.prototype, 'isTransportClosed').mockReturnValue(false);
  vi.spyOn(StdioMcpClient.prototype, 'listTools').mockResolvedValue([rawTool]);
  vi.spyOn(StdioMcpClient.prototype, 'callTool').mockImplementation(async (_name, args) => ({ content: [{ type: 'text', text: args.text }], _meta: { fictional: 'call-meta' } }));
  vi.spyOn(StdioMcpClient.prototype, 'listResources').mockResolvedValue({ resources: [{ uri: 'ui://notebook/view', name: 'view' }] });
  vi.spyOn(StdioMcpClient.prototype, 'readResource').mockImplementation(async uri => ({ contents: [{ uri, text: '<p>Fictional notebook</p>', _meta: { ui: { prefersBorder: true } } }], _meta: { fictional: 'resource-meta' } }));
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  setSecurityPolicy(new SecurityPolicy({}));
});
const entry = { command: process.execPath, args: [path.resolve('test/fixtures/package-home/server.mjs')], catalogId: 'fictional-notebook' };
const paused = "Your cloud isn't reachable, so Fictional Notes is paused for now. It'll pick up again when the cloud's back.";
function keep(registry: PackageRegistry) { cleanup.push(() => registry.closeAll()); return registry; }
function harness(cloud: PackageRegistry) {
  const requests: Request[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let loseResponse = false;
  const adapter = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const body = request.method === 'POST' ? await request.clone().json() : undefined;
    let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (body?.method === 'initialize') {
      const server = createPackageServer(cloud, 'notebook');
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
      await server.connect(transport);
      cleanup.push(() => server.close());
    }
    if (!transport) return new Response('Session not found', { status: 404 });
    const response = await transport.handleRequest(request);
    const id = response.headers.get('mcp-session-id');
    if (id) sessions.set(id, transport);
    if (loseResponse && body?.method === 'tools/call') {
      loseResponse = false;
      await response.body?.cancel();
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    }
    return response;
  };
  vi.stubGlobal('fetch', adapter);
  return { requests, loseNextCall: () => { loseResponse = true; } };
}
function desktop() {
  return keep(new PackageRegistry({
    mcpServers: { notebook: { command: '/must-never-run', name: 'Fictional Notes' } },
    packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook', headers: { Authorization: 'Bearer fictional' } } },
  }));
}

describe('package homes over in-memory streamable HTTP', () => {
  it('round-trips tools and MCP Apps through two real registries with raw metadata', async () => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    const { requests } = harness(cloud);
    const registry = desktop();
    const client = await registry.getClient('notebook');
    const [tool] = await client.listTools();
    expect(tool.name).toBe('write_note');
    expect(tool.inputSchema.required).toEqual(['text']);
    expect(tool.annotations).toEqual({ title: 'Write note', readOnlyHint: false, destructiveHint: false });
    expect(tool._meta).toEqual({ ui: { resourceUri: 'ui://notebook/view' }, fictional: { value: 7 } });
    expect(await registry.callTool('notebook', 'write_note', { text: 'hello' })).toMatchObject({ content: [{ text: 'hello' }], _meta: { fictional: 'call-meta' } });
    expect(await client.listResources!()).toMatchObject({ resources: [{ uri: 'ui://notebook/view' }] });
    expect(await client.readResource!('ui://notebook/view')).toMatchObject({ contents: [{ _meta: { ui: { prefersBorder: true } } }], _meta: { fictional: 'resource-meta' } });
    const catalog = new Catalog(registry);
    expect(await handleReadResource({ uri: 'ui://notebook/view', _meta: { rebel_packageId: 'notebook' } }, registry, catalog)).toMatchObject({ contents: [{ text: '<p>Fictional notebook</p>' }] });
    expect(requests.every(req => req.url === 'https://cloud.example.test/mcp/packages/notebook' && req.headers.get('authorization') === 'Bearer fictional')).toBe(true);
    expect(registry.getPackage('notebook')?.command).toBe('/must-never-run');
  });

  it('uses no local stdio process or original HTTP session', async () => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    harness(cloud);
    await cloud.getClient('notebook');
    const spawn = vi.spyOn(StdioMcpClient.prototype, 'connect').mockRejectedValue(new Error('Local spawn is forbidden'));
    await (await desktop().getClient('notebook')).listTools();
    expect(spawn).not.toHaveBeenCalled();
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: { url: 'https://original.example.test/mcp', oauth: true } }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await (await registry.getClient('notebook')).listTools();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('original.example.test'))).toBe(false);
  });

  it('never replays a possibly executed call and resumes on the next call', async () => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    const upstream = await cloud.getClient('notebook');
    const dispatched = vi.spyOn(upstream, 'callTool');
    const adapter = harness(cloud);
    const registry = desktop();
    adapter.loseNextCall();
    await expect(registry.callTool('notebook', 'write_note', { text: 'once' })).rejects.toThrow(paused);
    expect(dispatched).toHaveBeenCalledOnce();
    expect(await registry.callTool('notebook', 'write_note', { text: 'next call' })).toMatchObject({ content: [{ text: 'next call' }] });
    expect(dispatched).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504, 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', -32001])('pauses for home failure %s', async failure => {
    vi.stubGlobal('fetch', async () => {
      if (typeof failure === 'number' && failure > 0) return new Response('Unavailable', { status: failure });
      throw Object.assign(new Error('Connection failed'), { code: failure });
    });
    await expect(desktop().callTool('notebook', 'write_note', {})).rejects.toThrow(paused);
  });

  it('uses the paused message for the registry connection timeout without retrying', async () => {
    vi.stubEnv('SUPER_MCP_CONNECT_TIMEOUT_MS', '20');
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    await expect(desktop().callTool('notebook', 'write_note', {})).rejects.toThrow(paused);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('merges homes by package with the later config taking precedence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homes-merge-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const base = path.join(dir, 'base.json');
    const overlay = path.join(dir, 'overlay.json');
    await writeFile(base, JSON.stringify({ mcpServers: { notebook: entry, journal: entry }, packageHomes: { notebook: { url: 'https://old.example.test/mcp' }, journal: { url: 'https://journal.example.test/mcp' } } }));
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } }));
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    const { requests } = harness(cloud);
    const registry = keep(await PackageRegistry.fromConfigFiles([base, overlay]));
    await registry.getClient('notebook');
    expect(registry.isPackageHomed('journal')).toBe(true);
    expect(requests[0].url).toBe('https://cloud.example.test/mcp/packages/notebook');
  });

  it('closes a local client still connecting when a home is added', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homes-pending-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    await cloud.getClient('notebook');
    harness(cloud);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    let finishConnect!: () => void;
    vi.mocked(StdioMcpClient.prototype.connect).mockImplementationOnce(() => new Promise<void>(resolve => { finishConnect = resolve; }));
    const closed = vi.spyOn(StdioMcpClient.prototype, 'close').mockImplementationOnce(async () => { finishConnect(); });
    const pending = registry.getClient('notebook');
    const rejection = expect(pending).rejects.toThrow('home changed');
    await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'));
    await writeFile(file, JSON.stringify({ mcpServers: { notebook: entry }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } }));
    await registry.refreshPackageEnvFromConfigFiles([file]);
    await rejection;
    expect(closed).toHaveBeenCalledOnce();
    expect(await registry.getClient('notebook')).not.toBeInstanceOf(StdioMcpClient);
  });

  it('stops an in-flight local call on a home switch without replaying it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homes-dispatch-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    await cloud.getClient('notebook');
    harness(cloud);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    const local = await registry.getClient('notebook');
    let rejectCall!: (error: Error) => void;
    const calls = vi.mocked(StdioMcpClient.prototype.callTool);
    calls.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCall = reject; }));
    vi.spyOn(local, 'close').mockImplementationOnce(async () => { rejectCall(new Error('Connection closed after dispatch')); });
    const pending = registry.callTool('notebook', 'write_note', { text: 'once' });
    const rejection = expect(pending).rejects.toThrow('closed after dispatch');
    await vi.waitFor(() => expect(rejectCall).toBeTypeOf('function'));
    await writeFile(file, JSON.stringify({ mcpServers: { notebook: entry }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } }));
    await registry.refreshPackageEnvFromConfigFiles([file]);
    await rejection;
    expect(calls).toHaveBeenCalledOnce();
    expect(await registry.callTool('notebook', 'write_note', { text: 'next call' })).toMatchObject({ content: [{ text: 'next call' }] });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('routes through the home even when only the local setup is incomplete', async () => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    harness(cloud);
    const registry = keep(new PackageRegistry({ mcpServers: { notebook: { command: '/must-never-run', setupStatus: { state: 'blocked', reason: 'missing_managed_credentials' } } }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } }));
    expect((await registry.connectForCatalog('notebook')).kind).toBe('connected');
    expect(await registry.callTool('notebook', 'write_note', { text: 'ready at home' })).toMatchObject({ content: [{ text: 'ready at home' }] });
  });

  it.each(['security', 'user', 'admin', 'package'])('shares the %s access decision with use_tool', async kind => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    harness(cloud);
    const registry = desktop();
    const policy = new SecurityPolicy(kind === 'security' ? { blockedTools: ['write_note'] } : kind === 'package' ? { blockedPackages: ['notebook'] } : {});
    if (kind === 'user') policy.setUserDisabledTools({ notebook: ['write_note'] });
    if (kind === 'admin') policy.setAdminDisabledTools({ 'fictional-notebook': ['write_note'] });
    setSecurityPolicy(policy);
    const client = await registry.getClient('notebook');
    const denied = await client.callTool('write_note', { text: 'blocked' });
    expect(denied.isError).toBe(true);
    await expect(handleUseTool({ package_id: 'notebook', tool_id: 'write_note', args: { text: 'blocked' } }, cloud, new Catalog(cloud), getValidator())).rejects.toMatchObject({ code: -33008 });
    expect(await client.listTools()).toEqual([]);
    if (kind !== 'package') expect((await client.listResources!()).resources).toEqual([]);
    await expect(client.readResource!('ui://notebook/view')).rejects.toThrow();
    setSecurityPolicy(new SecurityPolicy({}));
    expect(await client.callTool('write_note', { text: 'allowed' })).toMatchObject({ content: [{ text: 'allowed' }] });
    const allowed = await handleUseTool({ package_id: 'notebook', tool_id: 'write_note', args: { text: 'allowed' } }, cloud, new Catalog(cloud), getValidator());
    expect(allowed.isError).toBe(false);
  });

  it('keeps an allowed tool and its app resources usable under a tool allowlist', async () => {
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    harness(cloud);
    setSecurityPolicy(new SecurityPolicy({ allowedTools: ['write_note'] }));
    const client = await desktop().getClient('notebook');
    expect((await client.listResources!()).resources).toHaveLength(1);
    expect(await client.readResource!('ui://notebook/view')).toMatchObject({ contents: [{ text: '<p>Fictional notebook</p>' }] });
    expect(await client.callTool('write_note', { text: 'allowed' })).toMatchObject({ content: [{ text: 'allowed' }] });
  });

  it('changes only the selected package on home add, header change and removal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'homes-reload-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    const overlay = path.join(dir, 'homes.json');
    await writeFile(file, JSON.stringify({ mcpServers: { notebook: entry, journal: entry } }));
    await writeFile(overlay, '{}');
    const cloud = keep(new PackageRegistry({ mcpServers: { notebook: entry } }));
    const { requests } = harness(cloud);
    const registry = keep(await PackageRegistry.fromConfigFiles([file, overlay]));
    const local = await registry.getClient('notebook');
    const other = await registry.getClient('journal');
    const closeLocal = vi.spyOn(local, 'close');
    const closeOther = vi.spyOn(other, 'close');
    const home = { url: 'https://cloud.example.test/mcp/packages/notebook' };
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: home } }));
    await registry.refreshPackageEnvFromConfigFiles([file, overlay]);
    expect(closeLocal).toHaveBeenCalledOnce();
    const firstHome = await registry.getClient('notebook');
    const closeHome = vi.spyOn(firstHome, 'close');
    await writeFile(overlay, JSON.stringify({ packageHomes: { notebook: { ...home, headers: { Authorization: 'Bearer updated' } } } }));
    await registry.refreshPackageEnvFromConfigFiles([file, overlay]);
    expect(closeHome).toHaveBeenCalledOnce();
    expect(await registry.getClient('notebook')).not.toBe(firstHome);
    expect(requests.at(-1)!.headers.get('authorization')).toBe('Bearer updated');
    await writeFile(overlay, '{}');
    await registry.refreshPackageEnvFromConfigFiles([file, overlay]);
    expect(await registry.getClient('notebook')).toBeInstanceOf(StdioMcpClient);
    expect(await registry.getClient('journal')).toBe(other);
    expect(closeOther).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.notebook).toEqual(entry);
  });
});
