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

const { mockLogger, callbackServerInstances } = vi.hoisted(() => ({
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
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../utils/portFinder.js", () => ({
  findAvailablePort: vi.fn(async () => 5173),
  checkPortAvailable: vi.fn(async () => true),
}));

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = vi.fn(async () => null);
    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    state = vi.fn(async () => "csrf-state");
    invalidateCredentials = vi.fn(async () => {});
  }
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

vi.mock("../../auth/callbackServer.js", () => {
  class MockOAuthCallbackServer {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    // The user completes sign-in: the callback delivers an auth code.
    waitForCallback = vi.fn(async () => "auth-code-123");
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
    // the browser flow is in flight).
    connectWithOAuth = vi.fn(() => new Promise<never>(() => {}));
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
  });

  it("propagates a hung token exchange as an error outcome, never auth_required", async () => {
    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID, wait_for_completion: true },
      createRegistry(),
      createCatalog(),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).not.toBe("auth_required");
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("OAuth token exchange timed out");
    // Honest outcome copy — not the "check browser for OAuth prompt" pending state.
    expect(parsed.message).not.toContain("check browser");

    // The callback server must still be torn down (finally block).
    expect(callbackServerInstances).toHaveLength(1);
    expect(callbackServerInstances[0].stop).toHaveBeenCalledTimes(1);
  });
});
