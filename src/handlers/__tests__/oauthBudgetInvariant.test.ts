import { describe, expect, it, vi } from "vitest";
import {
  OAUTH_CALLBACK_TIMEOUT_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS,
  MAX_PORT_ATTEMPTS,
} from "../authenticate.js";
import { AUTHORIZE_PROBE_TIMEOUT_MS } from "../../auth/authorizeProbe.js";
import {
  CONNECT_TIMEOUT_MS,
  FINISH_AUTH_TIMEOUT_MS,
  LIST_TOOLS_TIMEOUT_MS,
} from "../../clients/httpClient.js";
import { REGISTRY_CONNECT_ATTEMPTS } from "../../registry.js";

vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Desktop outer budget: AUTHENTICATE_TOOL_TIMEOUT_MS in the app repo's
// src/main/services/mcpService.ts. The process boundary makes importing it here
// impractical — this literal + comment IS the coupling. If either side changes,
// change both together (the desktop repo carries the mirror-image assertion in
// src/main/services/__tests__/mcpService.oauthTimeout.test.ts).
const DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS = 620_000;

// Local, sub-second setup operations of handleAuthenticate's
// wait_for_completion path that have no importable constant: saved-port
// lookup + findAvailablePort probes + provider init (file I/O) + callback
// server start + the 500ms post-start settle.
const SETUP_MARGIN_MS = 2_000;

describe("OAuth budget invariant (desktop outer budget vs inner legs)", () => {
  // Sentry showed ~13 production events failing at a razor-consistent ~370.4s:
  // users who FINISHED sign-in late in the callback window were told
  // "Authentication timed out" because the desktop budget under-counted the
  // success path. This test fails if any inner leg grows past the desktop
  // outer budget, on either side of the process boundary.
  //
  // Stage 7 correction (audit F2): the pre-check leg is BRANCH-AWARE, not one
  // listTools race. registry.getClient() can health-check a cached client
  // (listTools SDK timeout), evict it, then reconnect with one retry
  // (createAndConnectClientWithOneRetry) before handleAuthenticate runs its
  // own health check and listTools race on the fresh client.
  //
  // Deliberately excluded (documented, not forgotten):
  //  - env overrides (SUPER_MCP_LIST_TOOLS_TIMEOUT[_MS], SUPER_MCP_CONNECT_TIMEOUT_MS)
  //    — ops knobs, not defaults (plan residue R18);
  //  - request-queue (p-queue) scheduling delay ahead of the SDK listTools timer;
  //  - the SSE-fallback double-connect inside one attempt: it only triggers on
  //    negotiation errors (404/405/Missing sessionId — prompt HTTP responses),
  //    so a negotiation error arriving AT the 30s connect boundary is
  //    pathological. Worst case it adds CONNECT_TIMEOUT_MS per attempt.
  // The pre-check legs + per-attempt setup run ONCE per authenticate call.
  const PRE_CHECK_AND_SETUP_MS =
    LIST_TOOLS_TIMEOUT_MS + // registry cached-client health check (registry.ts getClient → httpClient.ts healthCheck/listTools)
    REGISTRY_CONNECT_ATTEMPTS * CONNECT_TIMEOUT_MS + // registry reconnect: initial + one retry (registry.ts createAndConnectClientWithOneRetry)
    LIST_TOOLS_TIMEOUT_MS + // handler health check on the fresh client (authenticate.ts pre-check)
    PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS + // pre-check listTools race, Windows worst-case default (authenticate.ts)
    SETUP_MARGIN_MS; // port find + provider init + callback-server start + settle (authenticate.ts)

  // A classified-rejection attempt dies AT THE PROBE (recall#2 F4): per-attempt
  // setup + probe + the connect/DCR leg that built the authorize URL. The 300s
  // callback wait NEVER runs for a rejected attempt.
  const FAST_REJECTED_ATTEMPT_MS =
    SETUP_MARGIN_MS + AUTHORIZE_PROBE_TIMEOUT_MS + CONNECT_TIMEOUT_MS;

  // The browser-open floor attempt's own setup leg (skipProbe ⇒ no probe
  // leg): the same local sub-second operations the SETUP_MARGIN_MS covers.
  const FLOOR_ATTEMPT_SETUP_MS = SETUP_MARGIN_MS;

  // The accepted (or browser-floor) attempt runs today's full success path.
  const FULL_ATTEMPT_MS =
    OAUTH_CALLBACK_TIMEOUT_MS + // browser sign-in window (authenticate.ts)
    FINISH_AUTH_TIMEOUT_MS + // token exchange (httpClient.ts finishOAuth)
    CONNECT_TIMEOUT_MS + // post-exchange reconnect (httpClient.ts connectWithTimeout)
    HEALTH_CHECK_TIMEOUT_MS; // post-auth verification (authenticate.ts)

  it("branch-aware worst-case sum of inner legs stays strictly inside the desktop authenticate budget", () => {
    // n=1 (single attempt — the kill-switch / no-rejection path): identical to
    // the pre-probe budget (confirm#F5: the disabled path is byte-identical to
    // today, and the budget for it must not grow).
    const innerWorstCaseMs =
      PRE_CHECK_AND_SETUP_MS +
      FULL_ATTEMPT_MS;

    expect(innerWorstCaseMs).toBe(492_000);
    expect(innerWorstCaseMs).toBeLessThan(DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS);
    // The kill-switch path keeps the legacy sub-500s budget, pinned against
    // the imported constants (testing F7), not only mirrored literals.
    expect(innerWorstCaseMs).toBeLessThan(500_000);
  });

  it("accepted-attempt path (MAX_PORT_ATTEMPTS - 1 rejections + one full attempt) keeps the ~58s margin", () => {
    // REBEL-7F9 Stage 3 (confirm#F1/F8): up to MAX_PORT_ATTEMPTS - 1 fast
    // probe-rejected retry legs precede the one full attempt whose 300s
    // callback wait applies exactly once. This is the margin that protects a
    // slow legitimate login on the final attempt.
    //   112s pre-check+setup + 2 × 35s (setup 2s + probe 3s + connect/DCR 30s)
    //   + 380s full attempt = 562s < 620s (~58s margin).
    const acceptedPathWorstCaseMs =
      PRE_CHECK_AND_SETUP_MS +
      (MAX_PORT_ATTEMPTS - 1) * FAST_REJECTED_ATTEMPT_MS +
      FULL_ATTEMPT_MS;

    expect(MAX_PORT_ATTEMPTS).toBe(3);
    expect(AUTHORIZE_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(acceptedPathWorstCaseMs).toBe(562_000);
    expect(acceptedPathWorstCaseMs).toBeLessThan(DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS);
  });

  it("uniform-rejection floor path (MAX_PORT_ATTEMPTS rejections + floor attempt) is the true worst case, ~21s margin", () => {
    // Stage 3 review F1 (all five reviewers): the browser-open floor runs a
    // FOURTH attempt (runAttempt(firstRejection.port, { skipProbe: true }))
    // after all MAX_PORT_ATTEMPTS candidates classify-reject — the "bounded
    // at MAX_PORT_ATTEMPTS probe attempts, then the browser-open floor" retry
    // test pins 4 httpClient instances. The floor attempt's own setup leg
    // (~2s) applies, but not its probe leg (skipProbe). This is the real
    // no-progress worst case:
    //   112s pre-check+setup + 3 × 35s fast-rejected legs + ~2s floor setup
    //   + 380s full attempt = 599s < 620s (~21s margin, not 58s).
    // A leg growth that keeps the accepted-path sum green can still breach
    // THIS path — the guard exists to catch exactly that.
    const floorPathWorstCaseMs =
      PRE_CHECK_AND_SETUP_MS +
      MAX_PORT_ATTEMPTS * FAST_REJECTED_ATTEMPT_MS +
      FLOOR_ATTEMPT_SETUP_MS +
      FULL_ATTEMPT_MS;

    expect(floorPathWorstCaseMs).toBe(599_000);
    expect(floorPathWorstCaseMs).toBeLessThan(DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS);
  });
});
