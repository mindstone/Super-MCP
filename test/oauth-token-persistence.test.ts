import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => mockLogger,
}));

import { RefreshOnlyOAuthProvider, SimpleOAuthProvider } from "../src/auth/providers/index.js";

const ENV_KEY = "SUPER_MCP_OAUTH_TOKEN_DIR";

describe("OAuth token persistence", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-test-"));
    process.env[ENV_KEY] = tempDir;
  });

  afterEach(async () => {
    if (previousTokenDir === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // INV-A: a save carrying a NEW access_token but omitting the refresh_token must
  // persist the new access_token (the merge preserves the existing refresh_token).
  // Regression for the stale-write guard, which previously skipped the whole write
  // whenever incoming omitted a refresh_token — discarding the new access_token.
  it("preserves the refresh token when a refresh response only returns a new access token", async () => {
    const provider = new SimpleOAuthProvider("Notion-test", 5173);
    await provider.initialize();

    await provider.saveTokens({
      access_token: "old-access",
      refresh_token: "durable-refresh",
      expires_in: 3600,
    });
    await provider.saveTokens({
      access_token: "new-access",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-test_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "new-access",
      refresh_token: "durable-refresh",
      expires_in: 3600,
    });
  });

  // INV-A (variant): a save that REPEATS the same refresh_token but carries a new
  // access_token must still persist the new access_token (must not be skipped as
  // "redundant" — it is not redundant, the access_token changed).
  it("INV-A: persists a new access_token even when the refresh_token is repeated unchanged", async () => {
    const provider = new SimpleOAuthProvider("Notion-inv-a", 5173);
    await provider.initialize();

    await provider.saveTokens({
      access_token: "old-access",
      refresh_token: "same-refresh",
      expires_in: 3600,
    });
    await provider.saveTokens({
      access_token: "new-access",
      refresh_token: "same-refresh",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-inv-a_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "new-access",
      refresh_token: "same-refresh",
    });
  });

  // INV-B: after an authoritative (in-lock) persist, the SDK's unavoidable SECOND
  // save echoes back the same token set. If a concurrent peer rotated the on-disk
  // token in the interim, that stale echo must NOT downgrade the newer disk token.
  it("INV-B: the SDK's redundant echo does not clobber a newer token a peer wrote in the interim", async () => {
    const provider = new SimpleOAuthProvider("Notion-inv-b", 5173);
    await provider.initialize();

    // Authoritative (in-lock) persist of the rotation this process obtained.
    await provider.persistRotatedTokensOrThrow({
      access_token: "access-v1",
      refresh_token: "refresh-v1",
      expires_in: 3600,
    });

    // A concurrent PEER process rotates the shared on-disk token to v2 (modelled
    // by a second provider sharing the same token dir).
    const peer = new SimpleOAuthProvider("Notion-inv-b", 5173);
    await peer.initialize();
    await peer.persistRotatedTokensOrThrow({
      access_token: "access-v2",
      refresh_token: "refresh-v2",
      expires_in: 3600,
    });

    // The SDK now fires this process's unavoidable second save, echoing the v1
    // tokens it was handed. This must be recognised as a stale echo and skipped,
    // NOT downgrade the peer's v2 token.
    await provider.saveTokens({
      access_token: "access-v1",
      refresh_token: "refresh-v1",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-inv-b_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "access-v2",
      refresh_token: "refresh-v2",
    });
  });

  // INV-B (corollary): the SDK's redundant echo when disk is UNCHANGED is a no-op
  // re-write — it must not error, and disk must still hold the same tokens (we
  // also assert no extra access-token churn by checking the value is unchanged).
  it("INV-B: a redundant echo with unchanged disk is a benign no-op", async () => {
    const provider = new SimpleOAuthProvider("Notion-inv-b2", 5173);
    await provider.initialize();

    await provider.persistRotatedTokensOrThrow({
      access_token: "access-x",
      refresh_token: "refresh-x",
      expires_in: 3600,
    });
    // SDK echoes the same set; disk unchanged → skip.
    await provider.saveTokens({
      access_token: "access-x",
      refresh_token: "refresh-x",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-inv-b2_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "access-x",
      refresh_token: "refresh-x",
    });
  });

  // INV-C: a genuine interactive authenticate() save (no prior tokens on disk)
  // persists normally.
  it("INV-C: a genuine interactive save (no prior tokens) persists normally", async () => {
    const provider = new SimpleOAuthProvider("Notion-inv-c", 5173);
    await provider.initialize();

    await provider.saveTokens({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-inv-c_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
    });
  });

  // INV-C (variant): a genuine re-auth that replaces an existing grant with a
  // brand-new credential (different access AND refresh) must be persisted, not
  // skipped — it is neither a redundant echo nor a stale-peer echo.
  it("INV-C: an interactive re-auth replacing an existing grant is persisted", async () => {
    const provider = new SimpleOAuthProvider("Notion-inv-c2", 5173);
    await provider.initialize();

    await provider.saveTokens({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_in: 3600,
    });
    // Full interactive re-auth: entirely new credential.
    await provider.saveTokens({
      access_token: "reauth-access",
      refresh_token: "reauth-refresh",
      expires_in: 3600,
    });

    const tokenFile = path.join(tempDir, "Notion-inv-c2_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "reauth-access",
      refresh_token: "reauth-refresh",
    });
  });

  it("does not delete persisted tokens when the SDK asks for token invalidation during refresh-only startup", async () => {
    const provider = new SimpleOAuthProvider("Notion-test", 5173);
    await provider.initialize();
    await provider.saveTokens({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });

    const refreshOnlyProvider = new RefreshOnlyOAuthProvider(provider);
    await refreshOnlyProvider.invalidateCredentials("tokens");

    const tokenFile = path.join(tempDir, "Notion-test_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });

  it("logs allowed OAuth error fields and clears consumed error on refresh-only token invalidation", async () => {
    const provider = new SimpleOAuthProvider("Notion-test", 5173);
    await provider.initialize();
    await provider.saveTokens({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
    provider.setLastOAuthError({
      error: "invalid_grant",
      error_description: "Refresh token revoked",
    });

    const refreshOnlyProvider = new RefreshOnlyOAuthProvider(provider);
    await refreshOnlyProvider.invalidateCredentials("tokens");

    // Post-fix: refresh-only token invalidation is disk-compare aware. With
    // on-disk tokens present and no dead-grant marker, it preserves them and
    // logs the (consumed) OAuth error fields. (Stage 6 expands this suite with
    // the dead-grant clearing + peer-rotation cases; this assertion only pins
    // that the error fields are still surfaced and the error is consumed.)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Token invalidation (refresh-only): preserving on-disk tokens",
      expect.objectContaining({
        error: "invalid_grant",
        error_description: "Refresh token revoked",
      }),
    );

    const tokenFile = path.join(tempDir, "Notion-test_tokens.json");
    const saved = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    expect(saved).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });

    expect(provider.consumeLastOAuthError()).toBeUndefined();
  });
});
