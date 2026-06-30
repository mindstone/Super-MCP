import * as fs from "fs/promises";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getLogger } from "../logging.js";
import {
  SimpleOAuthProvider,
  OBTAINED_AT_FIELD,
  stripObtainedAtStamp,
  type OAuthErrorSummary,
} from "./providers/simple.js";
import { withTokenRefreshLock } from "./tokenRefreshLock.js";

const logger = getLogger();

// Treat an access token as "still valid" only if it has at least this much life
// left, so we never short-circuit onto a token that expires mid-request.
const ACCESS_TOKEN_SKEW_MS = 60_000;

// Bounded backoff used to absorb the FM5 TOCTOU window: the loser of a race can
// receive invalid_grant *before* the winner has durably persisted its rotated
// token. We re-read disk a few times with short jittered waits before declaring
// a grant genuinely dead.
const TOCTOU_MAX_ATTEMPTS = 3;
const TOCTOU_BASE_DELAY_MS = 200;
const TOCTOU_MAX_DELAY_MS = 500;

function jitteredDelay(attempt: number): number {
  const base = Math.min(TOCTOU_BASE_DELAY_MS * 2 ** attempt, TOCTOU_MAX_DELAY_MS);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute remaining lifetime (ms) of a persisted access token, or undefined. */
function remainingLifetimeMs(diskTokens: any): number | undefined {
  const obtainedAt = diskTokens?.[OBTAINED_AT_FIELD];
  const expiresIn = diskTokens?.expires_in;
  if (typeof obtainedAt !== "number" || typeof expiresIn !== "number") {
    return undefined;
  }
  const expiresAtMs = obtainedAt + expiresIn * 1000;
  return expiresAtMs - Date.now();
}

/**
 * Build a synthesized HTTP 200 token-endpoint Response from on-disk tokens. The
 * SDK's executeTokenRequest does `OAuthTokensSchema.parse(await res.json())`,
 * then refreshAuthorization returns `{ refresh_token: <supplied>, ...parsed }` —
 * so including refresh_token here overrides the (possibly stale) supplied one.
 * Shape verified against OAuthTokensSchema (access_token + token_type required;
 * expires_in/refresh_token/scope optional; unknown fields stripped).
 */
function synthesizeTokenResponse(diskTokens: any): Response {
  const remaining = remainingLifetimeMs(diskTokens);
  // When we have a real remaining lifetime, report it (never over-report by
  // falling back to the full original TTL once the token is at/near expiry — a
  // remaining <= 0 means the access token is effectively dead, so report 0
  // rather than an optimistic full-TTL value the SDK would trust).
  const expiresInSeconds =
    typeof remaining === "number"
      ? Math.max(0, Math.floor(remaining / 1000))
      : typeof diskTokens?.expires_in === "number"
        ? diskTokens.expires_in
        : undefined;

  const payload: Record<string, unknown> = {
    access_token: diskTokens.access_token,
    token_type: diskTokens.token_type ?? "Bearer",
  };
  if (typeof expiresInSeconds === "number") {
    payload.expires_in = expiresInSeconds;
  }
  if (typeof diskTokens.refresh_token === "string") {
    payload.refresh_token = diskTokens.refresh_token;
  }
  if (typeof diskTokens.scope === "string") {
    payload.scope = diskTokens.scope;
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Parse the JSON token-endpoint body from a successful (200) refresh Response.
 * Reads a CLONE so the original Response is left intact for any other consumer.
 */
async function parseTokenResponseBody(response: Response): Promise<any> {
  return response.clone().json();
}

/**
 * Build a fresh HTTP 200 token Response carrying `body` so the SDK's
 * executeTokenRequest can read it after we consumed the original stream while
 * parsing for persistence. Mirrors the real server's content-type/status.
 */
function tokenResponseFromBody(body: any): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse the urlencoded refresh request body the SDK sends. */
function parseRefreshBody(init: RequestInit | undefined): { grantType?: string; refreshToken?: string } {
  const body = init?.body;
  let params: URLSearchParams | undefined;
  if (body instanceof URLSearchParams) {
    params = body;
  } else if (typeof body === "string") {
    params = new URLSearchParams(body);
  }
  if (!params) {
    return {};
  }
  return {
    grantType: params.get("grant_type") ?? undefined,
    refreshToken: params.get("refresh_token") ?? undefined,
  };
}

/** Rewrite the request body to present the freshest on-disk refresh token. */
function rewriteBodyWithRefreshToken(init: RequestInit | undefined, refreshToken: string): RequestInit {
  const body = init?.body;
  let params: URLSearchParams;
  if (body instanceof URLSearchParams) {
    params = new URLSearchParams(body);
  } else if (typeof body === "string") {
    params = new URLSearchParams(body);
  } else {
    params = new URLSearchParams();
  }
  params.set("refresh_token", refreshToken);
  return { ...(init ?? {}), body: params };
}

/**
 * Distinguish a genuinely-corrupt token file from the empty placeholder the lock
 * creates before any token has ever been written (F3). An empty / whitespace-only
 * file is NOT corruption — it just means "no tokens yet". Returns true (treat as
 * "no tokens") when the file is missing or whitespace-only; false when it has real
 * (non-empty) content that failed to parse for some other reason.
 */
async function isEmptyOrPlaceholderTokenFile(tokenFilePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(tokenFilePath, "utf8");
    return raw.trim().length === 0;
  } catch {
    // Missing / unreadable at the byte level → safe to treat as "no tokens".
    return true;
  }
}

async function isInvalidGrant(response: Response): Promise<{ invalidGrant: boolean; summary?: OAuthErrorSummary }> {
  if (response.ok) {
    return { invalidGrant: false };
  }
  try {
    const body = (await response.clone().json()) as { error?: unknown; error_description?: unknown };
    if (typeof body?.error === "string") {
      const summary: OAuthErrorSummary = {
        error: body.error,
        ...(typeof body.error_description === "string" ? { error_description: body.error_description } : {}),
      };
      return { invalidGrant: body.error === "invalid_grant", summary };
    }
  } catch {
    // non-JSON error body
  }
  return { invalidGrant: false };
}

export interface RefreshTransactionDeps {
  provider: SimpleOAuthProvider;
  baseFetch: typeof fetch;
}

/**
 * Run a `grant_type=refresh_token` POST as a package-scoped atomic transaction.
 * Returns the Response the SDK's executeTokenRequest will consume (real,
 * synthesized-success, or the genuine error response).
 *
 * This is the heart of the rotation-race fix (PLAN Stage 5).
 */
export async function runRefreshTransaction(
  deps: RefreshTransactionDeps,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const { provider, baseFetch } = deps;
  const packageId = provider.getPackageId();
  const tokenFilePath = provider.getTokenFilePath();
  const supplied = parseRefreshBody(init);

  return withTokenRefreshLock(packageId, tokenFilePath, async (assertLockHealthy) => {
    // (1) Re-read disk under the lock — the source of truth.
    //
    // F3 — a disk-read failure must NOT early-return baseFetch(). Doing so would
    // run the refresh OUTSIDE the authoritative in-lock persist path: a 200 would
    // consume a single-use token whose only later write is the fail-OPEN public
    // saveTokens(), so a write error would silently leave a dead token on disk
    // while the SDK reports AUTHORIZED. Instead we stay on the authoritative path
    // and treat unreadable/absent/empty-placeholder disk as "no disk tokens"
    // (refresh with the SDK-supplied token, then schema-validate + persist-or-
    // fail-closed under the held lock).
    //
    // We distinguish:
    //   - ENOENT (readDiskTokens returns undefined) → no tokens; benign first run.
    //   - empty / whitespace-only placeholder file (the lock's placeholder, or a
    //     truncated write) → JSON.parse throws but this is NOT genuine corruption:
    //     treat as "no tokens" (debug log only).
    //   - any other read/parse failure → genuinely unreadable: structured WARN,
    //     but STILL proceed under the lock (do not early-return).
    let disk: any;
    try {
      disk = await provider.readDiskTokens();
    } catch (error) {
      if (await isEmptyOrPlaceholderTokenFile(tokenFilePath)) {
        logger.debug("Refresh transaction: empty/placeholder token file — treating as no disk tokens", {
          package_id: packageId,
        });
      } else {
        // Genuinely unreadable for some other reason (corrupt JSON, transient
        // torn read). Do NOT bypass the authoritative path — proceed under the
        // lock with no disk tokens and persist-or-fail-closed on success.
        logger.warn("Refresh transaction could not read disk tokens; proceeding under lock with no disk tokens", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      disk = undefined;
    }

    // (2) Short-circuit: disk already has a still-valid access token (a peer
    // refreshed). Avoid a network POST AND avoid burning a single-use refresh
    // token. The SDK parses the synthesized response and re-persists idempotently.
    const remaining = disk?.access_token ? remainingLifetimeMs(disk) : undefined;
    if (disk?.access_token && typeof remaining === "number" && remaining > ACCESS_TOKEN_SKEW_MS) {
      logger.info("Refresh short-circuited: on-disk access token still valid", {
        package_id: packageId,
        remaining_ms: remaining,
      });
      await provider.clearNeedsReconnectMarker();
      return synthesizeTokenResponse(disk);
    }

    // (3) Refresh genuinely needed. Present the FRESHEST on-disk refresh token
    // (never the SDK-supplied possibly-stale one).
    const diskRefreshToken: string | undefined =
      typeof disk?.refresh_token === "string" ? disk.refresh_token : undefined;
    const refreshTokenToSend = diskRefreshToken ?? supplied.refreshToken;
    if (!refreshTokenToSend) {
      // Nothing usable to refresh with — let the SDK's request go as-is and fail
      // honestly.
      return baseFetch(input, init);
    }

    assertLockHealthy();
    const requestInit = rewriteBodyWithRefreshToken(init, refreshTokenToSend);
    const response = await baseFetch(input, requestInit);

    const { invalidGrant, summary } = await isInvalidGrant(response);
    if (!invalidGrant) {
      if (!response.ok) {
        // Some non-invalid_grant error (e.g. 5xx, network-level). Let the SDK see
        // it verbatim — no persist, no marker change.
        return response;
      }

      // SUCCESS: the server consumed the single-use refresh token and rotated.
      // MA1 — persist the rotated token set ATOMICALLY UNDER THE HELD LOCK,
      // BEFORE returning to the SDK. This closes the FM5 gap structurally: the
      // winner's token is durable on disk before the lock releases, so a peer
      // entering the critical section next can never read the old (now-consumed)
      // token and replay it. (The SDK still calls saveTokens() afterwards; the
      // stale-write guard makes that a no-op.)
      //
      // MA2 — persistRotatedTokensOrThrow() FAILS CLOSED: if the write fails
      // after the server already consumed the token, we surface a hard error
      // here (and flag reconnect) instead of letting the SDK report AUTHORIZED on
      // an unpersisted rotation (a silent wedge next restart).
      assertLockHealthy();
      let rawBody: any;
      try {
        rawBody = await parseTokenResponseBody(response);
      } catch (error) {
        // The success response body could not be parsed. Don't claim success —
        // surface it so the SDK does not treat an unreadable rotation as authed.
        // Fail CLOSED like the schema-invalid path: the server returned 200 to our
        // refresh POST, so the single-use refresh token was almost certainly
        // consumed, and the response is unusable. Clear tokens + write the
        // reconnect marker before throwing so the host surfaces a clean reconnect
        // prompt instead of silently re-failing on a now-dead grant.
        logger.error("Refresh succeeded but the token response body was unreadable", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        await provider
          .clearTokensAndMarkNeedsReconnect({
            error: "invalid_token_response",
            error_description: "Token endpoint returned 200 with an unreadable (unparseable) body",
          })
          .catch(() => {});
        throw error;
      }

      // F2 — schema-validate the 200 body with the SAME schema the SDK applies
      // (OAuthTokensSchema: access_token + token_type required; expires_in/scope/
      // refresh_token optional; unknown fields stripped) BEFORE persisting. We now
      // own correctness the SDK previously delegated: persisting the raw body would
      // mutate disk token state on a malformed 200 even though the SDK then rejects
      // the refresh. If the body is invalid we FAIL CLOSED: the server returned 200
      // to our refresh POST, so the single-use refresh token was almost certainly
      // consumed — writing the invalid body (or silently continuing) would leave a
      // dead/garbage token on disk while the SDK reports AUTHORIZED. Instead mark
      // reconnect + throw. Use the parsed/stripped value for the persist.
      const parsed = OAuthTokensSchema.safeParse(rawBody);
      if (!parsed.success) {
        logger.error("Refresh returned 200 with an invalid token body — failing closed", {
          package_id: packageId,
          // Field-shape issues only; never the token material itself.
          validation_error: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
        });
        await provider
          .clearTokensAndMarkNeedsReconnect({
            error: "invalid_token_response",
            error_description: "Token endpoint returned 200 with a body that failed schema validation",
          })
          .catch(() => {});
        throw new Error(
          `Refresh token endpoint returned 200 with an invalid token body for package ${packageId}`,
        );
      }
      const rotated = parsed.data;

      let persisted: any;
      try {
        persisted = await provider.persistRotatedTokensOrThrow(rotated);
      } catch (error) {
        logger.error("Refresh rotated a token but persistence failed — flagging reconnect", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        // The on-disk token is now dead (the server consumed it) and we could not
        // store the replacement. Fail closed: mark reconnect and re-throw so the
        // SDK does NOT report AUTHORIZED on an unpersisted rotation.
        await provider
          .clearTokensAndMarkNeedsReconnect({
            error: "persist_failed",
            error_description: "Rotated refresh token could not be persisted",
          })
          .catch(() => {});
        throw error;
      }

      await provider.clearNeedsReconnectMarker();
      // N1 — Return a Response built from the MERGED PERSISTED token set (what we
      // actually wrote to disk under the lock), NOT the raw parsed `rotated` body.
      //
      // Why this matters: the SDK's refreshAuthorization() does
      // `return { refresh_token: <its supplied arg>, ...tokens }`. When the token
      // endpoint returns a valid 200 that OMITS refresh_token (no rotation this
      // round), `rotated` has no refresh_token, so the SDK would REATTACH its
      // original supplied argument — which, on the substitution path, is the STALE
      // token we deliberately replaced with the fresher disk one. The SDK then
      // calls saveTokens({access: a-new, refresh: r-old}) and the public merge
      // DOWNGRADES disk to r-old (the echo guard misses, since the authoritative
      // identity is a-new/r-fresh). Handing the SDK the persisted refresh token
      // makes that omit-reattach a no-op by construction AND aligns the echo
      // identity with the SDK's subsequent saveTokens. Strip our private stamp so
      // it never leaks to the SDK.
      return tokenResponseFromBody(stripObtainedAtStamp(persisted));
    }

    // (4) invalid_grant on the token we presented. Distinguish a lost race
    // (peer rotated, hasn't persisted yet — FM5 TOCTOU) from a genuinely dead
    // grant via bounded re-reads with jittered backoff.
    for (let attempt = 0; attempt < TOCTOU_MAX_ATTEMPTS; attempt++) {
      assertLockHealthy();
      let recheck: any;
      try {
        recheck = await provider.readDiskTokens();
      } catch {
        recheck = undefined;
      }

      // A peer rotated and persisted: disk refresh token changed since we read,
      // and/or there is now a still-valid access token → synthesize success.
      const recheckRefresh = typeof recheck?.refresh_token === "string" ? recheck.refresh_token : undefined;
      const recheckRemaining = recheck?.access_token ? remainingLifetimeMs(recheck) : undefined;
      const peerRotated =
        (recheckRefresh && recheckRefresh !== refreshTokenToSend) ||
        (typeof recheckRemaining === "number" && recheckRemaining > ACCESS_TOKEN_SKEW_MS);

      if (peerRotated && recheck?.access_token) {
        logger.info("Refresh lost a race but a peer rotated — recovering from disk", {
          package_id: packageId,
          attempt,
        });
        await provider.clearNeedsReconnectMarker();
        return synthesizeTokenResponse(recheck);
      }

      if (attempt < TOCTOU_MAX_ATTEMPTS - 1) {
        await sleep(jitteredDelay(attempt));
      }
    }

    // (5) Disk unchanged across the backoff window → the grant is genuinely dead.
    // Clear tokens + write the needsReconnect marker, and let the error response
    // reach the SDK (which will throw InvalidGrantError).
    logger.error("Refresh grant is genuinely dead after bounded re-read", {
      package_id: packageId,
      ...(summary ? summary : {}),
    });
    await provider.clearTokensAndMarkNeedsReconnect(summary);
    return response;
  });
}
