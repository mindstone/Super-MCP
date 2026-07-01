import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { HttpMcpClient } from "../src/clients/httpClient.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import type { PackageConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// F4 (260701_mcp-reconnect-prompt plan critique): the interactive
// authorization-code path (`finishOAuth`) must clear the `needsReconnect`
// marker on success. The refresh path already clears it on a successful
// rotation (refreshTransaction.ts); this proves the sibling clear for the
// browser re-auth path — without it, an in-app "Reconnect" that succeeds would
// leave a stale marker and the host would keep prompting.
// ---------------------------------------------------------------------------

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => mockLogger,
}));

const ENV_KEY = "SUPER_MCP_OAUTH_TOKEN_DIR";

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

describe("finishOAuth clears the needsReconnect marker (F4)", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-finish-marker-"));
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

  it("removes ${packageId}_needsReconnect.json after a successful browser re-auth", async () => {
    const packageId = "Notion-finish";
    const markerPath = path.join(tempDir, `${packageId}_needsReconnect.json`);

    // A dead grant previously flagged reconnect (the real writer).
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();
    await provider.clearTokensAndMarkNeedsReconnect({
      error: "invalid_grant",
      error_description: "Grant not found",
    });
    // Precondition: the marker exists.
    await expect(fs.access(markerPath)).resolves.toBeUndefined();

    // Build a client and short-circuit the post-exchange reconnect machinery so
    // the test exercises finishOAuth's clear without a real network transport.
    const client = new HttpMcpClient(packageId, oauthHttpPackage(packageId), {
      oauthPort: 5173,
      oauthProvider: provider,
    });
    // finishOAuth reads `this.simpleOAuthProvider` (normally set during OAuth
    // init) — wire it directly to isolate the finish path.
    (client as any).simpleOAuthProvider = provider;
    (client as any).transport = { finishAuth: vi.fn(async () => {}) };
    (client as any).createTransport = () => ({});
    (client as any).connectWithTimeout = async () => {};
    (client as any).client = { close: vi.fn(async () => {}) };

    await client.finishOAuth("auth-code-xyz");

    // The marker is gone → the host stops prompting reconnect for this connector.
    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  it("is a no-op on a first-time connect (no marker present)", async () => {
    const packageId = "Linear-firstconnect";
    const markerPath = path.join(tempDir, `${packageId}_needsReconnect.json`);

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const client = new HttpMcpClient(packageId, oauthHttpPackage(packageId), {
      oauthPort: 5173,
      oauthProvider: provider,
    });
    (client as any).simpleOAuthProvider = provider;
    (client as any).transport = { finishAuth: vi.fn(async () => {}) };
    (client as any).createTransport = () => ({});
    (client as any).connectWithTimeout = async () => {};
    (client as any).client = { close: vi.fn(async () => {}) };

    // No marker to begin with, and finishOAuth must not create one or throw.
    await expect(fs.access(markerPath)).rejects.toThrow();
    await client.finishOAuth("auth-code-abc");
    await expect(fs.access(markerPath)).rejects.toThrow();
  });
});
