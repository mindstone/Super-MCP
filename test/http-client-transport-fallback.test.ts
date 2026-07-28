import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { PackageConfig } from '../src/types.js';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/logging.js', () => ({
  getLogger: () => mockLogger,
}));

const MCP_URL = 'https://mcp.swifteq.com/api/mcp/sse';

function ssePackage(id: string, opts: Partial<PackageConfig> = {}): PackageConfig {
  return {
    id,
    name: id,
    transport: 'http',
    transportType: 'sse',
    base_url: MCP_URL,
    oauth: false,
    visibility: 'default',
    ...opts,
  };
}

const PROTOCOL_VERSION = '2025-11-25';

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

function makeInitializeResult(id: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      serverInfo: { name: 'test-server', version: '1.0' },
    },
  });
}

function parseBody(init?: RequestInit): any | null {
  if (!init?.body || typeof init.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function encodeSseChunk(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

function makeEndpointEvent(endpointUrl: string): string {
  return `event: endpoint\ndata: ${endpointUrl}\n\n`;
}

function makeMessageEvent(json: string): string {
  return `data: ${json}\n\n`;
}

describe('HttpMcpClient SSE -> StreamableHTTP transport fallback', () => {
  let originalFetch: typeof globalThis.fetch;
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-sse-fallback-'));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (previousTokenDir === undefined) {
      delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    } else {
      process.env.SUPER_MCP_OAUTH_TOKEN_DIR = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function warnCallsText(): string {
    return mockLogger.warn.mock.calls
      .map((c: unknown[]) => String(c[0] ?? '') + ' ' + (c[1] && typeof c[1] === 'object' ? JSON.stringify(c[1]) : ''))
      .join('\n');
  }

  it('Swifteq shape: explicit-SSE GET 405 falls back to StreamableHTTP POST initialize and connects', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed', headers: { allow: 'POST, OPTIONS' } });
      }
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          return new Response(makeInitializeResult(body.id), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-fallback', ssePackage('swifteq-fallback'));
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect((client as any).usedStreamableHttpFallback).toBe(true);
    expect(warnCallsText()).toContain('Streamable HTTP');

    const sseGet = calls.find((c) => c.method === 'GET' && c.url === MCP_URL);
    expect(sseGet, 'SSE GET was attempted').toBeDefined();
    const postInit = calls.find((c) => c.method === 'POST' && c.url === MCP_URL && c.body?.includes('"initialize"'));
    expect(postInit, 'StreamableHTTP POST initialize was attempted after SSE GET').toBeDefined();
    expect(calls.indexOf(sseGet!)).toBeLessThan(calls.indexOf(postInit!));
  });

  it('negative 500: SSE GET 500 surfaces error, no StreamableHTTP retry', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-500', ssePackage('swifteq-500'));
    await expect(client.connect()).rejects.toThrow();
    expect((client as any).usedStreamableHttpFallback).toBe(false);
    const postInit = calls.find((c) => c.method === 'POST' && c.url === MCP_URL && c.body?.includes('"initialize"'));
    expect(postInit, 'no StreamableHTTP POST initialize on 500').toBeUndefined();
  });

  it('negative network error: SSE GET rejects, no retry', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method });
      if (urlStr === MCP_URL && method === 'GET') {
        throw new TypeError('fetch failed');
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-neterr', ssePackage('swifteq-neterr'));
    await expect(client.connect()).rejects.toThrow();
    expect((client as any).usedStreamableHttpFallback).toBe(false);
    const postInit = calls.find((c) => c.method === 'POST' && c.url === MCP_URL && c.body?.includes('"initialize"'));
    expect(postInit, 'no StreamableHTTP POST initialize on network error').toBeUndefined();
  });

  it('no-regression SSE works: SSE GET 200 with endpoint event connects via SSE, no StreamableHTTP fallback', async () => {
    const calls: FetchCall[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const sseStream = new ReadableStream<Uint8Array>({
      start(c) { streamController = c; },
    });

    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (urlStr === MCP_URL && method === 'GET') {
        const resp = new Response(sseStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
        // Enqueue the endpoint event after returning the Response so EventSource starts reading.
        queueMicrotask(() => streamController?.enqueue(encodeSseChunk(makeEndpointEvent(MCP_URL))));
        return resp;
      }
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          queueMicrotask(() => streamController?.enqueue(encodeSseChunk(makeMessageEvent(makeInitializeResult(body.id)))));
          return new Response(null, { status: 202 });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-sseok', ssePackage('swifteq-sseok'));
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect((client as any).usedStreamableHttpFallback).toBe(false);
    expect(warnCallsText()).not.toContain('Streamable HTTP');
  });

  it('R1: auth-like fallback error propagates unwrapped with no error-level log', async () => {
    // SSE 405 -> StreamableHTTP fallback -> POST initialize 401 (no auth provider)
    // -> SDK throws StreamableHTTPError whose message contains "Unauthorized"
    // (auth-like). connect() must rethrow the ORIGINAL error unwrapped (no
    // "Transport negotiation failed" wrap) and log at debug, not error.
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed', headers: { allow: 'POST, OPTIONS' } });
      }
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          // No auth provider on the transport -> SDK throws StreamableHTTPError
          // with the response body in the message ("Unauthorized" -> auth-like).
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-authlike', ssePackage('swifteq-authlike'));

    let caught: unknown;
    await client.connect().catch((e) => { caught = e; });

    expect(caught, 'connect() threw the fallback error').toBeInstanceOf(Error);
    const caughtErr = caught as Error;
    expect(caughtErr.message, 'original auth-like error propagated unwrapped').not.toContain('Transport negotiation failed');
    expect(caughtErr.message.toLowerCase(), 'original auth-like message preserved').toContain('unauthorized');
    expect((caught as Error).name, 'error name preserved (not a generic wrap)').toBe(StreamableHTTPError.prototype.name || 'Error');

    // The fallback-failure error log must NOT fire on the auth-like path; only debug.
    const errorCallsText = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(errorCallsText, 'no "fallback also failed" error log on auth-like path').not.toContain('fallback also failed');
    expect(mockLogger.error, 'no error-level log on the auth-like fallback path').not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('R4: after a successful fallback a second connect() does not re-fallback or re-GET SSE', async () => {
    // First connect: SSE 405 -> StreamableHTTP POST initialize 200 (fallback
    // succeeds). Then simulate a reconnect (isConnected=false) and call
    // connect() again: usedStreamableHttpFallback is true -> createTransport()
    // returns StreamableHTTP (no SSE GET) and the SSE->StreamableHTTP fallback
    // branch is guarded out. Assert exactly one SSE GET total and exactly one
    // fallback warn across the whole sequence.
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed', headers: { allow: 'POST, OPTIONS' } });
      }
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          return new Response(makeInitializeResult(body.id), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpMcpClient('swifteq-loopfree', ssePackage('swifteq-loopfree'));
    await client.connect();
    expect((client as any).usedStreamableHttpFallback).toBe(true);
    expect(
      (client as any).transport instanceof StreamableHTTPClientTransport,
      'first connect used StreamableHTTP after fallback',
    ).toBe(true);
    const firstWarnCount = mockLogger.warn.mock.calls.length;
    const firstFallbackWarns = warnCallsText().split('Streamable HTTP transport failed, falling back').length - 1;

    // Simulate a reconnect: the host dropped the connection but the client
    // instance (and its fallback flag) is reused. close() resets the SDK
    // Client so a fresh connect() can attach a new transport.
    await client.close();
    await client.connect();

    expect(client.isConnected).toBe(true);
    // The reused client must NOT enter the SSE->StreamableHTTP fallback branch
    // again (usedStreamableHttpFallback guard) and must NOT create an SSE
    // transport (createTransport() returns StreamableHTTP while the flag is set).
    const recreated = (client as any).transport;
    expect(
      recreated instanceof StreamableHTTPClientTransport,
      'second connect reused StreamableHTTP (no SSE transport created)',
    ).toBe(true);
    expect(
      !(recreated instanceof SSEClientTransport),
      'second connect did not create an SSE transport',
    ).toBe(true);
    // No additional fallback warn on the second connect.
    const secondFallbackWarns = warnCallsText().split('Streamable HTTP transport failed, falling back').length - 1;
    expect(secondFallbackWarns, 'no second fallback warn').toBe(firstFallbackWarns);
    expect(mockLogger.warn.mock.calls.length, 'no new warn calls on second connect').toBe(firstWarnCount);
  });
});

const AS_METADATA = {
  issuer: 'https://auth.swifteq.com/',
  authorization_endpoint: 'https://auth.swifteq.com/oauth/authorize',
  token_endpoint: 'https://auth.swifteq.com/oauth/token',
  registration_endpoint: 'https://mcp.swifteq.com/api/mcp/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['read', 'write'],
};

const DCR_RESPONSE = {
  client_id: 'test-client-id-1234',
  client_secret: 'test-client-secret',
  redirect_uris: ['http://localhost:5199/oauth/callback'],
};

class NoBrowserOAuthProvider extends SimpleOAuthProvider {
  redirectCalled = false;
  redirectUrlArg?: string;
  async redirectToAuthorization(authUrl: URL): Promise<void> {
    this.redirectCalled = true;
    this.redirectUrlArg = authUrl.toString();
    this.redirectStarted = true;
  }
}

describe('HttpMcpClient SSE -> StreamableHTTP fallback with OAuth discovery', () => {
  let originalFetch: typeof globalThis.fetch;
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-sse-fallback-oauth-'));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (previousTokenDir === undefined) {
      delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    } else {
      process.env.SUPER_MCP_OAUTH_TOKEN_DIR = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('OAuth variant: SSE 405 -> StreamableHTTP 401 -> discovery + DCR + redirect reached, trace preserved', async () => {
    const provider = new NoBrowserOAuthProvider('swifteq-oauth', 5199);
    await provider.initialize();

    const config: PackageConfig = {
      id: 'swifteq-oauth',
      name: 'swifteq-oauth',
      transport: 'http',
      transportType: 'sse',
      base_url: MCP_URL,
      oauth: true,
      visibility: 'default',
    };
    const client = new HttpMcpClient('swifteq-oauth', config, { oauthProvider: provider });

    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';

      // SSE GET to MCP endpoint -> 405
      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed', headers: { allow: 'POST, OPTIONS' } });
      }
      // StreamableHTTP POST initialize -> 401 with www-authenticate (triggers auth flow)
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="https://auth.swifteq.com/"' },
          });
        }
        return new Response(null, { status: 202 });
      }
      // PRM discovery (path-relative + origin) -> 404
      if (urlStr.includes('/.well-known/oauth-protected-resource')) {
        return new Response(null, { status: 404 });
      }
      // AS metadata discovery (origin) -> 200 with metadata
      if (urlStr === 'https://mcp.swifteq.com/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify(AS_METADATA), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // OIDC discovery -> 404 (not used)
      if (urlStr.includes('/.well-known/openid-configuration')) {
        return new Response(null, { status: 404 });
      }
      // DCR registration
      if (urlStr === 'https://mcp.swifteq.com/api/mcp/register' && method === 'POST') {
        return new Response(JSON.stringify(DCR_RESPONSE), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    // connectWithOAuth: SSE 405 -> fallback to StreamableHTTP -> 401 -> auth flow -> redirect.
    // The redirect path throws UnauthorizedError; connect() surfaces it unwrapped on the
    // auth-like fallback path (R1), and connectWithOAuth treats it as "redirect initiated"
    // and returns without throwing.
    await expect(client.connectWithOAuth()).resolves.toBeUndefined();

    expect(provider.redirectCalled, 'redirectToAuthorization was invoked').toBe(true);
    expect((client as any).usedStreamableHttpFallback).toBe(true);
    const trace: Array<{ kind: string; scope: string; statusClass: string }> = (client as any).oauthDiscoveryTrace;
    expect(trace.length, 'discovery trace preserved across fallback').toBeGreaterThan(0);
    // Pin the discovery sequence kinds, not just presence: a protected-resource
    // 4xx from the PRM probe and an authorization-server 2xx from the AS-metadata
    // fetch must both appear (the fallback leg ran discovery).
    expect(
      trace.some((e) => e.kind === 'protected-resource' && e.statusClass === '4xx'),
      'PRM probe (protected-resource 4xx) recorded',
    ).toBe(true);
    expect(
      trace.some((e) => e.kind === 'authorization-server' && e.statusClass === '2xx'),
      'AS metadata fetch (authorization-server 2xx) recorded',
    ).toBe(true);
  });

  it('R3: finishOAuth() recreates transport via StreamableHTTP after SSE->StreamableHTTP fallback', async () => {
    // After a successful SSE->StreamableHTTP fallback that reaches the OAuth
    // redirect, finishOAuth(code) must recreate the transport via StreamableHTTP
    // (not SSE) — pinning the usedStreamableHttpFallback-through-finishOAuth
    // persistence invariant. Mock finishAuth on the fallback transport so the
    // token-exchange internals are short-circuited; assert the recreated
    // transport is a StreamableHTTPClientTransport and that no second SSE GET
    // to the MCP endpoint occurs during finishOAuth's reconnect.
    const provider = new NoBrowserOAuthProvider('swifteq-finish', 5199);
    await provider.initialize();

    const config: PackageConfig = {
      id: 'swifteq-finish',
      name: 'swifteq-finish',
      transport: 'http',
      transportType: 'sse',
      base_url: MCP_URL,
      oauth: true,
      visibility: 'default',
    };
    const client = new HttpMcpClient('swifteq-finish', config, { oauthProvider: provider });

    const calls: FetchCall[] = [];
    let postInitializeCount = 0;
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method ?? 'GET';
      calls.push({ url: urlStr, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (urlStr === MCP_URL && method === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed', headers: { allow: 'POST, OPTIONS' } });
      }
      if (urlStr === MCP_URL && method === 'POST') {
        const body = parseBody(init);
        if (body?.method === 'initialize') {
          postInitializeCount += 1;
          // 1st POST initialize (during fallback leg) -> 401 triggers auth -> redirect.
          // 2nd POST initialize (during finishOAuth reconnect) -> 200 success.
          if (postInitializeCount === 1) {
            return new Response('Unauthorized', {
              status: 401,
              headers: { 'www-authenticate': 'Bearer realm="https://auth.swifteq.com/"' },
            });
          }
          return new Response(makeInitializeResult(body.id), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 202 });
      }
      if (urlStr.includes('/.well-known/oauth-protected-resource')) {
        return new Response(null, { status: 404 });
      }
      if (urlStr === 'https://mcp.swifteq.com/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify(AS_METADATA), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.includes('/.well-known/openid-configuration')) {
        return new Response(null, { status: 404 });
      }
      if (urlStr === 'https://mcp.swifteq.com/api/mcp/register' && method === 'POST') {
        return new Response(JSON.stringify(DCR_RESPONSE), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    // Reach the OAuth redirect via the SSE->StreamableHTTP fallback.
    await expect(client.connectWithOAuth()).resolves.toBeUndefined();
    expect((client as any).usedStreamableHttpFallback).toBe(true);
    const sseGetsBeforeFinish = calls.filter((c) => c.method === 'GET' && c.url === MCP_URL).length;
    expect(sseGetsBeforeFinish, 'exactly one SSE GET before finishOAuth').toBe(1);

    // Mock finishAuth on the fallback transport so finishOAuth's token-exchange
    // is short-circuited; the reconnect still runs createTransport() +
    // connectWithTimeout() against the (mocked) fetch.
    const fallbackTransport = (client as any).transport;
    expect(fallbackTransport, 'fallback transport was set').toBeDefined();
    vi.spyOn(fallbackTransport, 'finishAuth').mockResolvedValue(undefined);

    await client.finishOAuth('test-auth-code');

    expect(client.isConnected, 'finishOAuth reconnected').toBe(true);
    // The recreated transport must be StreamableHTTP (not SSE).
    const recreatedTransport = (client as any).transport;
    expect(
      recreatedTransport instanceof StreamableHTTPClientTransport,
      'recreated transport is StreamableHTTPClientTransport',
    ).toBe(true);
    expect(
      !(recreatedTransport instanceof SSEClientTransport),
      'recreated transport is not SSEClientTransport',
    ).toBe(true);
    // No second SSE GET during finishOAuth's reconnect.
    const sseGetsAfterFinish = calls.filter((c) => c.method === 'GET' && c.url === MCP_URL).length;
    expect(sseGetsAfterFinish, 'no second SSE GET during finishOAuth').toBe(sseGetsBeforeFinish);
    // A second POST initialize did happen (the reconnect via StreamableHTTP).
    expect(postInitializeCount, 'finishOAuth reconnected via a StreamableHTTP POST initialize').toBe(2);
  });
});
