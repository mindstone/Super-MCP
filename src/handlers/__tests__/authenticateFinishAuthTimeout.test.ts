import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

// Stage 7 of docs/plans/260728_mcp-connector-setup-failures (app repo), audit F1:
// the finishAuth timeout race (httpClient.ts finishOAuth) rejects with a clear
// error, but handleAuthenticate's catch used to treat it as NON-fatal (only
// "OAuth setup failed:"-prefixed messages were fatal), discard it, and return
// status "auth_required" ("check browser for OAuth prompt") — so the desktop
// never saw the timeout. The timeout must be classified by machine code
// (OAUTH_FINISH_AUTH_TIMEOUT_CODE), not message prefix, and propagate as an
// error outcome.

const { mockLogger, callbackServerInstances, connectError, hangCallback } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  callbackServerInstances: [] as Array<{
    setServiceId: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    waitForCallback: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  // When set, the mock's connectWithOAuth rejects with this error — the
  // fatal-setup stimulus (DCR refusal / connect timeout) for Stage 5 (c).
  connectError: { current: null as Error | null },
  // When true, the mock's callback wait never settles — a fatal connect
  // error then wins the race (in the default shape the immediate mock
  // callback would resolve first and mask the fatal branch).
  hangCallback: { current: false },
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../utils/portFinder.js", () => ({
  findAvailablePort: vi.fn(async () => 5173),
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
  getOAuthCallbackPortCandidates: vi.fn(() => [5173, 8080, 5174]),
}));

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = vi.fn(async () => null);
    static hasPersistedAccessToken = vi.fn(async () => false);
    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    state = vi.fn(async () => "csrf-state");
    invalidateCredentials = vi.fn(async () => {});
    setSkipAuthorizeProbe = vi.fn();
    consumeProbeVerdict = vi.fn(() => undefined);
  }
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

vi.mock("../../auth/callbackServer.js", () => {
  class MockOAuthCallbackServer {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    // The user completes sign-in: the callback delivers an auth code —
    // unless the test hung the callback (fatal-connect race shape).
    waitForCallback = vi.fn(() =>
      hangCallback.current
        ? new Promise<never>(() => {})
        : Promise.resolve("auth-code-123"),
    );
    stop = vi.fn(async () => {});
    constructor() {
      callbackServerInstances.push(this);
    }
  }
  return { OAuthCallbackServer: MockOAuthCallbackServer };
});

vi.mock("../../clients/httpClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../clients/httpClient.js")>();
  class MockHttpMcpClient {
    // Redirect initiated; the connect promise stays pending (expected shape while
    // the browser flow is in flight) — unless the test armed a fatal setup
    // failure (DCR refusal / connect timeout).
    connectWithOAuth = vi.fn(() =>
      connectError.current
        ? Promise.reject(connectError.current)
        : new Promise<never>(() => {}),
    );
    // The bounded finishOAuth rejecting with its timeout code — exactly what the
    // real race does when the transport's finishAuth hangs (that rejection shape,
    // including the code, is pinned by
    // src/clients/__tests__/finishAuthTimeout.test.ts).
    finishOAuth = vi.fn(async () => {
      const timeoutError = new Error(
        `OAuth token exchange timed out after ${actual.FINISH_AUTH_TIMEOUT_MS}ms`,
      );
      (timeoutError as NodeJS.ErrnoException).code = actual.OAUTH_FINISH_AUTH_TIMEOUT_CODE;
      throw timeoutError;
    });
    // Only reachable if the handler wrongly swallows the timeout and falls
    // through to the generic health probe (the pre-fix behavior).
    healthCheck = vi.fn(async () => "needs_auth" as const);
    close = vi.fn(async () => {});
  }
  return { ...actual, HttpMcpClient: MockHttpMcpClient };
});

const PACKAGE_ID = "Linear-mindstone";

function createRegistry(): PackageRegistry {
  const registry = {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "http",
      base_url: "https://mcp.example.com/mcp",
      oauth: true,
    }),
    // Pre-check: no usable client — fall through to the OAuth setup path.
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map<string, unknown>(),
  };
  return registry as unknown as PackageRegistry;
}

function createCatalog(): Catalog {
  return { clearPackage: vi.fn() } as unknown as Catalog;
}

describe("handleAuthenticate finishAuth timeout classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callbackServerInstances.length = 0;
    connectError.current = null;
    hangCallback.current = false;
  });

  it("propagates a hung token exchange as an error outcome, never auth_required", async () => {
    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID, wait_for_completion: true },
      createRegistry(),
      createCatalog(),
    );

    const parsed = JSON.parse(result.content[0].text);
    // Coded classification unchanged: the branch is taken on the machine code
    // (OAUTH_FINISH_AUTH_TIMEOUT_CODE), never falling through to the pending
    // "check browser for OAuth prompt" (auth_required) response.
    expect(parsed.status).not.toBe("auth_required");
    expect(parsed.status).toBe("error");
    expect(result.isError).toBe(false);

    // The user-visible field (`error`) carries the friendly copy — the desktop
    // (mcpService.ts) computes `errorMessage = errorDetails.message ||
    // messageDetails.message || 'Authentication failed'`, so `parsed.error`
    // wins. The raw internal detail is preserved in `message` for logs.
    expect(parsed.error).toMatch(/took too long.*stopped waiting.*try connecting again/s);
    expect(parsed.error).not.toContain("token exchange");
    expect(parsed.message).toContain("OAuth token exchange timed out");
    expect(parsed.message).not.toContain("check browser");

    // Stage 5 (b): the calibrated provider-side hint rides the residual
    // timeout copy — conditional phrasing only (a token-exchange-time
    // rejection or a non-conformant AS still lands here, so the copy must
    // not promise we detect every provider-side rejection).
    expect(parsed.error).toMatch(/[Ii]f the provider's sign-in page showed an error/);
    expect(parsed.error).toMatch(/their side/);
    expect(parsed.error).not.toMatch(/redirect_?uri|DCR|Auth0/i);

    // The callback server must still be torn down (finally block).
    expect(callbackServerInstances).toHaveLength(1);
    expect(callbackServerInstances[0].stop).toHaveBeenCalledTimes(1);
  });

  it("fatal setup failure: friendly copy in `error`, technical detail in `message` (REBEL-7F9 Stage 5 (c))", async () => {
    // The finishAuth-copy precedent (audit F1 / Stage 7 review F1): the
    // desktop displays parsed.error first and only falls back to
    // parsed.message, so the friendly copy must live in `error` and the raw
    // internal detail in `message`. The isFatalSetupError branch predates
    // that precedent and was inverted (raw "OAuth setup failed: …" in
    // `error`, friendly guidance in `message`).
    hangCallback.current = true; // the fatal connect error must win the race
    connectError.current = new Error("does not support dynamic client registration");

    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID, wait_for_completion: true },
      createRegistry(),
      createCatalog(),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    // User-facing field: plain-language, actionable, jargon-free.
    // Stage 5 refinement (F4): says what to DO next (the connector's help
    // page / its support), with "manual configuration" and "pre-registered
    // sign-in details" de-jargoned.
    expect(parsed.error).toMatch(/couldn't set up automatic sign-in/);
    expect(parsed.error).toMatch(/API key/i);
    expect(parsed.error).toMatch(/help page|support/i);
    expect(parsed.error).not.toMatch(/manual configuration|pre-registered/i);
    expect(parsed.error).not.toContain("OAuth setup failed");
    expect(parsed.error).not.toContain("dynamic client registration");
    expect(parsed.error).not.toMatch(/redirect_?uri|DCR|Auth0/i);
    // Technical detail preserved for logs/diagnostics in `message`.
    expect(parsed.message).toContain("OAuth setup failed");
    expect(parsed.message).toContain("does not support dynamic client registration");

    expect(callbackServerInstances).toHaveLength(1);
    expect(callbackServerInstances[0].stop).toHaveBeenCalledTimes(1);
  });
});
