import { describe, expect, it } from "vitest";
import * as net from "net";

import {
  getOAuthCallbackPortCandidates,
  getOAuthCallbackRetryCandidates,
  findAvailablePortFromCandidates,
  OAUTH_CALLBACK_DEFAULT_PORT,
  OAUTH_CALLBACK_VENDOR_COMMON_PORT,
} from "../portFinder.js";

// REBEL-7F9 Stage 2b (docs/plans/260803_rebel-7f9-swifteq-oauth-callback):
// the OAuth callback port picker moves from a linear 5173+ scan to an ordered
// candidate SEQUENCE so the authorize-probe retry loop (Stage 3) can advance
// across ports. Fresh, non-static-credential attempt-1 order is
// [5173, 8080, 5174, …5182] — attempt 1 byte-identical to today (5173),
// 8080 at position 2 (the port strict allow-list vendors like swifteq's Auth0
// pin). Static-credential connectors keep the linear 5173-first order
// (their redirect_uri is pinned in a vendor dashboard; probing alternates is
// futile).

describe("getOAuthCallbackPortCandidates", () => {
  it("fresh order contains 8080 and 5173–5182 exactly once each", () => {
    const candidates = getOAuthCallbackPortCandidates();
    const expected = [OAUTH_CALLBACK_VENDOR_COMMON_PORT];
    for (let p = 5173; p <= 5182; p++) expected.push(p);
    expect([...candidates].sort((a, b) => a - b)).toEqual(
      expected.sort((a, b) => a - b),
    );
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("fresh order: 5173 first (attempt 1 byte-identical to today), 8080 second", () => {
    const candidates = getOAuthCallbackPortCandidates();
    expect(candidates[0]).toBe(5173);
    expect(candidates[1]).toBe(8080);
    expect(candidates.slice(2)).toEqual([5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182]);
  });

  it("explicitly non-static-credential matches the fresh order", () => {
    expect(getOAuthCallbackPortCandidates({ staticCredentials: false })).toEqual(
      getOAuthCallbackPortCandidates(),
    );
  });

  it("static-credential connectors keep the linear 5173-first order (no 8080 insert)", () => {
    const candidates = getOAuthCallbackPortCandidates({ staticCredentials: true });
    expect(candidates[0]).toBe(5173);
    expect(candidates).toEqual([5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182]);
    expect(candidates).not.toContain(OAUTH_CALLBACK_VENDOR_COMMON_PORT);
  });
});

describe("getOAuthCallbackRetryCandidates (REBEL-7F9 Stage 3)", () => {
  it("orders [8080, 5173…5182] — vendor-common port first, then the linear scan", () => {
    expect(getOAuthCallbackRetryCandidates([])).toEqual([
      8080, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182,
    ]);
  });

  it("excludes already-failed ports while preserving order", () => {
    expect(getOAuthCallbackRetryCandidates([5173])).toEqual([
      8080, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182,
    ]);
    expect(getOAuthCallbackRetryCandidates([5173, 8080])).toEqual([
      5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182,
    ]);
    expect(getOAuthCallbackRetryCandidates([5173, 8080, 5174])[0]).toBe(5175);
  });

  it("ignores failed ports outside the candidate set", () => {
    expect(getOAuthCallbackRetryCandidates([12345])).toEqual(getOAuthCallbackRetryCandidates([]));
  });
});

describe("findAvailablePortFromCandidates", () => {
  function occupy(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.once("listening", () => resolve(server));
      server.listen(port, "127.0.0.1");
    });
  }

  it("returns the first candidate when free", async () => {
    const port = await findAvailablePortFromCandidates([53173, 53174]);
    expect(port).toBe(53173);
  });

  it("skips busy candidates and returns the next one in ORDER", async () => {
    const blocker = await occupy(53175);
    try {
      const port = await findAvailablePortFromCandidates([53175, 53176, 53177]);
      expect(port).toBe(53176);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("throws when every candidate is busy", async () => {
    const blocker = await occupy(53178);
    try {
      await expect(findAvailablePortFromCandidates([53178])).rejects.toThrow(
        /No available port/,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("default-port constant stays 5173 (attempt-1 stability)", () => {
    expect(OAUTH_CALLBACK_DEFAULT_PORT).toBe(5173);
  });
});
