/**
 * Auth-like message vocabulary — the token list httpClient's connectWithOAuth
 * treats as an EXPECTED auth outcome (swallowed: the connect promise resolves
 * and the callback wait runs its full course).
 *
 * LEAF MODULE by design (runtime-safety F6): both clients/httpClient.ts (the
 * swallow site) and auth/authorizeProbe.ts (the coded-rejection construction
 * site, whose message must provably NEVER match this vocabulary) import from
 * here. Defining it in httpClient.ts and importing it from authorizeProbe.ts
 * would close an authorizeProbe ↔ httpClient import cycle (httpClient
 * re-exports OAUTH_REDIRECT_URI_REJECTED_CODE from authorizeProbe).
 */
const AUTH_LIKE_MESSAGE_TOKENS = [
  "redirect initiated",
  "unauthorized",
  "invalid_token",
  "missing authorization",
  "authentication required",
] as const;

/**
 * Pure form of the auth-like message vocabulary, exported so the authorize
 * probe's rejection-message contract can be pinned by tests (recall#2 F2(c)):
 * a message matching these tokens is treated as an EXPECTED auth outcome and
 * swallowed (connectWithOAuth in clients/httpClient.ts), so the probe's coded
 * rejection message must provably never contain any of them.
 */
export function isAuthLikeErrorMessageText(message: string): boolean {
  const normalized = message.toLowerCase();
  return mentionsStatus401(message) || AUTH_LIKE_MESSAGE_TOKENS.some((token) => normalized.includes(token));
}

/**
 * The one way to classify a caught failure as sign-in needed: by name, by
 * numeric status, or by message. The MCP SDK's StreamableHTTPError / SseError
 * carry the HTTP status only in `.code` when no auth provider is attached, so a
 * 401 with an empty body ("Error POSTing to endpoint: ") is recognised by its
 * code alone. Any other thrown value is read as its string form. Catch sites call this,
 * never the message form (FOX-9819; test/auth-like-classifier-guard.test.ts).
 */
export function isAuthLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return isAuthLikeErrorMessageText(String(error));
  return (
    error.name === "UnauthorizedError" ||
    (error as { code?: unknown }).code === 401 ||
    isAuthLikeErrorMessageText(error.message)
  );
}

/**
 * True when the text carries 401 as a status code: the whole number, not
 * digits inside a port (127.0.0.1:40123), a duration (1401ms) or an id. Every
 * "401" check on error text goes through here.
 */
export function mentionsStatus401(text: string): boolean {
  return /\b401\b/.test(text);
}
