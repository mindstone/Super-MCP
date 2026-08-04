import * as net from "net";
import { getLogger } from "../logging.js";

const logger = getLogger();

/**
 * Host addresses used for OAuth callback server binding.
 *
 * We bind BOTH IPv4 (127.0.0.1) and IPv6 (::1) loopback because browsers may
 * resolve `localhost` to either stack depending on OS, /etc/hosts order and
 * Happy-Eyeballs behaviour. If we bound only IPv4 and another (unrelated) dev
 * server was already holding the same port on IPv6 (`::1:<port>`), the browser
 * would silently hit the wrong process — see
 * docs/investigations/260225_oauth_callback_connection_refused.md and RFC 8252 §7.3.
 *
 * IPv4 is REQUIRED; IPv6 is BEST-EFFORT (we tolerate EADDRNOTAVAIL / EAFNOSUPPORT
 * on hosts without IPv6 loopback, e.g. some CI containers and IPv6-disabled Windows).
 * EADDRINUSE on either stack is treated as "port unavailable" so we advance to the
 * next port in the scan — this is what prevents the cross-process hijack.
 *
 * Loopback-only addresses keep us clear of the Windows Firewall prompt that
 * binding to 0.0.0.0 / :: would trigger.
 *
 * IMPORTANT: These constants must be used by both:
 * - checkPortAvailable() in this file
 * - OAuthCallbackServer.start() in callbackServer.ts
 */
export const OAUTH_CALLBACK_HOST_V4 = "127.0.0.1";
export const OAUTH_CALLBACK_HOST_V6 = "::1";

/**
 * Legacy export. New code should reference OAUTH_CALLBACK_HOST_V4 explicitly.
 * Preserved so any external importers (tests, tooling) keep compiling.
 */
export const OAUTH_CALLBACK_HOST = OAUTH_CALLBACK_HOST_V4;

/** Error codes that mean "this address family is simply not available on this host" */
const IPV6_UNSUPPORTED_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);

/**
 * Default OAuth callback port — attempt 1 for fresh registrations stays on this
 * port so the happy path is byte-identical to the historical linear scan
 * (REBEL-7F9 Stage 2b, recall#1 F1).
 */
export const OAUTH_CALLBACK_DEFAULT_PORT = 5173;

/** End of the historical linear scan range (5173..5182, 10 ports). */
export const OAUTH_CALLBACK_PORT_SCAN_END = 5182;

/**
 * Port some strict allow-list authorization servers (e.g. an Auth0 app whose
 * Allowed Callback URLs were pinned at a vendor dashboard) accept for loopback
 * redirects. Inserted at candidate position 2 — NOT first — so attempt 1 is
 * unchanged fleet-wide and such vendors self-correct on attempt 2, then stick
 * via saved-port reuse.
 */
export const OAUTH_CALLBACK_VENDOR_COMMON_PORT = 8080;

/**
 * Ordered OAuth callback port candidates (REBEL-7F9 Stage 2b).
 *
 * Fresh, non-static-credential order: [5173, 8080, 5174, …5182] — 8080 at
 * position 2 (see OAUTH_CALLBACK_VENDOR_COMMON_PORT). Static-credential
 * connectors keep the plain linear 5173-first order: their redirect_uri is
 * pinned out-of-band in a vendor dashboard, so probing alternate ports is
 * futile and must not change their behavior.
 */
export function getOAuthCallbackPortCandidates(
  options: { staticCredentials?: boolean } = {}
): number[] {
  const linear: number[] = [];
  for (let p = OAUTH_CALLBACK_DEFAULT_PORT; p <= OAUTH_CALLBACK_PORT_SCAN_END; p++) {
    linear.push(p);
  }
  if (options.staticCredentials) {
    return linear;
  }
  return [OAUTH_CALLBACK_DEFAULT_PORT, OAUTH_CALLBACK_VENDOR_COMMON_PORT, ...linear.slice(1)];
}

/**
 * Ordered RETRY candidates for the authorize-probe rejection loop
 * (REBEL-7F9 Stage 3): [8080, 5173…5182] deduped minus already-failed ports,
 * regardless of how attempt 1 chose its port (recall#2 F3 — the reported
 * user's saved facade client sits at 5173; attempt 2 must be 8080). Single
 * home for this ordering (DA F3) so a future scan-range or vendor-port change
 * can't update one call site and miss the other.
 */
export function getOAuthCallbackRetryCandidates(failedPorts: readonly number[]): number[] {
  const seen = new Set<number>();
  for (let p = OAUTH_CALLBACK_DEFAULT_PORT; p <= OAUTH_CALLBACK_PORT_SCAN_END; p++) {
    seen.add(p);
  }
  seen.add(OAUTH_CALLBACK_VENDOR_COMMON_PORT);
  const ordered = [
    OAUTH_CALLBACK_VENDOR_COMMON_PORT,
    ...[...seen].sort((a, b) => a - b).filter((p) => p !== OAUTH_CALLBACK_VENDOR_COMMON_PORT),
  ];
  return ordered.filter((candidate) => !failedPorts.includes(candidate));
}

/**
 * Find the first available port from an ordered candidate list, filtered by
 * checkPortAvailable. Unlike findAvailablePort's linear scan, the caller owns
 * the ordering — this is what the OAuth retry loop advances across.
 */
export async function findAvailablePortFromCandidates(
  candidates: readonly number[]
): Promise<number> {
  for (let index = 0; index < candidates.length; index++) {
    const port = candidates[index];
    const isAvailable = await checkPortAvailable(port);
    if (isAvailable) {
      if (index > 0) {
        logger.info("Found available port after skipping busy candidates", {
          requested_port: candidates[0],
          actual_port: port,
          attempts: index + 1,
        });
      }
      return port;
    }
    logger.debug("Port in use, trying next candidate", { port, attempt: index + 1 });
  }
  throw new Error(
    `No available port found among candidates ${candidates.join(", ")}`
  );
}

/**
 * Find an available port starting from a given port number.
 * Tries consecutive ports until one is available on BOTH IPv4 and IPv6
 * (or IPv6 is unsupported), or max attempts reached.
 *
 * NOTE: retained intentionally for API compatibility and as a test seam —
 * no production callers remain. Production code (e.g. the OAuth callback
 * retry loop) must use findAvailablePortFromCandidates, where the caller
 * owns the candidate ordering. Do not remove without a deliberate API break.
 */
export async function findAvailablePort(
  startPort: number = 5173,
  maxAttempts: number = 10
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = startPort + attempt;
    const isAvailable = await checkPortAvailable(port);
    if (isAvailable) {
      if (attempt > 0) {
        logger.info("Found available port after retries", {
          requested_port: startPort,
          actual_port: port,
          attempts: attempt + 1,
        });
      }
      return port;
    }
    logger.debug("Port in use, trying next", { port, attempt: attempt + 1 });
  }
  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1}`
  );
}

/**
 * Try to bind a single loopback address briefly. Resolves with a descriptor of
 * what happened; never rejects. Caller decides how to interpret the result.
 */
function probeBind(
  port: number,
  host: string
): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: err.code, message: err.message });
    });
    server.once("listening", () => {
      server.close(() => resolve({ ok: true }));
    });
    server.listen(port, host);
  });
}

/**
 * Check if a specific port is available for binding on BOTH loopback stacks.
 *
 * Returns true iff:
 *   - IPv4 (127.0.0.1) bind succeeds, AND
 *   - IPv6 (::1) bind either succeeds OR fails with an address-family-unsupported
 *     code (meaning no one else could be using it on this host either).
 *
 * Returns false if IPv4 is busy OR IPv6 is busy (EADDRINUSE). This is the
 * crucial guard that stops us selecting a port where the opposite stack is
 * held by an unrelated process (the original 404-via-Vite bug).
 */
export async function checkPortAvailable(port: number): Promise<boolean> {
  const v4 = await probeBind(port, OAUTH_CALLBACK_HOST_V4);
  if (!v4.ok) {
    logger.debug("Port unavailable", {
      port,
      stack: "v4",
      host: OAUTH_CALLBACK_HOST_V4,
      code: v4.code,
      message: v4.message,
    });
    return false;
  }

  const v6 = await probeBind(port, OAUTH_CALLBACK_HOST_V6);
  if (v6.ok) {
    return true;
  }
  if (v6.code && IPV6_UNSUPPORTED_CODES.has(v6.code)) {
    // IPv6 loopback not usable on this host — IPv4-only binding is sufficient.
    logger.debug("IPv6 loopback unsupported on this host, proceeding with IPv4 only", {
      port,
      stack: "v6",
      host: OAUTH_CALLBACK_HOST_V6,
      code: v6.code,
    });
    return true;
  }
  logger.debug("Port unavailable", {
    port,
    stack: "v6",
    host: OAUTH_CALLBACK_HOST_V6,
    code: v6.code,
    message: v6.message,
  });
  return false;
}
