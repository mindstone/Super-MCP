import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const knownOAuthErrors = [
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope",
] as const;

/** SDK OAuth messages contain provider descriptions or raw response bodies. */
export function oauthErrorLogText(error: unknown, text: string): string {
  return error instanceof OAuthError
    ? knownOAuthErrors.find((code) => code === error.errorCode) ?? "unrecognized"
    : text;
}
