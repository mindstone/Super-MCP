import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import { RefreshOnlyOAuthProvider } from '../src/auth/providers/refreshOnly.js';
import type { PackageConfig } from '../src/types.js';

// vi.hoisted ensures the variable exists before vi.mock runs (vi.mock is hoisted)
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/logging.js', () => ({
  getLogger: () => mockLogger,
}));

/**
 * A Response-like object that is NOT `instanceof globalThis.Response`.
 * Simulates a cross-realm Response (e.g., from undici, bundled Electron
 * Node.js, or a V8 context boundary) that breaks the MCP SDK's
 * `instanceof Response` check in parseErrorResponse.
 */
class ForeignRealmResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly type: ResponseType;
  readonly url: string;
  readonly redirected: boolean;
  readonly bodyUsed: boolean;
  private _bodyText: string;

  constructor(bodyText: string, init: { status: number; statusText?: string; headers?: HeadersInit }) {
    this._bodyText = bodyText;
    this.status = init.status;
    this.statusText = init.statusText ?? '';
    this.ok = init.status >= 200 && init.status < 300;
    this.headers = new Headers(init.headers);
    this.body = null;
    this.type = 'default';
    this.url = '';
    this.redirected = false;
    this.bodyUsed = false;
  }

  async text(): Promise<string> { return this._bodyText; }
  async json(): Promise<unknown> { return JSON.parse(this._bodyText); }
  async arrayBuffer(): Promise<ArrayBuffer> { return new TextEncoder().encode(this._bodyText).buffer; }
  async blob(): Promise<Blob> { return new Blob([this._bodyText]); }
  async formData(): Promise<FormData> { return new FormData(); }
  async bytes(): Promise<Uint8Array> { return new TextEncoder().encode(this._bodyText); }
  clone(): ForeignRealmResponse {
    return new ForeignRealmResponse(this._bodyText, {
      status: this.status, statusText: this.statusText, headers: this.headers
    });
  }
  get [Symbol.toStringTag]() { return 'Response'; }
}

function oauthHttpPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: 'http',
    base_url: 'https://mcp.example.com/mcp',
    oauth: true,
    visibility: 'default',
  };
}

/** Collect all error messages from the mock logger */
function collectErrorMessages(): string {
  return mockLogger.error.mock.calls
    .map((call: unknown[]) => {
      const msg = String(call[0] ?? '');
      const detail = call[1] && typeof call[1] === 'object' ? JSON.stringify(call[1]) : '';
      return msg + ' ' + detail;
    })
    .join('\n');
}

/**
 * Create a mock fetch that returns ForeignRealmResponse objects.
 * Simulates an OAuth server that returns 401 for the MCP endpoint (triggering
 * auth flow) and 404 for registration endpoints (server has no DCR support).
 */
function createForeignRealmFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? 'GET';

    // Initial MCP endpoint request -> 401 to trigger auth flow
    if (urlStr.includes('mcp.example.com/mcp') && (method === 'GET' || method === 'POST')) {
      return new ForeignRealmResponse('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'WWW-Authenticate': 'Bearer',
          'Content-Type': 'text/plain',
        },
      }) as unknown as Response;
    }

    // OAuth well-known discovery endpoints -> 404
    if (urlStr.includes('.well-known/')) {
      return new ForeignRealmResponse('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }) as unknown as Response;
    }

    // Dynamic client registration -> 404 (server doesn't support DCR)
    if (urlStr.includes('/register')) {
      return new ForeignRealmResponse(
        JSON.stringify({ error: 'invalid_request', error_description: 'Registration not supported' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;
    }

    // Fallback: 404
    return new ForeignRealmResponse('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * Same mock but returning native Response objects (no cross-realm issue).
 */
function createNativeFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? 'GET';

    if (urlStr.includes('mcp.example.com/mcp') && (method === 'GET' || method === 'POST')) {
      return new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'WWW-Authenticate': 'Bearer',
          'Content-Type': 'text/plain',
        },
      });
    }

    if (urlStr.includes('.well-known/')) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (urlStr.includes('/register')) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: 'Registration not supported' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }) as unknown as typeof fetch;
}

describe('HttpMcpClient cross-realm Response handling', () => {
  let originalFetch: typeof globalThis.fetch;
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-http-oauth-test-'));
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

  it('ForeignRealmResponse fails instanceof Response (precondition)', () => {
    const foreign = new ForeignRealmResponse('{"ok":true}', { status: 200 });
    expect(foreign instanceof Response).toBe(false);
    expect(foreign.status).toBe(200);
    expect(foreign.ok).toBe(true);
  });

  it('SDK parseErrorResponse produces [object Response] with foreign-realm Response (confirms bug)', async () => {
    const { parseErrorResponse } = await import(
      '@modelcontextprotocol/sdk/client/auth.js'
    );

    const foreignResponse = new ForeignRealmResponse(
      JSON.stringify({ error: 'invalid_client', error_description: 'Bad client' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );

    const result = await parseErrorResponse(foreignResponse as unknown as Response);
    // Confirms the upstream SDK bug: [object Response] in error message
    expect(result.message).toContain('[object Response]');
  });

  it('should not produce [object Response] errors during OAuth with foreign-realm responses', async () => {
    const config = oauthHttpPackage('test-foreign-realm');
    const client = new HttpMcpClient('test-foreign-realm', config, { oauthPort: 5199 });

    globalThis.fetch = createForeignRealmFetch();

    // connectWithOAuth may throw or catch internally depending on error type.
    // We care that no error message ever contains "[object Response]".
    let thrownError: Error | undefined;
    try {
      await client.connectWithOAuth();
    } catch (e) {
      thrownError = e instanceof Error ? e : new Error(String(e));
    }

    if (thrownError) {
      expect(thrownError.message).not.toContain('[object Response]');
    }

    const errors = collectErrorMessages();
    // Without the fix, error logs contain "[object Response]"
    expect(errors).not.toContain('[object Response]');
  });

  it('native Response objects should work without [object Response] errors', async () => {
    const config = oauthHttpPackage('test-native-response');
    const client = new HttpMcpClient('test-native-response', config, { oauthPort: 5198 });

    globalThis.fetch = createNativeFetch();

    let thrownError: Error | undefined;
    try {
      await client.connectWithOAuth();
    } catch (e) {
      thrownError = e instanceof Error ? e : new Error(String(e));
    }

    if (thrownError) {
      expect(thrownError.message).not.toContain('[object Response]');
    }

    const errors = collectErrorMessages();
    expect(errors).not.toContain('[object Response]');
  });

  it('captures only error and error_description from non-OK OAuth JSON responses without consuming the SDK response body', async () => {
    const provider = new SimpleOAuthProvider('test-oauth-error-capture', 5201);
    await provider.initialize();

    const config = oauthHttpPackage('test-oauth-error-capture');
    const client = new HttpMcpClient('test-oauth-error-capture', config, {
      oauthPort: 5201,
      oauthProvider: provider,
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
          access_token: 'should-not-be-logged',
          refresh_token: 'should-not-be-logged',
          secret_note: 'should-not-be-logged',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;

    await (client as any).initializeOAuthIfNeeded(true);
    const options = (client as any).getTransportOptions() as { fetch: typeof fetch };

    const response = await options.fetch('https://oauth.example/token', { method: 'POST' });
    const parsed = await response.json();
    expect(parsed).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
      access_token: 'should-not-be-logged',
      refresh_token: 'should-not-be-logged',
    });

    expect(provider.consumeLastOAuthError()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
    });
    expect(provider.consumeLastOAuthError()).toBeUndefined();
  });

  it('does NOT capture an error from a non-token-endpoint response (scoping guard)', async () => {
    const provider = new SimpleOAuthProvider('test-oauth-error-scope', 5202);
    await provider.initialize();

    const config = oauthHttpPackage('test-oauth-error-scope');
    const client = new HttpMcpClient('test-oauth-error-scope', config, {
      oauthPort: 5202,
      oauthProvider: provider,
    });

    // A normal MCP/API endpoint returning a non-OK body that happens to carry a
    // string `error` field — must NOT be mis-captured as an OAuth error.
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'rate_limited', error_description: 'Slow down' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await (client as any).initializeOAuthIfNeeded(true);
    const options = (client as any).getTransportOptions() as { fetch: typeof fetch };

    // Non-token paths: the MCP JSON-RPC endpoint and the DCR /register endpoint.
    await options.fetch('https://mcp.example.com/mcp', { method: 'POST' });
    await options.fetch('https://oauth.example/register', { method: 'POST' });

    expect(provider.consumeLastOAuthError()).toBeUndefined();
  });

  it('surfaces the captured token-endpoint error through the shared provider on refresh-only token invalidation (end-to-end wiring)', async () => {
    const provider = new SimpleOAuthProvider('test-oauth-error-wiring', 5203);
    await provider.initialize();

    const config = oauthHttpPackage('test-oauth-error-wiring');
    const client = new HttpMcpClient('test-oauth-error-wiring', config, {
      oauthPort: 5203,
      oauthProvider: provider,
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await (client as any).initializeOAuthIfNeeded(true);
    const options = (client as any).getTransportOptions() as { fetch: typeof fetch };

    // Simulate the SDK's refresh request to the token endpoint hitting a 400.
    await options.fetch('https://oauth.example/token', { method: 'POST' });

    // The refresh-only wrapper used on background connects shares the SAME provider
    // instance the fetch wrapper wrote to — so its "ignoring token invalidation" warn
    // must carry the captured error, prove the seam end-to-end, and still NOT delete tokens.
    const refreshOnly = new RefreshOnlyOAuthProvider(provider);
    mockLogger.warn.mockClear();
    await refreshOnly.invalidateCredentials('tokens');

    const warnWithError = mockLogger.warn.mock.calls.find(
      (call: unknown[]) =>
        String(call[0] ?? '').includes('Ignoring token invalidation request in refresh-only mode'),
    );
    expect(warnWithError).toBeDefined();
    expect(warnWithError?.[1]).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
    });

    // Consumed and cleared — no stale carryover into a later invalidation.
    expect(provider.consumeLastOAuthError()).toBeUndefined();
  });
});
