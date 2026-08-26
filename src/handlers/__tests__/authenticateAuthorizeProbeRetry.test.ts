import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";
import { checkPortAvailable, findAvailablePortFromCandidates } from "../../utils/portFinder.js";
import { SimpleOAuthProvider } from "../../auth/providers/simple.js";
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
  uncodedRejectionPorts,
  omitVerdictPorts,
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
  // Rejected ports where the mock records the verdict but throws an UNcoded
  // generic Error — simulating an SDK re-wrap that drops .code (testing F2:
  // pins the verdict disjunct of the handler's OR-classifier on its own).
  uncodedRejectionPorts: new Set<number>(),
  // Rejected ports where the mock throws the coded error but records NO
  // verdict (pins the code disjunct on its own).
  omitVerdictPorts: new Set<number>(),
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
    static async readNeedsReconnectMarkerState() {
      return { state: "absent" as const };
    }

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
    // like a real browser redirect). A hang port's callback NEVER arrives and
    // the wait times out — a 25ms scaled stand-in for the real
    // OAUTH_CALLBACK_TIMEOUT_MS so the suite stays fast; it also makes losing
    // callback promises genuinely REJECT after the race settles, exercising
    // isolation clause (d)'s suppression for real.
    waitForCallback = vi.fn((timeoutMs: number, state?: string) => {
      const port = this.port;
      return new Promise<string>((resolve, reject) => {
        if (hangPorts.has(port)) {
          setTimeout(() => reject(new Error("OAuth callback timeout")), 25);
        } else {
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
    // Tracks a completed token exchange so healthCheck can distinguish a
    // completed flow from a pending/timed-out one (the real client answers
    // needs_auth without tokens).
    finishedAuth = false;
    finishOAuth = vi.fn(async () => {
      if (finishAuthError.current) {
        throw finishAuthError.current;
      }
      this.finishedAuth = true;
    });
    healthCheck = vi.fn(async () => (this.finishedAuth ? ("ok" as const) : ("needs_auth" as const)));
    close = vi.fn(async () => {});
    // Stage 4a: the pending path ("redirect started, callback never
    // arrived") asks the client for the diagnostics suffix that rides the
    // auth_required response message.
    getOAuthDiagnosticsSuffix = vi.fn(
      (extras?: { priorProbeVerdicts?: Array<Record<string, unknown>> }) =>
        `\n[super-mcp-oauth-discovery-trace:v1]${JSON.stringify({
          callbackPort: this.oauthPort,
          probeVerdicts: extras?.priorProbeVerdicts ?? [],
        })}`,
    );
    connectWithOAuth = vi.fn(async () => {
      const provider = this.oauthProvider;
      if (provider?.skipProbe) {
        // Browser-floor / probe-skipped attempt: browser opens; connect stays
        // pending while the flow is in flight (today's shape).
        return new Promise<never>(() => {});
      }
      // k3 F5: NO env-var gate here — the mock ALWAYS emits the classified-
      // rejection stimulus for rejectPorts. The handler's own kill-switch
      // gates (maxAttempts = 1, !probeDisabled in the classifier) must be what
      // ignores it on the disabled path; a mock that internalized the gate
      // could not detect their removal.
      if (rejectPorts.has(this.oauthPort)) {
        // What the real provider + SDK 1.28.0 do on a classified rejection:
        // record the verdict out-of-band, then throw the coded error.
        if (!omitVerdictPorts.has(this.oauthPort)) {
          provider.probeVerdict = {
            outcome: "rejected",
            status: 403,
            matchedPhrase: "Callback URL mismatch",
          };
        }
        if (uncodedRejectionPorts.has(this.oauthPort)) {
          // SDK re-wrap simulation: the verdict channel carries the signal;
          // the thrown error lost its .code. The message is deliberately
          // neither auth-like NOR fatal-classified (no timeout/DCR tokens) —
          // the real probe message is too — so the race settles via the
          // (scaled) callback timeout, and the handler classifies on the
          // verdict channel alone.
          throw new Error("SDK re-wrapped transport error during authorization redirect");
        }
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
  // testing F3: resetAllMocks (not clearAllMocks) — clearAllMocks leaves mock
  // IMPLEMENTATIONS in place, leaking resolved values across tests (the
  // kill-switch test's skip-predicate inputs were order-dependent). Re-
  // establish the static/module defaults explicitly below.
  vi.resetAllMocks();
  (checkPortAvailable as any).mockResolvedValue(true);
  (findAvailablePortFromCandidates as any).mockImplementation(
    async (candidates: number[]) => candidates[0],
  );
  (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
  (SimpleOAuthProvider.hasPersistedAccessToken as any).mockResolvedValue(false);
  callbackServerInstances.length = 0;
  providerInstances.length = 0;
  httpClientInstances.length = 0;
  rejectPorts.clear();
  hangPorts.clear();
  uncodedRejectionPorts.clear();
  omitVerdictPorts.clear();
  finishAuthError.current = null;
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

afterEach(() => {
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

describe("authorize-probe rejection retry loop (REBEL-7F9 repro pin)", () => {
  it("saved port 5173 rejected → attempt 2 at 8080 succeeds (the reported user's exact state)", async () => {
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    (SimpleOAuthProvider.hasPersistedAccessToken as any).mockResolvedValue(false);
    rejectPorts.add(5173);

    const { registry, parsed } = await run();

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

    // (e) the clients registry holds exactly the ACCEPTED attempt's client —
    // the rejected attempt's clients.delete/set left no residue. (clients is
    // private on PackageRegistry; reach the test double's map via a cast.)
    const clientsMap = (registry as unknown as { clients: Map<string, unknown> }).clients;
    expect(clientsMap.size).toBe(1);
    expect(clientsMap.get(PACKAGE_ID)).toBe(httpClientInstances[1]);

    // The saved-5173 user has no prior tokens → the probe still runs (no skip).
    expect(providerInstances[0].setSkipAuthorizeProbe).toHaveBeenCalledWith(false);
  }, 10_000);

  it("probe skipped on saved-port reuse WITH a prior successful token exchange", async () => {
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
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);

    const { parsed } = await run();

    expect(parsed.status).toBe("authenticated");
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
  }, 10_000);

  it("verdict channel alone classifies the rejection: SDK re-wrap strips .code, loop still advances the port (testing F2)", async () => {
    // The mock records the verdict but throws an UNcoded generic Error. The
    // handler's fatal-connect classifier sees neither the code nor a fatal
    // message, so the race settles via the (scaled) callback timeout — and
    // the catch classifies on the VERDICT disjunct alone. Deleting
    // `probeVerdict?.outcome === "rejected"` from authenticate.ts turns this
    // into a pending fall-through (auth_required), so the pin is non-vacuous.
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    rejectPorts.add(5173);
    uncodedRejectionPorts.add(5173);
    hangPorts.add(5173); // browser never opened → the callback never arrives

    const { parsed } = await run();

    expect(parsed.status).toBe("authenticated");
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
    expect(providerInstances[0].invalidateCredentials).toHaveBeenCalledWith("client");
  }, 10_000);

  it("error code alone classifies the rejection: verdict channel absent, coded error survives (testing F2)", async () => {
    // The mock throws the coded error but records NO verdict. Deleting the
    // `.code === OAUTH_REDIRECT_URI_REJECTED_CODE` disjunct from the
    // authenticate.ts catch turns this into a pending fall-through
    // (auth_required), so the pin is non-vacuous.
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    rejectPorts.add(5173);
    omitVerdictPorts.add(5173);

    const { parsed } = await run();

    expect(parsed.status).toBe("authenticated");
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
    expect(providerInstances[0].invalidateCredentials).toHaveBeenCalledWith("client");
  }, 10_000);

  it("bounded at MAX_PORT_ATTEMPTS probe attempts, then the browser-open floor runs today's wait (recall#2 F1(b))", async () => {
    // Uniform rejection: EVERY candidate is classified-rejected.
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

  it("floor hang variant (k3 F3 + Stage 5 refinement F2): floor browser opens but the callback never arrives → DISTINCT auth_floor_exhausted after the bounded wait", async () => {
    // Uniform rejection, and the floor's port never delivers a callback.
    // Stage 5 refinement (F2): this post-callback-wait-elapsed FLOOR outcome
    // must NOT exit through the live-pending auth_required string ("check
    // browser for OAuth prompt" — says "OAuth", points at a browser page that
    // already failed, no provider-side hint; and auth_required is also the
    // legitimate still-waiting surface — researcher F9's conflation hazard).
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);
    rejectPorts.add(8080);
    rejectPorts.add(5174);
    hangPorts.add(5173); // the floor re-opens the FIRST rejected candidate

    const { parsed } = await run();

    expect(parsed.status).toBe("auth_floor_exhausted");
    // Distinct, honest, jargon-free message — never the stale pending string.
    const messageBase = parsed.message.split("\n[super-mcp-oauth-discovery-trace:v1]")[0];
    expect(messageBase).not.toContain("check browser");
    expect(messageBase).not.toMatch(/OAuth|redirect_?uri|DCR|Auth0|localhost/i);
    expect(messageBase).toMatch(/their side/i);
    // The Stage 4 diagnostics suffix still rides the message for the desktop.
    expect(parsed.message).toContain("[super-mcp-oauth-discovery-trace:v1]");
    // 3 probe attempts + 1 floor attempt (skip-probe ⇒ browser opened).
    expect(httpClientInstances).toHaveLength(4);
    expect(providerInstances[3].setSkipAuthorizeProbe).toHaveBeenCalledWith(true);
    expect(callbackServerInstances[3].port).toBe(5173);
    // The floor attempt never invalidates and its client stays pending.
    expect(providerInstances[3].invalidateCredentials).not.toHaveBeenCalled();
  }, 15_000);

  it("isolation (d): a losing callback promise that rejects AFTER the race settled cannot affect subsequent attempts", async () => {
    // Attempt-1's callback wait rejects at 25ms — AFTER the probe rejection
    // already settled its race. The late rejection must not corrupt attempt
    // 2's flow or outcome.
    //
    // Mutation note (recorded from an actual mutation run): deleting the
    // catch-site `callbackPromise?.catch(() => {})` suppression in
    // authenticate.ts does NOT fail this test — Promise.race's internal
    // reactions already count the loser as handled, so an
    // unhandledRejection detector can never fire for these promises. The
    // detector below is kept as a canary for OTHER stray rejections in the
    // flow; the real pin here is outcome isolation.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
      rejectPorts.add(5173);
      hangPorts.add(5173);
      const { parsed } = await run();
      expect(parsed.status).toBe("authenticated");
      expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  }, 10_000);

  it("static-cred connector: classified rejection → fast coded error, NO port advance, NO invalidation", async () => {
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(undefined);
    rejectPorts.add(5173);

    const { parsed } = await run({ oauthClientId: "static-client-id", oauthClientSecret: "secret" });

    expect(parsed.status).toBe("error");
    expect(parsed.code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);
    // Exactly one attempt: no retry, no invalidation (simple.ts:905-916
    // hazard — a futile retry must never invalidate WORKING static tokens).
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].invalidateCredentials).not.toHaveBeenCalled();

    // Stage 5 (a) + refinement (F3) copy shape: the user-facing `error`
    // field (the field the desktop displays first) must say — the provider's
    // sign-in page rejected the connection; the problem is on THEIR side;
    // here's what to do. F3: ONE primary action — the in-app bug report —
    // leads; the remaining asks are demoted to a trailing "you can also".
    expect(parsed.error).toMatch(/sign-in page rejected the connection/);
    expect(parsed.error).toMatch(/their side, not yours/);
    expect(parsed.error).toMatch(/bug report/i);
    expect(parsed.error.indexOf("bug report")).toBeLessThan(parsed.error.search(/try again later/i));
    expect(parsed.error).toMatch(/try again later/i);
    expect(parsed.error).toMatch(/their support/i);
    // Technical detail stays OUT of the user-facing field: no ports, no
    // OAuth-internals jargon, no vendor names.
    expect(parsed.error).not.toMatch(/redirect_?uri|DCR|Auth0|localhost|callback URL/i);
    expect(parsed.error).not.toMatch(/\b\d{4,5}\b/);
  }, 10_000);

  it("kill-switch SUPER_MCP_OAUTH_PROBE_DISABLE=1: a coded-rejection stimulus on the wire is IGNORED — single attempt, no retry, no invalidation (k3 F5)", async () => {
    process.env.SUPER_MCP_OAUTH_PROBE_DISABLE = "1";
    (SimpleOAuthProvider.getSavedClientPort as any).mockResolvedValue(5173);
    // Hostile stimulus: the mock emits the classified-rejection verdict +
    // coded error UNCONDITIONALLY (no env gate in the mock). Only the
    // handler's own gates (maxAttempts = 1; !probeDisabled in the classifier)
    // can keep the disabled path byte-identical to today.
    rejectPorts.add(5173);

    const { parsed } = await run();

    // No retry, no invalidation: the disabled path must not act on the
    // stimulus even though it arrived.
    expect(providerInstances).toHaveLength(1);
    expect(httpClientInstances).toHaveLength(1);
    expect(providerInstances[0].invalidateCredentials).not.toHaveBeenCalled();
    // The single attempt degrades to today's non-completing outcome (the
    // browser flow never completes in this stimulus shape) instead of
    // advancing the port.
    expect(parsed.status).toBe("auth_required");
  }, 10_000);

  it("finishAuth timeout on an accepted attempt still classifies by its own code (no interference)", async () => {
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
