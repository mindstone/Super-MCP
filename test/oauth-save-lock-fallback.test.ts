import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// A busy token lock may drop a routine save (it is logged), but never a new
// interactive grant: that save retries, then writes without the lock.

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const lockAttempts = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/logging.js", () => ({ getLogger: () => mockLogger }));
vi.mock("../src/auth/tokenRefreshLock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/tokenRefreshLock.js")>();
  return {
    ...actual,
    withTokenRefreshLock: vi.fn(async (packageId: string) => {
      lockAttempts.count += 1;
      throw new actual.TokenRefreshLockBusyError(packageId);
    }),
  };
});

import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";

describe("saveTokens when the token lock stays busy", () => {
  let tempDir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    lockAttempts.count = 0;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-save-lock-"));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("never drops a new interactive grant", async () => {
    const provider = new SimpleOAuthProvider("Acme-notes");
    (provider as any).redirectStarted = true; // the browser flow ran: this save is a new grant
    await provider.saveTokens({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
    const disk = JSON.parse(await fs.readFile(path.join(tempDir, "Acme-notes_tokens.json"), "utf8"));
    expect(disk.refresh_token).toBe("refresh-new");
    expect(lockAttempts.count).toBe(9);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Saving a new sign-in without the token lock",
      expect.objectContaining({ error_name: "TokenRefreshLockBusyError", attempts: 9 }),
    );
  });

  it("drops and logs a routine save", async () => {
    const provider = new SimpleOAuthProvider("Acme-notes");
    await provider.saveTokens({ access_token: "access-routine", token_type: "Bearer" });
    await expect(fs.access(path.join(tempDir, "Acme-notes_tokens.json"))).rejects.toThrow();
    expect(lockAttempts.count).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to persist OAuth tokens", expect.any(Object));
  });
});
