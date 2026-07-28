import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpMcpClient, FINISH_AUTH_TIMEOUT_MS } from "../httpClient.js";
import type { PackageConfig } from "../../types.js";

// Stage 4 of docs/plans/260728_mcp-connector-setup-failures (app repo):
// transport.finishAuth previously had NO timeout, so a hung token endpoint
// consumed the desktop host's whole outer authenticate budget and reported a
// completed sign-in as a timeout. finishOAuth must bound the exchange with
// FINISH_AUTH_TIMEOUT_MS.

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

function oauthHttpPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    base_url: "https://mcp.example.com/mcp",
    oauth: true,
    visibility: "default",
  } as PackageConfig;
}

describe("finishOAuth token-exchange timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it(`rejects after ${FINISH_AUTH_TIMEOUT_MS}ms when the transport's finishAuth hangs`, async () => {
    vi.useFakeTimers();

    const client = new HttpMcpClient("HungTokenEndpoint", oauthHttpPackage("HungTokenEndpoint"), {
      oauthPort: 5173,
    });
    // A token endpoint that never responds: finishAuth never settles.
    (client as any).transport = { finishAuth: () => new Promise(() => {}) };

    const finishPromise = client.finishOAuth("auth-code-hung");
    const assertion = expect(finishPromise).rejects.toThrow(
      `OAuth token exchange timed out after ${FINISH_AUTH_TIMEOUT_MS}ms`
    );

    await vi.advanceTimersByTimeAsync(FINISH_AUTH_TIMEOUT_MS);
    await assertion;
  });

  it("completes normally when finishAuth resolves before the timeout", async () => {
    const finishAuth = vi.fn(async () => {});
    const client = new HttpMcpClient("FastTokenEndpoint", oauthHttpPackage("FastTokenEndpoint"), {
      oauthPort: 5173,
    });
    // Short-circuit the post-exchange reconnect machinery so the test isolates
    // the timeout race around finishAuth (same pattern as
    // test/oauth-finish-clears-marker.test.ts).
    (client as any).transport = { finishAuth };
    (client as any).createTransport = () => ({});
    (client as any).connectWithTimeout = async () => {};
    (client as any).client = { close: vi.fn(async () => {}) };

    await expect(client.finishOAuth("auth-code-fast")).resolves.toBeUndefined();
    expect(finishAuth).toHaveBeenCalledWith("auth-code-fast");
  });
});
