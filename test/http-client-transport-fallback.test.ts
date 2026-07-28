import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
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
    // The redirect path throws UnauthorizedError (wrapped in a combined transport-negotiation
    // error from connect()), which connectWithOAuth treats as "redirect initiated" and
    // returns without throwing.
    await expect(client.connectWithOAuth()).resolves.toBeUndefined();

    expect(provider.redirectCalled, 'redirectToAuthorization was invoked').toBe(true);
    expect((client as any).usedStreamableHttpFallback).toBe(true);
    expect((client as any).oauthDiscoveryTrace.length, 'discovery trace preserved across fallback').toBeGreaterThan(0);
  });
});
