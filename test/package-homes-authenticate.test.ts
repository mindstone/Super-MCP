import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { RefreshOnlyOAuthProvider } from '../src/auth/providers/refreshOnly.js';
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

it('replaces a saved dynamic registration with both grants on forced sign-in', async () => {
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
  await writeFile(path.join(dir, 'notebook_client.json'), JSON.stringify({ client_id: 'fictional-old-client', redirect_uris: ['http://localhost:5173/oauth/callback'], grant_types: ['authorization_code'] }));
  const registrations: Record<string, unknown>[] = [];
  const grants: Array<string | null> = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const base = 'https://auth.example.test';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = (body: object) => Response.json(body);
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.includes('.well-known')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'] });
    if (url.pathname === '/register' && request.method === 'POST') {
      const metadata = await request.json();
      registrations.push(metadata);
      return json({ ...metadata, client_id: 'fictional-new-client' });
    }
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
  const registry = new PackageRegistry({ mcpServers: { notebook: { url: `${base}/mcp`, oauth: true } }, packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook' } } });
  cleanup.push(() => registry.closeAll());
  const ambient = vi.spyOn(registry, 'getClient');
  const localClose = vi.spyOn(HttpMcpClient.prototype, 'close');
  const result = await handleAuthenticate({ package_id: 'notebook', force: true }, registry, new Catalog(registry));
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text).status).toBe('authenticated');
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0].searchParams.get('response_type')).toBe('code');
  expect(grants).toEqual(['authorization_code']);
  expect(registrations).toHaveLength(1);
  expect(registrations[0].token_endpoint_auth_method).toBe('none');
  const savedClient = JSON.parse(await readFile(path.join(dir, 'notebook_client.json'), 'utf8'));
  expect(savedClient.client_id).toBe('fictional-new-client');
  expect(registrations[0].grant_types).toEqual(['authorization_code', 'refresh_token']);
  expect(savedClient.grant_types).toEqual(['authorization_code', 'refresh_token']);
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
  expect(call).toHaveBeenCalledWith('authenticate', {}, { readMode: { version: 1, mode: 'standalone' } });
  expect(close).toHaveBeenCalledOnce();
  expect((registry as any).clients.has('notebook')).toBe(false);
});

// Real installed SDK, fail-closed synthetic fetch, and the normal handler producer.
// The endpoint's invalid_client response is independent of the registration policy.
async function oauthFixture(options: {
  methods?: string[];
  returnedBasic?: boolean;
  staticClient?: boolean;
  savedClient?: boolean;
  rejectFirst?: boolean;
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'public-client-auth-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv('SUPER_MCP_OAUTH_TOKEN_DIR', dir);
  const base = 'https://auth.example.test';
  const packageId = 'fictional-public-client';
  const redirectUri = 'http://localhost:5173/oauth/callback';
  const registrations: Record<string, unknown>[] = [];
  const authorizations: URL[] = [];
  const callbacks: Array<{ state: string | undefined; code: string }> = [];
  const tokenPosts: Array<{ clientId: string; code: string | null; verifier: string | null; basic: boolean }> = [];
  const clients = new Map<string, { method: string; secret?: string }>();
  const configured = { clientId: 'fictional-configured-client', clientSecret: 'fictional-configured-secret' };
  if (options.staticClient) clients.set(configured.clientId, { method: 'client_secret_basic', secret: configured.clientSecret });
  if (options.savedClient) {
    clients.set('fictional-saved-client', { method: 'client_secret_basic', secret: 'fictional-saved-secret' });
    await writeFile(path.join(dir, `${packageId}_client.json`), JSON.stringify({
      client_id: 'fictional-saved-client', client_secret: 'fictional-saved-secret',
      token_endpoint_auth_method: 'client_secret_basic', issuer: base,
      redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      client_id_issued_at: 123,
    }));
  }
  const findPort = vi.spyOn(ports, 'findAvailablePortFromCandidates').mockResolvedValue(5173);
  vi.spyOn(ports, 'checkPortAvailable').mockResolvedValue(true);
  vi.spyOn(OAuthCallbackServer.prototype, 'start').mockResolvedValue(undefined);
  const stop = vi.spyOn(OAuthCallbackServer.prototype, 'stop').mockResolvedValue(undefined);
  let completeCallback: (code: string) => void;
  let expectedState: string | undefined;
  vi.spyOn(OAuthCallbackServer.prototype, 'waitForCallback').mockImplementation((_timeout, state) => {
    expectedState = state;
    return new Promise(resolve => { completeCallback = resolve; });
  });
  const browser = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization').mockImplementation(async function (url) {
    expect(url.searchParams.get('state')).toBe(expectedState);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(`${base}/mcp`);
    expect(url.searchParams.get('scope')).toBe('notes:read');
    (this as any).redirectStarted = true;
    authorizations.push(url);
    const code = `fictional-code-${authorizations.length}`;
    callbacks.push({ state: expectedState, code });
    completeCallback(code);
  });
  const invalidate = vi.spyOn(SimpleOAuthProvider.prototype, 'invalidateCredentials');
  const close = vi.spyOn(HttpMcpClient.prototype, 'close');
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base) throw new Error('Unexpected synthetic fetch origin');
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['notes:read'] });
    if (url.pathname.includes('.well-known')) return Response.json({
      issuer: base, authorization_endpoint: `${base}/authorize`, registration_endpoint: `${base}/register`,
      token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      ...(options.methods === undefined ? {} : { token_endpoint_auth_methods_supported: options.methods }),
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    if (url.pathname === '/register' && request.method === 'POST') {
      const metadata = await request.json();
      registrations.push(metadata);
      const method = options.returnedBasic ? 'client_secret_basic' : metadata.token_endpoint_auth_method ?? 'client_secret_basic';
      const clientId = `fictional-dynamic-${registrations.length}`;
      const secret = method === 'none' ? undefined : 'fictional-dynamic-secret';
      clients.set(clientId, { method, secret });
      return Response.json({ ...metadata, client_id: clientId, token_endpoint_auth_method: method,
        ...(secret ? { client_secret: secret } : {}), client_id_issued_at: 123 });
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const authorization = request.headers.get('authorization');
      const basic = authorization?.startsWith('Basic ') === true;
      const [basicId, basicSecret] = basic ? Buffer.from(authorization!.slice(6), 'base64').toString().split(':') : [];
      const clientId = basicId ?? form.get('client_id')!;
      const registered = clients.get(clientId);
      const authorize = authorizations.find(url => url.searchParams.get('client_id') === clientId && callbacks[authorizations.indexOf(url)].code === form.get('code'));
      const verifier = form.get('code_verifier');
      expect(registered).toBeDefined();
      expect(authorize).toBeDefined();
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('redirect_uri')).toBe(authorize!.searchParams.get('redirect_uri'));
      expect(form.get('resource')).toBe(`${base}/mcp`);
      expect(verifier).toBeTruthy();
      expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(authorize!.searchParams.get('code_challenge'));
      expect(basic ? basicSecret : form.get('client_secret')).toBe(registered!.secret ?? null);
      tokenPosts.push({ clientId, code: form.get('code'), verifier, basic });
      if ((options.rejectFirst && tokenPosts.length === 1) || basic !== (registered!.method === 'client_secret_basic')) {
        return Response.json({ error: 'invalid_client', error_description: 'fictional-private-token-description' }, { status: 401 });
      }
      return Response.json({ access_token: 'fictional-new-access', refresh_token: 'fictional-new-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname !== '/mcp') throw new Error('Unexpected synthetic fetch path');
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
  const registry = new PackageRegistry({ mcpServers: { [packageId]: { url: `${base}/mcp`, oauth: true,
    ...(options.staticClient ? { oauthClientId: configured.clientId, oauthClientSecret: configured.clientSecret } : {}) } } });
  cleanup.push(() => registry.closeAll());
  // Skip only the ambient precheck: Connect itself uses the real client/SDK.
  vi.spyOn(registry, 'getClient').mockRejectedValue(new Error('Synthetic disconnected client'));
  const connect = () => handleAuthenticate({ package_id: packageId, wait_for_completion: true }, registry, new Catalog(registry));
  return { dir, packageId, configured, registrations, authorizations, callbacks, tokenPosts, findPort, stop, browser, invalidate, close, registry, connect };
}

it.each([
  { label: 'none-only', methods: ['none'], expected: 'none' },
  { label: 'mixed', methods: ['client_secret_basic', 'none'], expected: 'none' },
  { label: 'confidential-only', methods: ['client_secret_basic'], expected: undefined },
  { label: 'missing methods', methods: undefined, expected: undefined },
])('uses advertised registration policy for $label with the real SDK', async ({ methods, expected }) => {
  const fixture = await oauthFixture({ methods });
  const result = await fixture.connect();
  expect(fixture.registrations).toHaveLength(1);
  expect(fixture.registrations[0].token_endpoint_auth_method).toBe(expected);
  expect(JSON.parse(result.content[0].text).status).toBe('authenticated');
  expect(fixture.tokenPosts).toHaveLength(1);
  expect(fixture.tokenPosts[0].basic).toBe(expected !== 'none');
  const tokens = JSON.parse(await readFile(path.join(fixture.dir, `${fixture.packageId}_tokens.json`), 'utf8'));
  expect(tokens).toMatchObject({ refresh_token: 'fictional-new-refresh', issuer: 'https://auth.example.test' });
}, 10_000);

it.each(['returned basic', 'saved confidential', 'configured static'])('preserves %s identity and SDK token authentication', async (kind) => {
  const fixture = await oauthFixture({ methods: ['none', 'client_secret_basic'],
    returnedBasic: kind === 'returned basic', savedClient: kind === 'saved confidential', staticClient: kind === 'configured static' });
  expect(JSON.parse((await fixture.connect()).content[0].text).status).toBe('authenticated');
  expect(fixture.registrations).toHaveLength(kind === 'returned basic' ? 1 : 0);
  expect(fixture.tokenPosts).toHaveLength(1);
  expect(fixture.tokenPosts[0].basic).toBe(true);
  if (kind === 'returned basic') {
    expect(fixture.registrations[0].token_endpoint_auth_method).toBe('none');
    expect(JSON.parse(await readFile(path.join(fixture.dir, `${fixture.packageId}_client.json`), 'utf8')))
      .toMatchObject({ client_secret: 'fictional-dynamic-secret', token_endpoint_auth_method: 'client_secret_basic', client_id_issued_at: 123 });
  }
}, 10_000);

it.each([false, true])('ends a real SDK client rejection honestly and a new explicit Connect succeeds (static=%s)', async (staticClient) => {
  const fixture = await oauthFixture({ methods: ['none', 'client_secret_basic'], staticClient, rejectFirst: true });
  const first = await fixture.connect();
  expect(first.isError).toBe(false);
  expect(JSON.parse(first.content[0].text)).toEqual({ package_id: fixture.packageId, status: 'error',
    error: "Sign-in couldn't finish. Please try connecting again.", message: 'OAUTH_CLIENT_REJECTED' });
  expect(fixture.tokenPosts).toHaveLength(1);
  expect(fixture.invalidate).toHaveBeenCalledWith('all');
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect((fixture.registry as any).clients.has(fixture.packageId)).toBe(false);
  expect(fixture.browser).toHaveBeenCalledOnce();
  expect(fixture.findPort).toHaveBeenCalledOnce();
  expect(fixture.registrations).toHaveLength(staticClient ? 0 : 1);
  if (!staticClient) await expect(readFile(path.join(fixture.dir, `${fixture.packageId}_client.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(fixture.dir, `${fixture.packageId}_tokens.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  const second = await fixture.connect();
  expect(JSON.parse(second.content[0].text).status).toBe('authenticated');
  expect(fixture.registrations).toHaveLength(staticClient ? 0 : 2);
  expect(fixture.tokenPosts).toHaveLength(2);
  expect(fixture.browser).toHaveBeenCalledTimes(2);
  expect(fixture.stop).toHaveBeenCalledTimes(2);
  expect(fixture.tokenPosts[0].clientId === fixture.tokenPosts[1].clientId).toBe(staticClient);
  expect(fixture.tokenPosts[0].code).not.toBe(fixture.tokenPosts[1].code);
  expect(fixture.tokenPosts[0].verifier).not.toBe(fixture.tokenPosts[1].verifier);
  expect(fixture.callbacks[0].state).not.toBe(fixture.callbacks[1].state);
}, 10_000);

it('forwards real SDK discovery through refresh-only registration but never opens a browser', async () => {
  const fixture = await oauthFixture({ methods: ['none'] });
  const provider = new SimpleOAuthProvider(fixture.packageId, 5173);
  await provider.initialize();
  await expect(auth(new RefreshOnlyOAuthProvider(provider), { serverUrl: 'https://auth.example.test/mcp' }))
    .rejects.toMatchObject({ name: 'RefreshOnlyAuthenticationRequiredError' });
  expect(fixture.registrations).toHaveLength(1);
  expect(fixture.registrations[0].token_endpoint_auth_method).toBe('none');
  expect(fixture.browser).not.toHaveBeenCalled();
  expect(fixture.tokenPosts).toHaveLength(0);
});
