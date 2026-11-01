import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { handleHealthCheckPackage } from '../src/handlers/healthCheckPackage.js';
import { FINISH_AUTH_TIMEOUT_MS, HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import { PackageRegistry } from '../src/registry.js';
import type { Catalog } from '../src/catalog.js';
import { OAUTH_PROVIDER_ERROR_CODE } from '../src/auth/callbackServer.js';

const callback = vi.hoisted(() => ({
  start: vi.fn(async () => {}), stop: vi.fn(async () => {}), setServiceId: vi.fn(),
  waitForCallback: vi.fn<(timeout: number, state: string) => Promise<string>>(),
  resolve: undefined as ((code: string) => void) | undefined,
  reject: undefined as ((error: Error) => void) | undefined,
}));
vi.mock('../src/logging.js', () => ({ getLogger: () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}) }));
vi.mock('../src/utils/portFinder.js', async (original) => ({
  ...await original<typeof import('../src/utils/portFinder.js')>(),
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
}));
vi.mock('../src/auth/callbackServer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/callbackServer.js')>()),
  OAuthCallbackServer: function () { return callback; },
}));

const pkg = { id: 'tarrowline-wiki', name: 'tarrowline-wiki', transport: 'http' as const,
  base_url: 'https://mcp.example.com/mcp', visibility: 'default' as const };
const catalog = { clearPackage: vi.fn(), getPackageStatus: () => 'unknown' } as unknown as Catalog;
const parse = (result: any) => JSON.parse(result.content[0].text);

describe('authentication bootstrap settlement', () => {
  let tokenDir: string;
  let previousTokenDir: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-bootstrap-'));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
    callback.resolve = undefined;
    callback.reject = undefined;
    callback.start.mockImplementation(async () => {});
    callback.stop.mockImplementation(async () => {});
    callback.waitForCallback.mockImplementation(() => new Promise((resolve, reject) => {
      callback.resolve = resolve;
      callback.reject = reject;
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (previousTokenDir === undefined) delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    else process.env.SUPER_MCP_OAUTH_TOKEN_DIR = previousTokenDir;
    await fs.rm(tokenDir, { recursive: true, force: true });
  });

  function registry() {
    return {
      getPackage: () => pkg, clients: new Map<string, HttpMcpClient>(),
      getClient: vi.fn(async (): Promise<HttpMcpClient> => { throw new Error('connect ECONNREFUSED'); }),
      healthCheckWithClient: PackageRegistry.prototype.healthCheckWithClient,
      healthCheck: PackageRegistry.prototype.healthCheck,
    } as unknown as PackageRegistry & { clients: Map<string, HttpMcpClient> };
  }

  function mockLateChallengeFetch(hangTokenExchange = false) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/oauth-authorization-server')) return Response.json({
        issuer: 'https://mcp.example.com', authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token', registration_endpoint: 'https://mcp.example.com/register',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      });
      if (url.endsWith('/register')) return Response.json({
        client_id: 'fictional-client', redirect_uris: JSON.parse(String(init?.body)).redirect_uris,
      }, { status: 201 });
      if (new URL(url).pathname === '/authorize') return new Response('Callback URL mismatch', { status: 400 });
      if (url.endsWith('/token') && hangTokenExchange) return new Promise<Response>(() => {});
      if (url.endsWith('/mcp')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (body?.method === 'tools/list') return new Response('Unauthorized', {
          status: 401, headers: { 'www-authenticate': 'Bearer' },
        });
        if (body?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fictional', version: '1' },
        } });
        return new Response(null, { status: init?.method === 'POST' ? 202 : 405 });
      }
      return new Response(null, { status: 404 });
    });
  }

  it('closes and evicts a tools/list sign-in attempt after declined consent so ordinary health cannot redirect again', async () => {
    mockLateChallengeFetch();
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization')
      .mockImplementation(async function (this: SimpleOAuthProvider) {
        Reflect.set(this, 'redirectStarted', true);
        callback.reject?.(Object.assign(new Error('OAuth error: access_denied'), { code: OAUTH_PROVIDER_ERROR_CODE }));
      });
    const close = vi.spyOn(HttpMcpClient.prototype, 'close');
    const reg = registry();
    // Let an ordinary health check reuse any cached client, exposing leaked interactive auth.
    vi.mocked(reg.getClient).mockImplementation(async () => reg.clients.get(pkg.id) ?? new HttpMcpClient(pkg.id, pkg));
    try {
      const result = parse(await handleAuthenticate({ package_id: pkg.id, force: true }, reg, catalog));
      expect(result).toEqual({ package_id: pkg.id, status: 'error', error: 'OAuth error: access_denied' });
      expect(redirect).toHaveBeenCalledOnce();
      expect(callback.stop).toHaveBeenCalledOnce();
      await handleHealthCheckPackage({ package_id: pkg.id }, reg, catalog);
      expect(redirect).toHaveBeenCalledOnce();
      expect(reg.clients.has(pkg.id)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    } finally { await reg.clients.get(pkg.id)?.close(); }
  });

  it.each(['callback', 'token-exchange'])('closes a late-challenge attempt after %s timeout so ordinary health cannot redirect again', async (timeout) => {
    mockLateChallengeFetch(timeout === 'token-exchange');
    const realSetTimeout = globalThis.setTimeout;
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization')
      .mockImplementation(async function (this: SimpleOAuthProvider) {
        Reflect.set(this, 'redirectStarted', true);
        if (timeout === 'callback') callback.reject?.(new Error('OAuth callback timeout'));
        else {
          // Bootstrap has connected; shorten only the remaining exchange budget.
          vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, delay, ...args) =>
            realSetTimeout(handler, delay === FINISH_AUTH_TIMEOUT_MS ? 10 : delay, ...args)
          ) as typeof setTimeout);
          callback.resolve?.('fictional-code');
        }
      });
    const close = vi.spyOn(HttpMcpClient.prototype, 'close');
    const reg = registry();
    vi.mocked(reg.getClient).mockImplementation(async () => reg.clients.get(pkg.id) ?? new HttpMcpClient(pkg.id, pkg));
    try {
      const result = parse(await handleAuthenticate({ package_id: pkg.id, force: true }, reg, catalog));
      expect(result.status).toBe(timeout === 'callback' ? 'auth_required' : 'error');
      if (timeout === 'token-exchange') expect(result.message).toContain('OAuth token exchange timed out');
      expect(callback.stop).toHaveBeenCalledOnce();
      const requests = vi.mocked(globalThis.fetch).mock.calls.length;
      await handleHealthCheckPackage({ package_id: pkg.id }, reg, catalog);
      expect(redirect).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledTimes(requests);
      expect(close).toHaveBeenCalledOnce();
      const closedClient = close.mock.contexts[0];
      expect(await closedClient.healthCheck()).toBe('needs_auth');
      expect(globalThis.fetch).toHaveBeenCalledTimes(requests);
      expect(reg.clients.get(pkg.id)).toBe(timeout === 'callback' ? closedClient : undefined);
    } finally { await reg.clients.get(pkg.id)?.close(); }
  });

  it('discards a rejected access-token-only attempt so ordinary health cannot redirect again', async () => {
    mockLateChallengeFetch();
    const lateChallengeFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/token')) return Response.json({
        access_token: 'fictional-token', token_type: 'Bearer', expires_in: 3600,
      });
      return lateChallengeFetch(input, init);
    });
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization')
      .mockImplementation(async function (this: SimpleOAuthProvider) {
        Reflect.set(this, 'redirectStarted', true);
        callback.resolve?.('fictional-code');
      });
    const close = vi.spyOn(HttpMcpClient.prototype, 'close');
    const reg = registry();
    vi.mocked(reg.getClient).mockImplementation(async () => reg.clients.get(pkg.id) ?? new HttpMcpClient(pkg.id, pkg));
    try {
      const result = parse(await handleAuthenticate({ package_id: pkg.id, force: true }, reg, catalog));
      expect(result.status).toBe('error');
      const redirects = redirect.mock.calls.length;
      expect(redirects).toBeGreaterThan(0);
      await handleHealthCheckPackage({ package_id: pkg.id }, reg, catalog);
      expect(redirect).toHaveBeenCalledTimes(redirects);
      expect(reg.clients.has(pkg.id)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    } finally { await reg.clients.get(pkg.id)?.close(); }
  });

  it.each([false, true])('preserves a replacement cache entry and the late decline result when close fails: %s', async (failClose) => {
    mockLateChallengeFetch();
    const reg = registry();
    const replacement = new HttpMcpClient(pkg.id, pkg);
    vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization')
      .mockImplementation(async function (this: SimpleOAuthProvider) {
        Reflect.set(this, 'redirectStarted', true);
        reg.clients.set(pkg.id, replacement);
        callback.reject?.(Object.assign(new Error('OAuth error: access_denied'), { code: OAUTH_PROVIDER_ERROR_CODE }));
      });
    const realClose = HttpMcpClient.prototype.close;
    const close = vi.spyOn(HttpMcpClient.prototype, 'close').mockImplementationOnce(async function (this: HttpMcpClient) {
      await realClose.call(this);
      if (failClose) throw new Error('test close failed');
    });
    try {
      expect(parse(await handleAuthenticate({ package_id: pkg.id, force: true }, reg, catalog)))
        .toEqual({ package_id: pkg.id, status: 'error', error: 'OAuth error: access_denied' });
      expect(reg.clients.get(pkg.id)).toBe(replacement);
      expect(close).toHaveBeenCalledOnce();
      expect(close.mock.contexts[0]).not.toBe(replacement);
      expect(callback.stop).toHaveBeenCalledOnce();
    } finally { await replacement.close(); }
  });

  it('advances ports after a verification authorize-probe rejection without waiting for callback expiry', async () => {
    mockLateChallengeFetch();
    const expired = vi.fn();
    let callbackTimer: ReturnType<typeof setTimeout>;
    callback.waitForCallback.mockImplementation((budget) => new Promise((_resolve, reject) => {
      expect(budget).toBe(300_000);
      callbackTimer = setTimeout(() => { expired(); reject(new Error('OAuth callback timeout')); }, 1_000);
    }));
    callback.stop.mockImplementation(async () => { clearTimeout(callbackTimer); });
    callback.start.mockImplementation(async () => {
      // End the browser-floor attempt before it could open a real browser.
      if (callback.start.mock.calls.length === 4) throw new Error('test browser floor stopped');
    });
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization');
    const close = vi.spyOn(HttpMcpClient.prototype, 'close');
    const reg = registry();
    try {
      await handleAuthenticate({ package_id: pkg.id }, reg, catalog);
      expect(redirect).toHaveBeenCalledTimes(3);
      expect(callback.start).toHaveBeenCalledTimes(4);
      expect(callback.stop).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(3);
      expect(expired).not.toHaveBeenCalled();
    } finally { clearTimeout(callbackTimer!); await reg.clients.get(pkg.id)?.close(); }
  }, 15_000);

  it.each(['registration-404', 'unreachable', 'absorbed-401'])('fails before the callback budget for %s and never caches the client', async (outcome) => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (outcome === 'unreachable') throw new TypeError('fetch failed');
      if (url.endsWith('/mcp')) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      return new Response('Not Found', { status: 404 });
    });
    if (outcome === 'absorbed-401') vi.spyOn(HttpMcpClient.prototype, 'connectWithOAuth').mockResolvedValue(undefined);
    const close = vi.spyOn(HttpMcpClient.prototype, 'close');
    const reg = registry();
    const result = parse(await handleAuthenticate({ package_id: pkg.id }, reg, catalog));
    expect(result.status).toBe('error');
    expect(result.error).toBe("Sign-in couldn't start for this connector. It may not be answering right now, or it may need an API key or other details from its provider instead. Its help page or support can tell you which.");
    expect(result.error).not.toMatch(/browser|OAuth/i);
    expect(result.message).toBeTruthy();
    expect(callback.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(reg.clients.has(pkg.id)).toBe(false);
    if (outcome === 'registration-404') {
      expect(requests).toContain('https://mcp.example.com/mcp');
      expect(requests).toContain('https://mcp.example.com/register');
    }
    expect(parse(await handleHealthCheckPackage({ package_id: pkg.id }, reg, catalog)))
      .toEqual({ package_id: pkg.id, health: 'unavailable', detail: 'connect ECONNREFUSED' });
  });

  it('verifies a successful token-backed bootstrap without exchanging a callback code', async () => {
    const provider = new SimpleOAuthProvider(pkg.id, 5173);
    await provider.initialize();
    await provider.saveTokens({ access_token: 'fictional-token', token_type: 'Bearer', expires_in: 3600 });
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (body?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fictional', version: '1' },
      } });
      if (body?.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
      return new Response(null, { status: init?.method === 'POST' ? 202 : 405 });
    });
    const finish = vi.spyOn(HttpMcpClient.prototype, 'finishOAuth');
    const reg = registry();
    try {
      expect(parse(await handleAuthenticate({ package_id: pkg.id }, reg, catalog)).status).toBe('authenticated');
      expect(finish).not.toHaveBeenCalled();
      expect(await reg.clients.get(pkg.id)?.isAuthenticated()).toBe(true);
    } finally { await reg.clients.get(pkg.id)?.close(); }
  });
  it.each(['initialize', 'tools/list'])('keeps the redirect, callback-state handoff and real SDK token exchange path when challenged on %s', async (challengeOn) => {
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization')
      .mockImplementation(async function (this: SimpleOAuthProvider, url: URL) {
        expect(url.searchParams.get('state')).toBe(callback.waitForCallback.mock.calls[0][1]);
        expect(url.searchParams.get('code_challenge')).toBeTruthy();
        Reflect.set(this, 'redirectStarted', true);
        callback.resolve?.('fictional-code');
      });
    const tokenRequests: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/oauth-authorization-server')) return Response.json({
        issuer: 'https://mcp.example.com', authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token', registration_endpoint: 'https://mcp.example.com/register',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      });
      if (url.endsWith('/register')) return Response.json({
        client_id: 'fictional-client', redirect_uris: ['http://localhost:5173/oauth/callback'],
      }, { status: 201 });
      if (url.endsWith('/token')) {
        tokenRequests.push(String(init?.body));
        return Response.json({ access_token: 'fictional-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.endsWith('/mcp')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const challenged = challengeOn === 'initialize' || body?.method === 'tools/list';
        if (challenged && new Headers(init?.headers).get('authorization') !== 'Bearer fictional-token') {
          return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
        }
        if (body?.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fictional', version: '1' },
        } });
        if (body?.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
        return new Response(null, { status: init?.method === 'POST' ? 202 : 405 });
      }
      return new Response(null, { status: 404 });
    });
    const reg = registry();
    const finish = vi.spyOn(HttpMcpClient.prototype, 'finishOAuth');
    try {
      const result = parse(await handleAuthenticate({ package_id: pkg.id }, reg, catalog));
      expect(redirect).toHaveBeenCalledOnce();
      expect(result.status).toBe('authenticated');
      expect(finish).toHaveBeenCalledWith('fictional-code');
      expect(tokenRequests).toHaveLength(1);
      expect(new URLSearchParams(tokenRequests[0]).get('code')).toBe('fictional-code');
      expect(callback.waitForCallback).toHaveBeenCalledWith(300_000, expect.any(String));
      expect(callback.stop).toHaveBeenCalledOnce();
    } finally { await reg.clients.get(pkg.id)?.close(); }
  });

});
