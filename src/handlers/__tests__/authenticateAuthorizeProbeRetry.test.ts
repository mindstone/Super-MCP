import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";
import { OAUTH_REDIRECT_URI_REJECTED_CODE, type AuthorizeProbeVerdict } from "../../auth/authorizeProbe.js";

// REBEL-7F9 Stage 3 repro pin + isolation contract (bug_mode red-first).
// Pre-fix behavior: a classified redirect_uri rejection at /authorize opens
// the browser anyway and the callback wait hangs the full 300s (desktop:
// 120s -32001 "Request timed out"). Post-fix: fast coded error + bounded port
// retry with per-attempt isolation (a)-(h) and a browser-open floor.
//
// The module-mock seam mirrors authenticateFinishAuthTimeout.test.ts.

const {
  mockLogger,
  callbackServerInstances,
  providerInstances,
  httpClientInstances,
  rejectPorts,
  hangPorts,
  finishAuthError,
} = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  callbackServerInstances: [] as any[],
  providerInstances: [] as any[],
  httpClientInstances: [] as any[],
  // Ports whose authorize URL the (mock) provider's probe classifies as a
  // redirect_uri rejection (the coded throw out of redirectToAuthorization).
  rejectPorts: new Set<number>(),
  // Ports whose browser callback never arrives (the pre-fix hang shape).
  // Kept separate from rejectPorts: a classified rejection kills the attempt
  // at the probe, so the callback wait never gets a chance to hang.
  hangPorts: new Set<number>(),
  // When set, the mock's finishOAuth rejects with this error (coded finishAuth
  // timeout shape) instead of resolving.
  finishAuthError: { current: null as Error | null },
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

vi.mock("../../utils/portFinder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/portFinder.js")>();
  return {
    ...actual,
    checkPortAvailable: vi.fn(async () => true),
    // First candidate is always free in these tests.
    findAvailablePortFromCandidates: vi.fn(async (candidates: number[]) => candidates[0]),
  };
});

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = vi.fn(async () => undefined);
    static hasPersistedAccessToken = vi.fn(async () => false);

    oauthPort: number;
    skipProbe = false;
    probeVerdict?: AuthorizeProbeVerdict;
    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    invalidateCredentials = vi.fn(async () => {});
    setSkipAuthorizeProbe = vi.fn((skip: boolean) => {
      this.skipProbe = skip;
    });
    consumeProbeVerdict = vi.fn(() => {
      const verdict = this.probeVerdict;
      this.probeVerdict = undefined;
      return verdict;
    });
    // (c) fresh state per attempt (fresh provider ⇒ distinct value).
    state = vi.fn(async () => `state-${providerInstances.length}-${Math.random()}`);

    constructor(_packageId: string, oauthPort: number) {
      this.oauthPort = oauthPort;
      providerInstances.push(this);
    }
  }
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

vi.mock("../../auth/callbackServer.js", () => {
  class MockOAuthCallbackServer {
    port: number;
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    // Genuinely async: the ACCEPTED attempt's callback arrives (a tick later,
    // like a real browser redirect); a rejected/hung port's callback NEVER
    // arrives — exactly the pre-fix hang shape.
    waitForCallback = vi.fn((timeoutMs: number, state?: string) => {
      const port = this.port;
      return new Promise<string>((resolve) => {
        if (!hangPorts.has(port)) {
          setTimeout(() => resolve("auth-code-123"), 0);
        }
      });
    });
    constructor(port: number) {
      this.port = port;
      callbackServerInstances.push(this);
    }
  }
  return { OAuthCallbackServer: MockOAuthCallbackServer };
});

vi.mock("../../clients/httpClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../clients/httpClient.js")>();
  class MockHttpMcpClient {
    oauthPort: number;
    oauthProvider: any;
    finishOAuth = vi.fn(async () => {
      if (finishAuthError.current) {
        throw finishAuthError.current;
      }
    });
    healthCheck = vi.fn(async () => "ok" as const);
    close = vi.fn(async () => {});
    connectWithOAuth = vi.fn(async () => {
      const provider = this.oauthProvider;
      if (provider?.skipProbe) {
        // Browser-floor / probe-skipped attempt: browser opens; connect stays
        // pending while the flow is in flight (today's shape).
        return new Promise<never>(() => {});
      }
      if (rejectPorts.has(this.oauthPort) && process.env.SUPER_MCP_OAUTH_PROBE_DISABLE !== "1") {
        // What the real provider + SDK 1.28.0 do on a classified rejection:
        // record the verdict out-of-band, then throw the coded error.
        provider.probeVerdict = {
          outcome: "rejected",
          status: 403,
          matchedPhrase: "Callback URL mismatch",
        };
        const error = new Error(
          "The provider's sign-in page rejected this connection's registered callback address before the browser was opened (callback URL mismatch).",
        );
        (error as NodeJS.ErrnoException).code = OAUTH_REDIRECT_URI_REJECTED_CODE;
        throw error;
      }
      return new Promise<never>(() => {});
    });
    constructor(_packageId: string, _config: unknown, options?: any) {
      this.oauthPort = options?.oauthPort ?? 5173;
      this.oauthProvider = options?.oauthProvider;
      httpClientInstances.push(this);
    }
  }
  return { ...actual, HttpMcpClient: MockHttpMcpClient };
});

const PACKAGE_ID = "swifteq-zendesk";

function createRegistry(pkgOverrides: Record<string, unknown> = {}): PackageRegistry {
  const registry = {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "http",
      base_url: "https://mcp.swifteq.com/api/mcp/sse",
      oauth: true,
      ...pkgOverrides,
    }),
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map<string, unknown>(),
  };
  return registry as unknown as PackageRegistry;
}

function createCatalog(): Catalog {
  return { clearPackage: vi.fn() } as unknown as Catalog;
}

async function run(pkgOverrides: Record<string, unknown> = {}) {
  const registry = createRegistry(pkgOverrides);
  const result = await handleAuthenticate(
    { package_id: PACKAGE_ID, wait_for_completion: true },
    registry,
    createCatalog(),
  );
  return { registry, parsed: JSON.parse(result.content[0].text), result };
}

beforeEach(() => {
  vi.clearAllMocks();
  callbackServerInstances.length = 0;
  providerInstances.length = 0;
  httpClientInstances.length = 0;
  rejectPorts.clear();
  hangPorts.clear();
  finishAuthError.current = null;
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

afterEach(() => {
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

describe("authorize-probe rejection retry loop (REBEL-7F9 repro pin)", () => {
  it("saved port 5173 rejected → attempt 2 at 8080 succeeds (the reported user's exact state)", async () => {
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    (SimpleOAuthProvider.hasPersistedAccessToken as any).mockResolvedValue(false);
    rejectPorts.add(5173);

    const { parsed } = await run();

    expect(parsed.status).toBe("authenticated");

    // Two attempts: 5173 (rejected) then 8080 (accepted).
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
    expect(callbackServerInstances.map((s) => s.port)).toEqual([5173, 8080]);

    // (a) the attempt-1 saved client registration was invalidated — THE port
    // advancement mechanism (client scope only; tokens are not touched).
    expect(providerInstances[0].invalidateCredentials).toHaveBeenCalledWith("client");
    expect(providerInstances[0].invalidateCredentials).toHaveBeenCalledTimes(1);

    // (b) attempt-1 callback server stopped+awaited before the next attempt.
    expect(callbackServerInstances[0].stop).toHaveBeenCalledTimes(1);

    // (f) attempt-1 httpClient closed.
    expect(httpClientInstances[0].close).toHaveBeenCalledTimes(1);

    // (h) a fresh provider per attempt.
    expect(providerInstances).toHaveLength(2);
    expect(providerInstances[0]).not.toBe(providerInstances[1]);

    // (c) fresh oauthState per attempt: the two callback waits used distinct states.
    const state1 = callbackServerInstances[0].waitForCallback.mock.calls[0][1];
    const state2 = callbackServerInstances[1].waitForCallback.mock.calls[0][1];
    expect(state1).toBeTruthy();
    expect(state2).toBeTruthy();
    expect(state1).not.toBe(state2);

    // The saved-5173 user has no prior tokens → the probe still runs (no skip).
    expect(providerInstances[0].setSkipAuthorizeProbe).toHaveBeenCalledWith(false);
  }, 10_000);

  it("probe skipped on saved-port reuse WITH a prior successful token exchange", async () => {
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    (SimpleOAuthProvider.hasPersistedAccessToken as any).mockResolvedValue(true);
    // No rejections — the flow is today's happy path.
    const { parsed } = await run();
    expect(parsed.status).toBe("authenticated");
    expect(providerInstances[0].setSkipAuthorizeProbe).toHaveBeenCalledWith(true);
  }, 10_000);

  it("retry candidates are [8080, 5173…5182] minus failed ports REGARDLESS of attempt-1 port (recall#2 F3)", async () => {
    // Fresh registration (no saved port): attempt 1 = 5173 (candidate order),
    // rejected → attempt 2 must be 8080 even though attempt 1 was NOT a saved
    // port.
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);

    const { parsed } = await run();

    expect(parsed.status).toBe("authenticated");
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
  }, 10_000);

  it("bounded at MAX_PORT_ATTEMPTS probe attempts, then the browser-open floor runs today's wait (recall#2 F1(b))", async () => {
    // Uniform rejection: EVERY candidate is classified-rejected.
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);
    rejectPorts.add(8080);
    rejectPorts.add(5174);

    const { parsed } = await run();

    // The floor opened the browser on the FIRST classified-rejection candidate
    // and ran today's callback wait — degrading to exactly today's behavior,
    // never a terminal pre-browser failure.
    expect(parsed.status).toBe("authenticated");

    // 3 probe attempts + 1 floor attempt (skip-probe ⇒ browser opens).
    expect(httpClientInstances).toHaveLength(4);
    expect(providerInstances).toHaveLength(4);
    expect(providerInstances[3].setSkipAuthorizeProbe).toHaveBeenCalledWith(true);
    expect(callbackServerInstances[3].port).toBe(5173);

    // Each rejected attempt invalidated its client registration (port
    // advancement); the floor attempt did not.
    expect(providerInstances[0].invalidateCredentials).toHaveBeenCalledWith("client");
    expect(providerInstances[1].invalidateCredentials).toHaveBeenCalledWith("client");
    expect(providerInstances[2].invalidateCredentials).toHaveBeenCalledWith("client");
    expect(providerInstances[3].invalidateCredentials).not.toHaveBeenCalled();

    // No leaked callback servers.
    for (const server of callbackServerInstances) {
      expect(server.stop).toHaveBeenCalled();
    }
  }, 15_000);

  it("static-cred connector: classified rejection → fast coded error, NO port advance, NO invalidation", async () => {
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);

    const { parsed } = await run({ oauthClientId: "static-client-id", oauthClientSecret: "secret" });

    expect(parsed.status).toBe("error");
    expect(parsed.code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);
    // Exactly one attempt: no retry, no invalidation (simple.ts:905-916
    // hazard — a futile retry must never invalidate WORKING static tokens).
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].invalidateCredentials).not.toHaveBeenCalled();
  }, 10_000);

  it("kill-switch SUPER_MCP_OAUTH_PROBE_DISABLE=1: single attempt, no invalidation, today's flow", async () => {
    process.env.SUPER_MCP_OAUTH_PROBE_DISABLE = "1";
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    // Even with a rejection-shaped verdict on the wire, the disabled path must
    // not retry or invalidate — it is byte-identical to today.
    rejectPorts.add(5173);

    const { parsed } = await run();

    // No probe ⇒ no classified rejection acted on: single attempt, browser
    // flow runs today's course (the mock's 5173 callback resolves → success).
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].invalidateCredentials).not.toHaveBeenCalled();
    expect(parsed.status).toBe("authenticated");
  }, 10_000);

  it("finishAuth timeout on an accepted attempt still classifies by its own code (no interference)", async () => {
    const { SimpleOAuthProvider } = await import("../../auth/providers/simple.js");
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    const { FINISH_AUTH_TIMEOUT_MS, OAUTH_FINISH_AUTH_TIMEOUT_CODE } = await import(
      "../../clients/httpClient.js"
    );
    // Accepted attempt whose token exchange hangs — the pre-existing coded
    // branch must still fire inside the new loop.
    finishAuthError.current = Object.assign(
      new Error(`OAuth token exchange timed out after ${FINISH_AUTH_TIMEOUT_MS}ms`),
      { code: OAUTH_FINISH_AUTH_TIMEOUT_CODE },
    );
    const { parsed } = await run();
    expect(parsed.status).toBe("error");
    expect(parsed.error).toMatch(/took too long/);
    // No retry on a finishAuth timeout: exactly one attempt.
    expect(providerInstances).toHaveLength(1);
  }, 10_000);
});
