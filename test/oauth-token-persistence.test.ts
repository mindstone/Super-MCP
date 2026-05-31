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

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Ignoring token invalidation request in refresh-only mode",
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
