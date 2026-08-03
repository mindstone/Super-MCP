import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { SimpleOAuthProvider } from "../providers/simple.js";
import { OAUTH_REDIRECT_URI_REJECTED_CODE } from "../authorizeProbe.js";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));
// Never actually open a browser from a test.
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

// REBEL-7F9 Stage 3 refinement (testing F6): the retry suite's mock provider
// cannot manifest the synthetic-savedClientInfo leak (clause h) or show that
// invalidateCredentials("client") actually clears the persisted registration
// so the next attempt re-DCRs (the port-advancement mechanism for real-DCR
// vendors). These tests run the REAL SimpleOAuthProvider against a tmp token
// dir (SUPER_MCP_OAUTH_TOKEN_DIR) with a stubbed global fetch for the probe.

const TOKEN_DIR_ENV = "SUPER_MCP_OAUTH_TOKEN_DIR";

describe("real SimpleOAuthProvider retry isolation (tmp token dir)", () => {
  let tokenDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-test-"));
    process.env[TOKEN_DIR_ENV] = tokenDir;
  });

  afterEach(async () => {
    delete process.env[TOKEN_DIR_ENV];
    vi.unstubAllGlobals();
    await fs.rm(tokenDir, { recursive: true, force: true });
  });

  it("rejection → invalidateCredentials('client') clears the persisted registration so attempt 2 re-DCRs (port advancement)", async () => {
    const pkg = "retry-isolation-test";
    // The trapped registration: a saved DCR client pinned to 5173 (the
    // REBEL-7F9 reporter's shape).
    await fs.writeFile(
      path.join(tokenDir, `${pkg}_client.json`),
      JSON.stringify({
        client_id: "dcr-client-1",
        redirect_uris: ["http://localhost:5173/oauth/callback"],
      }),
    );

    // Attempt 1 (real provider on the saved port): registration matches the
    // port, so the staleness gate leaves it alone; the probe then classifies
    // a rejection (verbatim-style 403 phrase) and the coded error carries the
    // verdict channel.
    const attempt1 = new SimpleOAuthProvider(pkg, 5173);
    await attempt1.initialize();
    expect(await attempt1.clientInformation()).toMatchObject({ client_id: "dcr-client-1" });
    expect(await attempt1.checkAndInvalidateOnPortMismatch()).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Callback URL mismatch", { status: 403 })),
    );
    const authUrl = new URL(
      "https://auth.example.com/authorize?client_id=dcr-client-1&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Foauth%2Fcallback&state=state-1",
    );
    let thrown: unknown;
    try {
      await attempt1.redirectToAuthorization(authUrl);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);
    expect(attempt1.consumeProbeVerdict()?.outcome).toBe("rejected");
    // The coded error throws BEFORE any browser open.
    const { spawn } = await import("child_process");
    expect(spawn).not.toHaveBeenCalled();

    // The handler's port-advancement step (a).
    await attempt1.invalidateCredentials("client");

    // The saved registration is GONE from disk — attempt 2 must re-DCR with
    // the new redirect_uris, and the saved-port trap is cleared.
    await expect(fs.stat(path.join(tokenDir, `${pkg}_client.json`))).rejects.toThrow();
    expect(await SimpleOAuthProvider.getSavedClientPort(pkg)).toBeUndefined();

    // Attempt 2 (fresh provider, next candidate): fresh registration state —
    // no on-disk or in-memory leak from attempt 1.
    const attempt2 = new SimpleOAuthProvider(pkg, 8080);
    await attempt2.initialize();
    expect(await attempt2.clientInformation()).toBeUndefined();
    // Absent client file = fresh registration, NOT staleness (no per-launch
    // invalidation loop).
    expect(await attempt2.checkAndInvalidateOnPortMismatch()).toBe(false);
    // The verdict channel is per-instance: nothing leaks across attempts.
    expect(attempt2.consumeProbeVerdict()).toBeUndefined();
  });

  it("clause (h): a synthetic savedClientInfo synthesized on an accepted attempt never leaks into a fresh provider", async () => {
    const pkg = "synthetic-leak-test";
    // Accepted attempt: the probe sees a 302 to a login page (accepted), the
    // browser "opens" (spawn mocked), and redirectToAuthorization synthesizes
    // an in-memory savedClientInfo from the authorize URL's client_id (NO
    // redirect_uris) — the synthetic value that must never leak across
    // attempts into the Stage 2a stale rule.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Found", { status: 302, headers: { location: "/login?state=abc" } }),
      ),
    );
    const attempt1 = new SimpleOAuthProvider(pkg, 5173);
    await attempt1.initialize();
    await attempt1.redirectToAuthorization(
      new URL(
        "https://auth.example.com/authorize?client_id=dcr-client-9&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Foauth%2Fcallback&state=state-1",
      ),
    );
    expect(await attempt1.clientInformation()).toMatchObject({ client_id: "dcr-client-9" });

    // Fresh provider for the next attempt: no disk file, and the synthetic
    // in-memory value did not leak (module/static state keyed by packageId
    // would fail here).
    const attempt2 = new SimpleOAuthProvider(pkg, 8080);
    await attempt2.initialize();
    expect(await attempt2.clientInformation()).toBeUndefined();
    // The staleness gate reads ONLY disk: absent file → fresh, not stale.
    expect(await attempt2.checkAndInvalidateOnPortMismatch()).toBe(false);
  });

  it("hasPersistedAccessToken fails safe to false AND logs the cause at debug (runtime-safety F4 — no silent catch)", async () => {
    const pkg = "corrupt-token-test";
    await fs.writeFile(path.join(tokenDir, `${pkg}_tokens.json`), "{ not json");

    const result = await SimpleOAuthProvider.hasPersistedAccessToken(pkg);

    expect(result).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("hasPersistedAccessToken"),
      expect.objectContaining({ package_id: pkg, error: expect.any(String) }),
    );
  });
});
