import { randomBytes } from "node:crypto";

/**
 * Fake OAuth 2.1 authorization-server token endpoint, modelling a provider
 * (Notion / Linear) that issues **single-use, rotating** refresh tokens.
 *
 * It is shaped as a drop-in `fetch` (the same signature super-mcp's
 * `createResponseNormalizingFetch` wraps as `baseFetch`, and the same signature
 * the MCP SDK calls as `fetchFn` inside `executeTokenRequest`). Tests pass it as
 * `fetchFn` to the SDK's real `refreshAuthorization()` (or wrap it with the real
 * super-mcp fetch wrapper) so the request body + response parsing exercise the
 * production token-refresh code path, not a hand-rolled fake.
 *
 * Behaviour:
 *  - `grant_type=refresh_token` with a *currently-valid* refresh token →
 *    HTTP 200, mints a NEW access_token + a NEW rotated refresh_token, and marks
 *    the presented refresh_token consumed (single-use).
 *  - `grant_type=refresh_token` with a *consumed* or *unknown* refresh token →
 *    HTTP 400 `{ "error": "invalid_grant", "error_description": "Grant not found" }`.
 *  - The grant can be hard-revoked (genuinely dead) via `revokeGrant()`; after
 *    that every refresh — even with the latest token — returns `invalid_grant`.
 *
 * The endpoint tracks call count + the set of consumed refresh tokens so tests
 * can assert "exactly one rotation was consumed" under a concurrency race.
 *
 * No real secrets: all token material is synthetic random hex / counters.
 */

export interface MockTokenEndpointOptions {
  /** Token endpoint URL the SDK will POST to. Default https://auth.example.test/token */
  tokenUrl?: string;
  /**
   * The initial valid refresh token. The harness seeds the provider's on-disk
   * tokens with this same value so the first refresh succeeds.
   */
  initialRefreshToken: string;
  /** access_token TTL reported as expires_in (seconds). Default 3600 (Notion 1h). */
  expiresIn?: number;
  /**
   * Optional hook invoked at the very start of each refresh POST, AFTER the
   * presented refresh token has been read but BEFORE validity is decided.
   * Lets a test inject an interleaving (e.g. let a peer rotate first) to force a
   * deterministic race. Receives the presented refresh token.
   */
  onBeforeDecision?: (presentedRefreshToken: string) => void | Promise<void>;
}

export interface MockTokenEndpointHandle {
  /** The drop-in fetch to pass as the SDK `fetchFn` / wrapper `baseFetch`. */
  fetch: typeof fetch;
  /** Total number of token-endpoint POSTs received. */
  callCount(): number;
  /** Number of successful (HTTP 200) rotations performed. */
  successCount(): number;
  /** Number of refresh tokens that have been consumed (== successful rotations). */
  consumedCount(): number;
  /** Whether a specific refresh token has been consumed. */
  isConsumed(token: string): boolean;
  /** The refresh token currently considered valid by the server (latest rotation). */
  currentValidRefreshToken(): string;
  /** The access token currently considered valid (latest rotation). */
  currentValidAccessToken(): string;
  /** Hard-revoke the whole grant: every subsequent refresh → invalid_grant. */
  revokeGrant(): void;
  /** All refresh tokens consumed so far, in order. */
  consumedTokens(): readonly string[];
}

const TOKEN_URL_DEFAULT = "https://auth.example.test/token";

function mintToken(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

/**
 * Extract the urlencoded form body from a fetch call, matching how the SDK
 * sends it: `body: URLSearchParams` with content-type x-www-form-urlencoded.
 */
async function readForm(init: RequestInit | undefined, input: RequestInfo | URL): Promise<URLSearchParams> {
  // SDK path: init.body is a URLSearchParams.
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  if (typeof body === "string") {
    return new URLSearchParams(body);
  }
  // Request object path (defensive — SDK uses (url, init)).
  if (input instanceof Request) {
    const text = await input.clone().text();
    return new URLSearchParams(text);
  }
  return new URLSearchParams();
}

export function createMockTokenEndpoint(options: MockTokenEndpointOptions): MockTokenEndpointHandle {
  const tokenUrl = options.tokenUrl ?? TOKEN_URL_DEFAULT;
  const expiresIn = options.expiresIn ?? 3600;

  let validRefreshToken = options.initialRefreshToken;
  let validAccessToken = mintToken("access-initial");
  let calls = 0;
  let successes = 0;
  let revoked = false;
  const consumed = new Set<string>();
  const consumedOrder: string[] = [];

  const invalidGrant = (): Response =>
    new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Grant not found" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

  const isTokenEndpoint = (input: RequestInfo | URL): boolean => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request)?.url ?? "";
    return raw === tokenUrl || raw.endsWith("/token");
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isTokenEndpoint(input)) {
      // Not the token endpoint — should not happen in these tests; fail loudly.
      throw new Error(`mockTokenEndpoint received unexpected request to ${String(input)}`);
    }

    calls += 1;
    const form = await readForm(init, input);
    const grantType = form.get("grant_type");

    if (grantType !== "refresh_token") {
      // We only model refresh in this harness.
      return new Response(
        JSON.stringify({ error: "unsupported_grant_type" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const presented = form.get("refresh_token") ?? "";

    if (options.onBeforeDecision) {
      await options.onBeforeDecision(presented);
    }

    if (revoked) {
      return invalidGrant();
    }

    // Single-use rotation: only the currently-valid (not-yet-consumed) token works.
    if (presented !== validRefreshToken || consumed.has(presented)) {
      return invalidGrant();
    }

    // Consume the presented token and rotate.
    consumed.add(presented);
    consumedOrder.push(presented);
    successes += 1;

    const newAccess = mintToken("access");
    const newRefresh = mintToken("refresh");
    validAccessToken = newAccess;
    validRefreshToken = newRefresh;

    return new Response(
      JSON.stringify({
        access_token: newAccess,
        refresh_token: newRefresh,
        token_type: "Bearer",
        expires_in: expiresIn,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    callCount: () => calls,
    successCount: () => successes,
    consumedCount: () => consumed.size,
    isConsumed: (token: string) => consumed.has(token),
    currentValidRefreshToken: () => validRefreshToken,
    currentValidAccessToken: () => validAccessToken,
    revokeGrant: () => {
      revoked = true;
    },
    consumedTokens: () => consumedOrder.slice(),
  };
}
