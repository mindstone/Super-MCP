import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// Saves run under the token lock. A routine save that can't get it is dropped
// and logged; a new interactive grant waits a bounded time that fits inside
// finishOAuth's 30 s exchange timeout, then fails the sign-in. Never an
// unlocked write.

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const lockCalls = vi.hoisted(() => [] as Array<{ options?: any }>);

vi.mock("../src/logging.js", () => ({ getLogger: () => mockLogger }));
vi.mock("../src/auth/tokenRefreshLock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/tokenRefreshLock.js")>();
  return {
    ...actual,
    withTokenRefreshLock: vi.fn(async (packageId: string, _path: string, _fn: unknown, options?: unknown) => {
      lockCalls.push({ options });
      throw new actual.TokenRefreshLockBusyError(packageId);
    }),
  };
});

import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import { FINISH_AUTH_TIMEOUT_MS } from "../src/clients/httpClient.js";

describe("saveTokens when the token lock stays busy", () => {
  let tempDir: string;
  const savedEnv = { ...process.env };
  const tokenFile = () => path.join(tempDir, "Acme-notes_tokens.json");

  beforeEach(async () => {
    vi.clearAllMocks();
    lockCalls.length = 0;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-save-lock-"));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fails a new interactive sign-in after a bounded wait, and never writes without the lock", async () => {
    const provider = new SimpleOAuthProvider("Acme-notes");
    (provider as any).redirectStarted = true; // the browser flow ran: this save is a new grant
    await expect(
      provider.saveTokens({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" }),
    ).rejects.toThrow(/busy/);
    await expect(fs.access(tokenFile())).rejects.toThrow();

    expect(lockCalls).toHaveLength(1);
    const { retries, minTimeout, maxTimeout, factor } = lockCalls[0].options.retries;
    let worstCaseWaitMs = 0;
    for (let i = 0; i < retries; i++) worstCaseWaitMs += Math.min(maxTimeout, 2 * minTimeout * factor ** i);
    expect(worstCaseWaitMs).toBeLessThanOrEqual(25_000);
    expect(worstCaseWaitMs).toBeLessThan(FINISH_AUTH_TIMEOUT_MS);
  });

  it("drops and logs a routine save, with the default lock budget", async () => {
    const provider = new SimpleOAuthProvider("Acme-notes");
    await provider.saveTokens({ access_token: "access-routine", token_type: "Bearer" });
    await expect(fs.access(tokenFile())).rejects.toThrow();
    expect(lockCalls).toEqual([{ options: undefined }]);
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to persist OAuth tokens", expect.objectContaining({ interactive: false }));
  });
});
