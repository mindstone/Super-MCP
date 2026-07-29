import { describe, expect, it, vi } from "vitest";
import {
  OAUTH_CALLBACK_TIMEOUT_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS,
} from "../authenticate.js";
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
const DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS = 500_000;

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
  it("branch-aware worst-case sum of inner legs stays strictly inside the desktop authenticate budget", () => {
    const innerWorstCaseMs =
      LIST_TOOLS_TIMEOUT_MS + // registry cached-client health check (registry.ts getClient → httpClient.ts healthCheck/listTools)
      REGISTRY_CONNECT_ATTEMPTS * CONNECT_TIMEOUT_MS + // registry reconnect: initial + one retry (registry.ts createAndConnectClientWithOneRetry)
      LIST_TOOLS_TIMEOUT_MS + // handler health check on the fresh client (authenticate.ts pre-check)
      PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS + // pre-check listTools race, Windows worst-case default (authenticate.ts)
      SETUP_MARGIN_MS + // port find + provider init + callback-server start + settle (authenticate.ts)
      OAUTH_CALLBACK_TIMEOUT_MS + // browser sign-in window (authenticate.ts)
      FINISH_AUTH_TIMEOUT_MS + // token exchange (httpClient.ts finishOAuth)
      CONNECT_TIMEOUT_MS + // post-exchange reconnect (httpClient.ts connectWithTimeout)
      HEALTH_CHECK_TIMEOUT_MS; // post-auth verification (authenticate.ts)

    expect(innerWorstCaseMs).toBeLessThan(DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS);
  });
});
