import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  HttpMcpClient,
  OAUTH_DISCOVERY_TRACE_ERROR_MARKER,
  classifyOAuthDiscoveryRequest,
} from "../src/clients/httpClient.js";
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
    // Seed on-disk tokens so the (post-fix) disk-compare refresh-only invalidation
    // takes the "preserve" path — which is the one that surfaces the captured
    // OAuth error fields (an absent token file is treated as already-cleared).
    await provider.saveTokens({
      access_token: 'wiring-access',
      refresh_token: 'wiring-refresh',
      expires_in: 3600,
    });

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
    // instance the fetch wrapper wrote to — so its disk-compare-preserve warn must
    // carry the captured error, prove the seam end-to-end, and still NOT delete tokens.
    const refreshOnly = new RefreshOnlyOAuthProvider(provider);
    mockLogger.warn.mockClear();
    await refreshOnly.invalidateCredentials('tokens');

    const warnWithError = mockLogger.warn.mock.calls.find(
      (call: unknown[]) =>
        String(call[0] ?? '').includes('Token invalidation (refresh-only): preserving on-disk tokens'),
    );
    expect(warnWithError).toBeDefined();
    expect(warnWithError?.[1]).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
    });

    // Tokens preserved (peer may have rotated; a dead grant is cleared by the
    // transactional fetch wrapper, not here).
    const tokenFile = path.join(tempDir, 'test-oauth-error-wiring_tokens.json');
    const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    expect(saved).toMatchObject({ refresh_token: 'wiring-refresh' });

    // Consumed and cleared — no stale carryover into a later invalidation.
    expect(provider.consumeLastOAuthError()).toBeUndefined();
  });

  describe("OAuth discovery failure trace", () => {
    it("classifies path-relative and origin authorization-server discovery from pathname only", () => {
      expect(
        classifyOAuthDiscoveryRequest(
          "https://mcp.swifteq.com/.well-known/oauth-authorization-server/api/mcp/sse?token=secret",
        ),
      ).toEqual({
        kind: "authorization-server",
        scope: "path-relative",
      });
      expect(classifyOAuthDiscoveryRequest("https://mcp.swifteq.com/.well-known/oauth-authorization-server")).toEqual({
        kind: "authorization-server",
        scope: "origin",
      });
      expect(classifyOAuthDiscoveryRequest("https://private-host.invalid/oauth/register")).toEqual({
        kind: "registration",
        scope: "path-relative",
      });
      expect(classifyOAuthDiscoveryRequest("https://private-host.invalid/jwks")).toEqual({
        kind: "jwks",
        scope: "origin",
      });
      expect(classifyOAuthDiscoveryRequest("https://private-host.invalid/oauth/token")).toEqual({
        kind: "token",
        scope: "path-relative",
      });
      expect(classifyOAuthDiscoveryRequest("https://private-host.invalid/.well-known/custom-discovery/tenant")).toEqual(
        {
          kind: "other-well-known",
          scope: "path-relative",
        },
      );
    });

    it("records sanitized status classes at the transport fetch seam, including network errors", async () => {
      const responses: Array<Response | Error> = [
        new Response(null, { status: 204 }),
        new Response(null, { status: 302 }),
        new Response(null, { status: 404 }),
        new Response(null, { status: 503 }),
        new Error("synthetic network failure"),
      ];
      globalThis.fetch = vi.fn(async () => {
        const next = responses.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next!;
      }) as unknown as typeof fetch;

      const client = new HttpMcpClient(
        "test-oauth-discovery-statuses",
        oauthHttpPackage("test-oauth-discovery-statuses"),
      );
      const options = (client as any).getTransportOptions() as {
        fetch: typeof fetch;
      };
      const urls = [
        "https://private-host.invalid/.well-known/oauth-protected-resource",
        "https://private-host.invalid/.well-known/oauth-authorization-server",
        "https://private-host.invalid/.well-known/openid-configuration",
        "https://private-host.invalid/register",
        "https://private-host.invalid/token",
      ];

      for (const url of urls.slice(0, -1)) {
        await options.fetch(url);
      }
      await expect(options.fetch(urls.at(-1)!)).rejects.toThrow("synthetic network failure");

      expect((client as any).getOAuthDiscoveryTrace()).toEqual([
        expect.objectContaining({
          kind: "protected-resource",
          scope: "origin",
          statusClass: "2xx",
        }),
        expect.objectContaining({
          kind: "authorization-server",
          scope: "origin",
          statusClass: "3xx",
        }),
        expect.objectContaining({
          kind: "openid-configuration",
          scope: "origin",
          statusClass: "4xx",
        }),
        expect.objectContaining({
          kind: "registration",
          scope: "origin",
          statusClass: "5xx",
        }),
        expect.objectContaining({
          kind: "token",
          scope: "origin",
          statusClass: "network-error",
        }),
      ]);
    });

    it("evicts the oldest discovery entries beyond the ten-entry capacity", async () => {
      let timestampMs = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => timestampMs++);
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

      const client = new HttpMcpClient("test-oauth-discovery-ring", oauthHttpPackage("test-oauth-discovery-ring"));
      const options = (client as any).getTransportOptions() as {
        fetch: typeof fetch;
      };

      for (let index = 0; index < 12; index += 1) {
        await options.fetch(
          `https://private-host.invalid/.well-known/oauth-authorization-server/private-path-${index}`,
        );
      }

      const trace = (client as any).getOAuthDiscoveryTrace();
      expect(trace).toHaveLength(10);
      expect(trace.map((entry: { timestampMs: number }) => entry.timestampMs)).toEqual([
        1_002, 1_003, 1_004, 1_005, 1_006, 1_007, 1_008, 1_009, 1_010, 1_011,
      ]);
      expect(trace.every((entry: { scope: string }) => entry.scope === "path-relative")).toBe(true);
    });

    it("attaches only the bounded classification trace to an OAuth error", async () => {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

      const client = new HttpMcpClient(
        "test-oauth-discovery-redaction",
        oauthHttpPackage("test-oauth-discovery-redaction"),
      );
      (client as any).initializeOAuthIfNeeded = vi.fn();
      (client as any).connect = vi.fn(async () => {
        const options = (client as any).getTransportOptions() as {
          fetch: typeof fetch;
        };
        await options.fetch(
          "https://mcp.swifteq.com/.well-known/oauth-authorization-server/api/mcp/sse?access_token=secret",
        );
        throw new Error("fetch failed");
      });

      let error: Error & { oauthDiscoveryTrace?: unknown };
      try {
        await client.connectWithOAuth();
        throw new Error("Expected connectWithOAuth to fail");
      } catch (caught) {
        error = caught as Error & { oauthDiscoveryTrace?: unknown };
      }
      const serialized = JSON.stringify(error.oauthDiscoveryTrace);

      expect(error.message).toContain(OAUTH_DISCOVERY_TRACE_ERROR_MARKER);
      expect(error.message).not.toContain("swifteq");
      expect(serialized).not.toContain("swifteq");
      expect(serialized).not.toContain("access_token");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("/api/mcp/sse");
      expect(error.oauthDiscoveryTrace).toEqual([
        expect.objectContaining({
          kind: "authorization-server",
          scope: "path-relative",
          statusClass: "4xx",
        }),
      ]);
    });
  });
});
