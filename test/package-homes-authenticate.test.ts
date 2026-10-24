import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PackageRegistry } from '../src/registry.js';
import { Catalog } from '../src/catalog.js';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import { OAuthCallbackServer } from '../src/auth/callbackServer.js';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import * as ports from '../src/utils/portFinder.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it('starts fresh HTTP authorization, sends zero refresh requests, and never caches the local session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'homes-auth-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv('SUPER_MCP_OAUTH_TOKEN_DIR', dir);
  vi.spyOn(ports, 'checkPortAvailable').mockResolvedValue(true);
  vi.spyOn(ports, 'findAvailablePortFromCandidates').mockResolvedValue(5173);
  vi.spyOn(OAuthCallbackServer.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(OAuthCallbackServer.prototype, 'stop').mockResolvedValue(undefined);
  let completeCallback: (code: string) => void;
  vi.spyOn(OAuthCallbackServer.prototype, 'waitForCallback').mockImplementation(() => new Promise(resolve => { completeCallback = resolve; }));
  const authorizations: URL[] = [];
  vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization').mockImplementation(async function (url) {
    (this as any).redirectStarted = true;
    authorizations.push(url);
    completeCallback('fictional-code');
  });
  await writeFile(path.join(dir, 'notebook_tokens.json'), JSON.stringify({ access_token: 'fictional-old-access', refresh_token: 'fictional-old-refresh', token_type: 'Bearer', expires_in: 1, __superMcpObtainedAtMs: 0 }));
  const grants: Array<string | null> = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const base = 'https://auth.example.test';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = (body: object) => Response.json(body);
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.includes('.well-known')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'] });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await request.text());
      grants.push(form.get('grant_type'));
      return json({ access_token: 'fictional-new-access', refresh_token: 'fictional-new-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (request.headers.get('authorization') !== 'Bearer fictional-new-access') return new Response('', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
    const body = request.method === 'POST' ? await request.clone().json() : undefined;
    let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (body?.method === 'initialize') {
      const server = new Server({ name: 'fictional-auth-service', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
      await server.connect(transport);
      cleanup.push(() => server.close());
    }
    if (!transport) return new Response('No session', { status: 404 });
    const response = await transport.handleRequest(request);
    const id = response.headers.get('mcp-session-id');
    if (id) sessions.set(id, transport);
    return response;
  });
  const registry = new PackageRegistry({ mcpServers: { notebook: { url: `${base}/mcp`, oauth: true, oauthClientId: 'fictional-client' } }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } });
  cleanup.push(() => registry.closeAll());
  const ambient = vi.spyOn(registry, 'getClient');
  const localClose = vi.spyOn(HttpMcpClient.prototype, 'close');
  const result = await handleAuthenticate({ package_id: 'notebook', force: false }, registry, new Catalog(registry));
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text).status).toBe('authenticated');
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0].searchParams.get('response_type')).toBe('code');
  expect(grants).toEqual(['authorization_code']);
  expect(ambient).not.toHaveBeenCalled();
  expect((registry as any).clients.has('notebook')).toBe(false);
  expect(localClose).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(path.join(dir, 'notebook_tokens.json'), 'utf8')).refresh_token).toBe('fictional-new-refresh');
}, 10_000);

it('delegates homed stdio authentication locally and closes that temporary client', async () => {
  const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'fictional-command' } }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } });
  cleanup.push(() => registry.closeAll());
  const connect = vi.spyOn(StdioMcpClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(StdioMcpClient.prototype, 'listTools').mockResolvedValue([{ name: 'authenticate', inputSchema: { type: 'object' } }]);
  const call = vi.spyOn(StdioMcpClient.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'started fresh' }] });
  const close = vi.spyOn(StdioMcpClient.prototype, 'close').mockResolvedValue(undefined);
  expect(await handleAuthenticate({ package_id: 'notebook' }, registry, new Catalog(registry))).toMatchObject({ content: [{ text: 'started fresh' }] });
  expect(connect).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledWith('authenticate', {});
  expect(close).toHaveBeenCalledOnce();
  expect((registry as any).clients.has('notebook')).toBe(false);
});
