import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const knownOAuthErrors = [
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope",
] as const;

/** Log only bounded OAuth error codes, never provider descriptions. */
export function oauthErrorLogFields(summary: { error: string; error_description?: string } | undefined): { error?: string } {
  if (!summary) return {};
  return { error: knownOAuthErrors.find((code) => code === summary.error) ?? "unrecognized" };
}

/** SDK OAuth messages contain provider descriptions or raw response bodies. */
export function oauthErrorLogText(error: unknown, text: string): string {
  return error instanceof OAuthError
    ? knownOAuthErrors.find((code) => code === error.errorCode) ?? "unrecognized"
    : text;
}
