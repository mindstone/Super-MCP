import { OAuthError, OAUTH_ERRORS } from "@modelcontextprotocol/sdk/server/auth/errors.js";

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

/** SDK OAuth messages contain provider descriptions or raw response bodies. */
export function oauthErrorLogText(error: unknown, text: string): string {
  const pending: unknown[] = [error];
  for (let visited = 0; pending.length && visited < MAX_ERROR_CHAIN_LENGTH; visited++) {
    const current = pending.pop();
    if (current instanceof OAuthError) return logCode(current.errorCode);
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
