import { describe, expect, it, vi } from "vitest";
import { OAUTH_CALLBACK_TIMEOUT_MS, HEALTH_CHECK_TIMEOUT_MS } from "../authenticate.js";
import { CONNECT_TIMEOUT_MS, FINISH_AUTH_TIMEOUT_MS } from "../../clients/httpClient.js";

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
const DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS = 420_000;

// Legs of handleAuthenticate's wait_for_completion path that are NOT importable
// constants: the pre-auth health/listTools pre-check (30s Windows default via
// SUPER_MCP_LIST_TOOLS_TIMEOUT_MS fallback in authenticate.ts) plus port find +
// provider init + post-start settle (~2s).
const PRE_CHECK_AND_SETUP_MARGIN_MS = 32_000;

describe("OAuth budget invariant (desktop outer budget vs inner legs)", () => {
  // Sentry showed ~13 production events failing at a razor-consistent ~370.4s:
  // users who FINISHED sign-in late in the callback window were told
  // "Authentication timed out" because the desktop budget under-counted the
  // success path. This test fails if any inner leg grows past the desktop
  // outer budget, on either side of the process boundary.
  it("worst-case sum of inner legs stays strictly inside the desktop authenticate budget", () => {
    const innerWorstCaseMs =
      PRE_CHECK_AND_SETUP_MARGIN_MS +
      OAUTH_CALLBACK_TIMEOUT_MS + // browser sign-in window (authenticate.ts)
      FINISH_AUTH_TIMEOUT_MS + // token exchange (httpClient.ts finishOAuth)
      CONNECT_TIMEOUT_MS + // post-exchange reconnect (httpClient.ts connectWithTimeout)
      HEALTH_CHECK_TIMEOUT_MS; // post-auth verification (authenticate.ts)

    expect(innerWorstCaseMs).toBeLessThan(DESKTOP_AUTHENTICATE_TOOL_TIMEOUT_MS);
  });
});
