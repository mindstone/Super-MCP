import { describe, expect, it } from "vitest";

import { isAuthLikeErrorMessageText, mentionsStatus401 } from "../src/auth/authLikeVocabulary.js";

// "401" counts as auth-like only as a status code, never as digits inside a
// port, a duration or an identifier (a random local port such as 40123 once
// made a temporary failure read as a sign-in request).
describe("401 as a status code only", () => {
  it.each([
    "Streamable HTTP error: Error POSTing to endpoint (HTTP 401): Unauthorized",
    "SSE error: Non-200 status code (401)",
    "401 Unauthorized",
    "Server returned 401.",
    '{"status":401}',
  ])("treats %j as a 401", (text) => {
    expect(mentionsStatus401(text)).toBe(true);
    expect(isAuthLikeErrorMessageText(text)).toBe(true);
  });

  it.each([
    "Failed to connect.\nURL: http://127.0.0.1:40123/mcp\nOriginal error: fetch failed",
    "URL: http://127.0.0.1:34017/mcp",
    "Request timed out after 1401ms",
    "request id a401f9",
    "trace 84012",
  ])("does not treat %j as a 401", (text) => {
    expect(mentionsStatus401(text)).toBe(false);
    expect(isAuthLikeErrorMessageText(text)).toBe(false);
  });
});
