import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";
import { checkPortAvailable, findAvailablePortFromCandidates } from "../../utils/portFinder.js";
import { SimpleOAuthProvider } from "../../auth/providers/simple.js";
import { OAUTH_REDIRECT_URI_REJECTED_CODE, type AuthorizeProbeVerdict } from "../../auth/authorizeProbe.js";

// REBEL-7F9 Stage 4a handler wiring: the OAuth diagnostics trace must fire
// on the "redirect started, callback never arrived" path — the bug class
// where connectWithOAuth swallows the EXPECTED auth-like redirect error and
// the old trace could never attach. The diagnostics suffix rides the final
// auth_required response message (the desktop extracts + strips it via
// extractOAuthDiscoveryTraceFromError), carrying per-attempt probe verdicts
// aggregated across the retry loop.
//
// The module-mock seam mirrors authenticateAuthorizeProbeRetry.test.ts; the
// mock client's getOAuthDiagnosticsSuffix is a faithful-enough stand-in
// (marker + JSON of the port + the extras the handler passed) — the real
// payload contents are pinned in clients/__tests__/oauthDiagnosticsTrace.test.ts.

const TRACE_MARKER = "\n[super-mcp-oauth-discovery-trace:v1]";

const {
  mockLogger,
  callbackServerInstances,
  providerInstances,
  httpClientInstances,
  rejectPorts,
  hangPorts,
} = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  callbackServerInstances: [] as any[],
  providerInstances: [] as any[],
  httpClientInstances: [] as any[],
  rejectPorts: new Set<number>(),
  hangPorts: new Set<number>(),
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

vi.mock("../../utils/portFinder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/portFinder.js")>();
  return {
    ...actual,
    checkPortAvailable: vi.fn(async () => true),
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
    // Stage 4: the NON-consuming trace slot — the retry loop's classification
    // drains the consume-once slot above, so the diagnostics payload reads
    // this mirror instead (mirrors simple.ts probeVerdictForTrace).
    probeVerdictTrace?: AuthorizeProbeVerdict;
    getProbeVerdictForTrace = vi.fn(function (this: any) {
      return this.probeVerdictTrace;
    });
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
    // Genuinely async, 25ms scaled stand-in for the real
    // OAUTH_CALLBACK_TIMEOUT_MS on hang ports (the "redirect started,
    // callback never arrived" shape).
    waitForCallback = vi.fn((_timeoutMs: number, _state?: string) => {
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
    finishedAuth = false;
    finishOAuth = vi.fn(async () => {
      this.finishedAuth = true;
    });
    healthCheck = vi.fn(async () => (this.finishedAuth ? ("ok" as const) : ("needs_auth" as const)));
    close = vi.fn(async () => {});
    // Faithful stand-in for the real method (buildOAuthDiagnosticsPayload):
    // marker + JSON carrying this attempt's port, the prior verdicts the
    // handler folded in, PLUS this attempt's own verdict from the provider's
    // non-consuming trace slot.
    getOAuthDiagnosticsSuffix = vi.fn(
      (extras?: { priorProbeVerdicts?: Array<Record<string, unknown>> }) => {
        const own = this.oauthProvider?.getProbeVerdictForTrace?.();
        return `${TRACE_MARKER}${JSON.stringify({
          callbackPort: this.oauthPort,
          probeVerdicts: [
            ...(extras?.priorProbeVerdicts ?? []),
            ...(own
              ? [{ port: this.oauthPort, outcome: own.outcome, status: own.status, hint: own.matchedPhrase }]
              : []),
          ],
        })}`;
      },
    );
    connectWithOAuth = vi.fn(async () => {
      const provider = this.oauthProvider;
      if (provider?.skipProbe) {
        return new Promise<never>(() => {});
      }
      if (rejectPorts.has(this.oauthPort)) {
        provider.probeVerdict = {
          outcome: "rejected",
          status: 403,
          matchedPhrase: "Callback URL mismatch",
        };
        provider.probeVerdictTrace = provider.probeVerdict;
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
  const result = await handleAuthenticate(
    { package_id: PACKAGE_ID, wait_for_completion: true },
    createRegistry(pkgOverrides),
    createCatalog(),
  );
  return JSON.parse(result.content[0].text);
}

function extractSuffix(message: string): { base: string; payload: any } {
  const idx = message.lastIndexOf(TRACE_MARKER);
  expect(idx, `expected diagnostics marker in: ${message}`).toBeGreaterThan(-1);
  return {
    base: message.slice(0, idx),
    payload: JSON.parse(message.slice(idx + TRACE_MARKER.length)),
  };
}

beforeEach(() => {
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
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

afterEach(() => {
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

describe("diagnostics fire on 'redirect started, callback never arrived' (REBEL-7F9 Stage 4a)", () => {
  it("accepted attempt whose callback never arrives: auth_required message carries the diagnostics suffix", async () => {
    hangPorts.add(5173);

    const parsed = await run();

    expect(parsed.status).toBe("auth_required");
    const { base, payload } = extractSuffix(parsed.message);
    // The user-facing text is unchanged — the desktop strips the suffix.
    expect(base).toBe("Authentication required - check browser for OAuth prompt");
    expect(payload.callbackPort).toBe(5173);
  });

  it("retry-then-hang: the pending attempt's suffix aggregates the earlier rejected attempt's verdict", async () => {
    rejectPorts.add(5173);
    hangPorts.add(8080);

    const parsed = await run();

    expect(parsed.status).toBe("auth_required");
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080]);
    const { payload } = extractSuffix(parsed.message);
    expect(payload.callbackPort).toBe(8080);
    expect(payload.probeVerdicts).toEqual([
      { port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
    ]);
  });

  it("uniform rejection floor: the floor attempt's auth_required message carries every attempt's verdict", async () => {
    rejectPorts.add(5173);
    rejectPorts.add(8080);
    rejectPorts.add(5174);
    hangPorts.add(5173); // the floor re-runs the first rejected candidate

    const parsed = await run();

    expect(parsed.status).toBe("auth_required");
    // 3 probe attempts + 1 floor attempt at the first rejected port.
    expect(httpClientInstances.map((c) => c.oauthPort)).toEqual([5173, 8080, 5174, 5173]);
    const { payload } = extractSuffix(parsed.message);
    expect(payload.probeVerdicts).toEqual([
      { port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
      { port: 8080, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
      { port: 5174, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
    ]);
  });

  it("static-cred classified rejection: the fast coded error's message rides the diagnostics envelope (k3 F2)", async () => {
    // The static-cred branch returns a fast coded error whose message already
    // includes the matched phrase — but without the envelope suffix that
    // phrase never reaches the desktop's durable channels (Sentry /
    // bug-report logs). The envelope must ride this response's message too,
    // same contract as the pending path.
    rejectPorts.add(5173);

    const parsed = await run({ oauthClientId: "static-client-id", oauthClientSecret: "secret" });

    expect(parsed.status).toBe("error");
    expect(parsed.code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);
    const { base, payload } = extractSuffix(parsed.message);
    // User-facing text unchanged — the desktop strips the suffix.
    expect(base).toBe("Pre-browser probe verdict: Callback URL mismatch");
    expect(payload.callbackPort).toBe(5173);
    expect(payload.probeVerdicts).toEqual([
      { port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
    ]);
  }, 10_000);

  it("success path: no diagnostics suffix rides the authenticated response (negative pin)", async () => {
    rejectPorts.add(5173); // 8080 accepts and the callback arrives

    const parsed = await run();

    expect(parsed.status).toBe("authenticated");
    expect(parsed.message).not.toContain(TRACE_MARKER);
  });
});
