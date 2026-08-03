import { getLogger } from "../logging.js";

const logger = getLogger();

/**
 * Authorize pre-flight probe (REBEL-7F9 Stage 3).
 *
 * Before opening the browser, headless-GET the constructed authorize URL and
 * classify the authorization server's response. Strict allow-list ASs (an
 * Auth0 app whose Allowed Callback URLs were pinned in a vendor dashboard —
 * no RFC 8252 loopback any-port treatment) reject a mismatched redirect_uri
 * AT /authorize, so the browser would show a vendor error page and the
 * callback would never arrive (today: a silent hang until the 300s callback
 * timeout, surfaced to the user as "Request timed out"). The probe detects
 * that shape in seconds so the retry loop can advance to the next port
 * candidate.
 *
 * Fail-open polarity is the safety contract (recall#2 F1): anything we cannot
 * positively classify as a redirect_uri-mismatch rejection (network error,
 * timeout, WAF page, consent interstitial, unrecognized shape) is treated as
 * INCONCLUSIVE and the flow proceeds exactly as it does today. A loose token
 * match is NEVER sufficient for a classified rejection.
 */

/** Probe timeout per attempt. A leg of the OAuth budget invariant. */
export const AUTHORIZE_PROBE_TIMEOUT_MS = 3_000;

/** Bounded body read — classification only needs the first chunk of the page. */
export const AUTHORIZE_PROBE_MAX_BODY_BYTES = 65_536;

/** Env kill-switch: disables the probe and collapses the retry loop to today's single attempt. */
export const OAUTH_PROBE_DISABLE_ENV = "SUPER_MCP_OAUTH_PROBE_DISABLE";

/**
 * Machine code carried on the pre-browser rejection error so handleAuthenticate
 * classifies it WITHOUT matching on message text (mirrors the
 * OAUTH_FINISH_AUTH_TIMEOUT_CODE precedent in clients/httpClient.ts).
 */
export const OAUTH_REDIRECT_URI_REJECTED_CODE = "OAUTH_REDIRECT_URI_REJECTED";

/**
 * Mismatch-specific phrases. A 400/401/403 is a classified rejection ONLY when
 * the body matches one of these — a bare status or loose "redirect_uri" token
 * is never sufficient (recall#2 F1(a): WAF 403s and login pages mentioning
 * redirect_uri must fail open to the browser).
 */
const REDIRECT_URI_MISMATCH_PHRASE =
  /callback url mismatch|not in the list of allowed|invalid[ _-]?redirect_?uri|invalid parameter:?\s*redirect_?uri|redirect_?uri (mismatch|not (allowed|registered)|does not match)/i;

/**
 * 3xx Location hints that the AS bounced to its own error page instead of a
 * login/consent page (Okta / some Keycloak configs — recall#2 F7).
 *
 * Deliberately NARROWER than the plan text's error=/redirect_uri/invalid_request
 * disjunction: live verification against auth.swifteq.com (2026-08-03) showed
 * Auth0's ACCEPTED shape — the 302 to /login — carries redirect_uri as an
 * ordinary continuation query parameter, so a bare "redirect_uri" match would
 * classify-reject the WORKING port (false positive on the exact flow this
 * stage exists to fix). OAuth error redirects always carry error= (RFC 6749
 * §4.1.2.1); invalid_request is the mismatch error code. A 302 to an error
 * page without either token fails open (accepted) — no regression vs today.
 */
const ERROR_LOCATION_HINT = /error=|invalid_request/i;

export type AuthorizeProbeOutcome = "accepted" | "rejected" | "inconclusive";

export interface AuthorizeProbeVerdict {
  outcome: AuthorizeProbeOutcome;
  /** HTTP status when a response was received. */
  status?: number;
  /** The mismatch-specific phrase that justified a classified rejection. */
  matchedPhrase?: string;
  /** Location header for 3xx responses. */
  location?: string;
  /** Failure detail for inconclusive network/timeout outcomes. */
  error?: string;
}

/**
 * Base of the user-invisible rejection message. VOCABULARY CONTRACT
 * (recall#2 F2(c)): this message must NEVER contain tokens matched by
 * httpClient's isAuthLikeErrorMessage ("unauthorized", "401", "invalid_token",
 * "redirect initiated", "missing authorization", "authentication required") —
 * a message that matched would be swallowed as an expected auth-like outcome,
 * resolving the connect promise and hanging the callback wait for the full
 * 300s. The verbatim Auth0 body contains "unauthorized_client", which is why
 * the AS response body must never become this message. The numeric status is
 * deliberately excluded (401 would trip the token list). Pinned by tests in
 * src/auth/__tests__/authorizeProbe.test.ts.
 */
export const REDIRECT_URI_MISMATCH_MESSAGE_BASE =
  "The provider's sign-in page rejected this connection's registered callback address before the browser was opened (callback URL mismatch). The provider appears to allow-list a different loopback callback port";

export function isAuthorizeProbeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OAUTH_PROBE_DISABLE_ENV] === "1";
}

/**
 * Pure classification of a probe response. Exported for fixture-driven tests.
 */
export function classifyProbeResponse(input: {
  status: number;
  location?: string | null;
  body?: string;
}): AuthorizeProbeVerdict {
  const { status, location, body } = input;

  if (status >= 200 && status < 300) {
    // 2xx → accepted, even if the page text mentions redirect_uri (a login
    // page or marketing copy is not a rejection — fail open).
    return { outcome: "accepted", status };
  }

  if (status >= 300 && status < 400) {
    if (location && ERROR_LOCATION_HINT.test(location)) {
      return {
        outcome: "rejected",
        status,
        location,
        matchedPhrase: `Location header: ${location}`,
      };
    }
    return { outcome: "accepted", status, location: location ?? undefined };
  }

  if (status === 400 || status === 401 || status === 403) {
    const match = body ? body.match(REDIRECT_URI_MISMATCH_PHRASE) : null;
    if (match) {
      return { outcome: "rejected", status, matchedPhrase: match[0] };
    }
    // Bare 400/401/403 without a mismatch-specific phrase → fail open.
    return { outcome: "inconclusive", status };
  }

  return { outcome: "inconclusive", status };
}

/** Build the coded rejection error thrown out of redirectToAuthorization. */
export function buildRedirectUriRejectedError(verdict: AuthorizeProbeVerdict): Error {
  const detail = verdict.matchedPhrase ? ` (matched: "${verdict.matchedPhrase}")` : "";
  const error = new Error(`${REDIRECT_URI_MISMATCH_MESSAGE_BASE}${detail}.`);
  (error as NodeJS.ErrnoException).code = OAUTH_REDIRECT_URI_REJECTED_CODE;
  return error;
}

/** Read at most maxBytes of a response body, then cancel the stream. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return merged.subarray(0, maxBytes).toString("utf8");
}

/**
 * Headless-GET the authorize URL and classify the response. Never throws —
 * any failure to even perform the probe is an inconclusive verdict (fail-open
 * to today's browser behavior).
 */
export async function probeAuthorizeUrl(
  authorizeUrl: string,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<AuthorizeProbeVerdict> {
  const timeoutMs = options.timeoutMs ?? AUTHORIZE_PROBE_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(authorizeUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        // Browser-shaped UA: some ASs/WAFs answer non-browser clients
        // differently. No cookies — this is a pre-flight, not a session.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    // Only 400/401/403 verdicts consult the body; skip the read otherwise.
    const needsBody = res.status === 400 || res.status === 401 || res.status === 403;
    const body = needsBody ? await readBoundedBody(res, AUTHORIZE_PROBE_MAX_BODY_BYTES) : undefined;
    return classifyProbeResponse({
      status: res.status,
      location: res.headers.get("location"),
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug("Authorize pre-flight probe failed; failing open to browser", {
      error: message,
    });
    return { outcome: "inconclusive", error: message };
  } finally {
    clearTimeout(timer);
  }
}
