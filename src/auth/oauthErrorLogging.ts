import { OAuthError, OAUTH_ERRORS } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";

const knownOAuthErrors = Object.keys(OAUTH_ERRORS);
const MAX_ERROR_CHAIN_LENGTH = 32;

function logCode(code: string): string {
  return knownOAuthErrors.find((knownCode) => knownCode === code) ?? "unrecognized";
}

/** Log only bounded OAuth error codes, never provider descriptions. */
export function oauthErrorLogFields(summary: { error: string } | undefined): { error?: string } {
  if (!summary) return {};
  return { error: logCode(summary.error) };
}

/** Bound SDK OAuth codes and HTTP/SSE transport errors; other errors use the caller's fallback (ordinarily error text). */
export function oauthErrorLogText(error: unknown, text: string): string {
  const pending: unknown[] = [error];
  for (let visited = 0; pending.length && visited < MAX_ERROR_CHAIN_LENGTH; visited++) {
    const current = pending.pop();
    if (current instanceof OAuthError) return logCode(current.errorCode);
    if (current instanceof StreamableHTTPError || current instanceof SseError) {
      return typeof current.code === "number" && Number.isFinite(current.code) && current.code > 0
        ? `http_${current.code}`
        : current instanceof SseError ? "sse_no_status" : "http_no_status";
    }
    if (current && typeof current === "object") {
      if ("cause" in current) pending.push(current.cause);
      // Transport negotiation can fail in both the original and fallback paths.
      if (current instanceof AggregateError) {
        if (current.errors.length > MAX_ERROR_CHAIN_LENGTH) return "unrecognized";
        pending.push(...current.errors);
      }
    }
  }
  // A cycle or an overlong chain must not expose an unexamined description.
  return pending.length ? "unrecognized" : text;
}
