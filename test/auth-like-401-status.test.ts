import { describe, expect, it } from "vitest";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";

import { isAuthLikeError, isAuthLikeErrorMessageText, mentionsStatus401 } from "../src/auth/authLikeVocabulary.js";

// FOX-9819: an empty-body 401 carries its status only in the SDK error's code.
describe("isAuthLikeError", () => {
  it.each([
    ["an empty-body Streamable HTTP 401", new StreamableHTTPError(401, "Error POSTing to endpoint: ")],
    ["an SSE 401", new SseError(401, "Non-200 status code", undefined as never)],
    ["the normalised sign-in error", Object.assign(new Error("Authentication required."), { name: "UnauthorizedError" })],
    ["a message naming the failure", new Error("invalid_token")],
    ["a thrown string naming the failure", "Unauthorized"],
    ["a thrown non-Error whose string form is a 401", 401],
  ])("treats %s as auth", (_label, error) => {
    expect(isAuthLikeError(error)).toBe(true);
  });

  it.each([
    ["a 404", new StreamableHTTPError(404, "Error POSTing to endpoint: ")],
    ["a 500", new StreamableHTTPError(500, "Error POSTing to endpoint: ")],
    ["a string code", Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })],
    ["a non-Error", { code: 401, message: "Unauthorized" }],
    ["a thrown string with no auth word", "socket hang up"],
  ])("does not treat %s as auth", (_label, error) => {
    expect(isAuthLikeError(error)).toBe(false);
  });
});

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
