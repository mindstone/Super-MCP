import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpMcpClient, FINISH_AUTH_TIMEOUT_MS, OAUTH_FINISH_AUTH_TIMEOUT_CODE } from "../httpClient.js";
import type { PackageConfig } from "../../types.js";
import { SimpleOAuthProvider } from "../../auth/providers/simple.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const homes: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  async function callbackClient() {
    const home = await mkdtemp(path.join(tmpdir(), "finish-auth-classification-"));
    homes.push(home);
    vi.stubEnv("SUPER_MCP_OAUTH_TOKEN_DIR", home);
    const provider = new SimpleOAuthProvider("fictional-callback", 5173);
    const client = new HttpMcpClient("fictional-callback", oauthHttpPackage("fictional-callback"), { oauthProvider: provider });
    // Existing transport seam: exchange/reconnect faults, real provider invalidation.
    const internals = client as any;
    internals.simpleOAuthProvider = provider;
    internals.createTransport = () => ({});
    internals.connectWithTimeout = async () => {};
    internals.client = { close: vi.fn(async () => {}) };
    return { client, provider, internals };
  }

  it("classifies only a rejected exchange that invalidated all and retains the cause internally", async () => {
    const { client, provider, internals } = await callbackClient();
    const original = new Error("fictional secondary SDK failure");
    internals.transport = { finishAuth: async () => {
      await provider.invalidateCredentials("all");
      throw original;
    } };
    await expect(client.finishOAuth("fictional-code")).rejects.toMatchObject({
      code: "OAUTH_CLIENT_REJECTED", message: "OAUTH_CLIENT_REJECTED", cause: original,
    });
  });

  it.each(["unrelated", "initial missing-client", "earlier all", "tokens-only invalid_grant", "client-only"])("does not relabel %s", async (kind) => {
    const { client, provider, internals } = await callbackClient();
    const original = new Error(kind === "initial missing-client"
      ? "Existing OAuth client information is required when exchanging an authorization code" : kind);
    if (kind === "earlier all") await provider.invalidateCredentials("all");
    internals.transport = { finishAuth: async () => {
      if (kind === "tokens-only invalid_grant") await provider.invalidateCredentials("tokens");
      if (kind === "client-only") await provider.invalidateCredentials("client");
      throw original;
    } };
    await expect(client.finishOAuth("fictional-code")).rejects.toBe(original);
  });

  it.each(["marker clearing", "reconnect"])("does not relabel %s errors after a successful exchange", async (phase) => {
    const { client, provider, internals } = await callbackClient();
    const original = new Error("fictional post-exchange error");
    internals.transport = { finishAuth: async () => {} };
    const fail = async () => { await provider.invalidateCredentials("all"); throw original; };
    if (phase === "marker clearing") vi.spyOn(provider, "clearNeedsReconnectMarker").mockImplementation(fail);
    else internals.connectWithTimeout = fail;
    await expect(client.finishOAuth("fictional-code")).rejects.toBe(original);
  });

  it("keeps an existing timeout error unchanged even after all invalidation", async () => {
    const { client, provider, internals } = await callbackClient();
    const timeout = Object.assign(new Error("fictional timeout"), { code: OAUTH_FINISH_AUTH_TIMEOUT_CODE });
    internals.transport = { finishAuth: async () => { await provider.invalidateCredentials("all"); throw timeout; } };
    await expect(client.finishOAuth("fictional-code")).rejects.toBe(timeout);
  });

  it("all invalidation followed by a hung retry still times out, including a later losing rejection", async () => {
    const { client, provider, internals } = await callbackClient();
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    let invalidated!: () => void;
    const invalidation = new Promise<void>(resolve => { invalidated = resolve; });
    internals.transport = { finishAuth: async () => {
      await provider.invalidateCredentials("all");
      invalidated();
      return new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    } };
    const assertion = expect(client.finishOAuth("fictional-code")).rejects.toMatchObject({ code: OAUTH_FINISH_AUTH_TIMEOUT_CODE });
    await invalidation;
    await vi.advanceTimersByTimeAsync(FINISH_AUTH_TIMEOUT_MS);
    await assertion;
    rejectLate(new Error("fictional late secondary SDK rejection"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it(`rejects after ${FINISH_AUTH_TIMEOUT_MS}ms when the transport's finishAuth hangs`, async () => {
    vi.useFakeTimers();

    const client = new HttpMcpClient("HungTokenEndpoint", oauthHttpPackage("HungTokenEndpoint"), {
      oauthPort: 5173,
    });
    // A token endpoint that never responds: finishAuth never settles.
    (client as any).transport = { finishAuth: () => new Promise(() => {}) };

    const finishPromise = client.finishOAuth("auth-code-hung");
    // The rejection must carry the machine code — handleAuthenticate classifies
    // the timeout by code, never by message text (audit F1). The handler-level
    // half lives in src/handlers/__tests__/authenticateFinishAuthTimeout.test.ts.
    const assertion = expect(finishPromise).rejects.toMatchObject({
      message: `OAuth token exchange timed out after ${FINISH_AUTH_TIMEOUT_MS}ms`,
      code: OAUTH_FINISH_AUTH_TIMEOUT_CODE,
    });

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
