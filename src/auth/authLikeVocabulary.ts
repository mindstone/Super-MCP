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
  "401",
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
  return AUTH_LIKE_MESSAGE_TOKENS.some((token) => normalized.includes(token));
}
