import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { handleHealthCheckPackage } from '../src/handlers/healthCheckPackage.js';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import { PackageRegistry } from '../src/registry.js';
import type { Catalog } from '../src/catalog.js';

const callback = vi.hoisted(() => ({
  start: vi.fn(async () => {}), stop: vi.fn(async () => {}), setServiceId: vi.fn(),
  waitForCallback: vi.fn<(timeout: number, state: string) => Promise<string>>(),
  resolve: undefined as ((code: string) => void) | undefined,
}));
vi.mock('../src/logging.js', () => ({ getLogger: () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}) }));
vi.mock('../src/utils/portFinder.js', async (original) => ({
  ...await original<typeof import('../src/utils/portFinder.js')>(),
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
}));
vi.mock('../src/auth/callbackServer.js', () => ({
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
    callback.waitForCallback.mockImplementation(() => new Promise((resolve) => {
      callback.resolve = resolve;
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
