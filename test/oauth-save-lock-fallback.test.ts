import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// Host and held saves run under the token lock. A routine save that can't get it is dropped
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

import { SimpleOAuthProvider, RENEWAL_HELD_FIELD, OBTAINED_AT_FIELD } from "../src/auth/providers/simple.js";
import { RefreshOnlyOAuthProvider } from "../src/auth/providers/refreshOnly.js";
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
    delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
    delete process.env.MCP_HOST_BRIDGE_STATE;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "fails a new interactive sign-in after a bounded wait, without an unlocked write (host=%s)",
    async (host) => {
      if (host) {
        process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
        process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
      } else {
        await fs.writeFile(tokenFile(), JSON.stringify({ [RENEWAL_HELD_FIELD]: true }));
      }
      const provider = new SimpleOAuthProvider("Acme-notes");
      if (host) {
        provider.setHostGrantConfig({
          id: "Acme-notes",
          name: "Acme-notes",
          transport: "http",
          oauth: true,
          base_url: "https://mcp.example.com/mcp",
          oauthClientId: "static-client",
          visibility: "default",
        });
      }
      (provider as any).redirectStarted = true; // the browser flow ran: this save is a new grant
      await expect(
        provider.saveTokens({
          access_token: "access-new",
          token_type: "Bearer",
          refresh_token: "refresh-new",
        }),
      ).rejects.toThrow(/busy/);
      if (host) await expect(fs.access(tokenFile())).rejects.toThrow();
      else expect(JSON.parse(await fs.readFile(tokenFile(), "utf8"))).toEqual({ [RENEWAL_HELD_FIELD]: true });

      expect(lockCalls).toHaveLength(1);
      const { retries, minTimeout, maxTimeout, factor } = lockCalls[0].options.retries;
      let worstCaseWaitMs = 0;
      for (let i = 0; i < retries; i++) worstCaseWaitMs += Math.min(maxTimeout, 2 * minTimeout * factor ** i);
      expect(worstCaseWaitMs).toBeLessThanOrEqual(25_000);
      expect(worstCaseWaitMs).toBeLessThan(FINISH_AUTH_TIMEOUT_MS);
    },
  );

  it("drops and logs a routine save, with the default lock budget", async () => {
    process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
    process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
    const provider = new SimpleOAuthProvider("Acme-notes");
    await provider.saveTokens({ access_token: "access-routine", token_type: "Bearer" });
    await expect(fs.access(tokenFile())).rejects.toThrow();
    expect(lockCalls).toEqual([{ options: undefined }]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to persist OAuth tokens",
      expect.objectContaining({ interactive: false }),
    );
  });

  it("keeps standalone non-held saves unlocked and tolerates interactive persistence failures", async () => {
    const provider = new SimpleOAuthProvider("Acme-notes");
    (provider as any).redirectStarted = true;
    await provider.saveTokens({ access_token: "access-new", token_type: "Bearer" });
    expect(JSON.parse(await fs.readFile(tokenFile(), "utf8"))).toMatchObject({ access_token: "access-new" });
    expect(lockCalls).toEqual([]);

    vi.spyOn(provider, "atomicWriteTokens").mockRejectedValue(new Error("write failed"));
    await expect(
      provider.saveTokens({ access_token: "access-next", token_type: "Bearer" }),
    ).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to persist OAuth tokens", {
      package_id: "Acme-notes",
      error: "write failed",
    });
    expect(lockCalls).toEqual([]);
  });

  it("uses the interactive budget only for the first host save after redirect", async () => {
    process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
    process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
    const provider = new SimpleOAuthProvider("Acme-notes");
    (provider as any).redirectStarted = true;
    await expect(provider.saveTokens({ access_token: "new", token_type: "Bearer" })).rejects.toThrow(/busy/);
    await expect(
      provider.saveTokens({ access_token: "echo", token_type: "Bearer" }),
    ).resolves.toBeUndefined();
    expect(lockCalls[0].options).toHaveProperty("retries");
    expect(lockCalls[1].options).toBeUndefined();
  });

  it.each([
    [60_000, "unavailable"],
    [-1000, "unavailable"],
    [60_000, "missing"],
    [-1000, "missing"],
  ] as const)(
    "a busy legacy-preparation lock uses the cache or pauses (remaining=%s, status=%s)",
    async (remaining, status) => {
      process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
      process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
      await fs.writeFile(
        process.env.MCP_HOST_BRIDGE_STATE,
        JSON.stringify({ port: 12345, token: "bridge-token" }),
      );
      const disk = {
        access_token: "access-old",
        refresh_token: "refresh-old",
        token_type: "Bearer",
        expires_in: 3600,
        [OBTAINED_AT_FIELD]: Date.now() - 3_600_000 + remaining,
      };
      await fs.writeFile(tokenFile(), JSON.stringify(disk));
      const bytes = await fs.readFile(tokenFile(), "utf8");
      const bridge = vi.fn(async () => Response.json(
        status === "missing" ? { status, bootstrapAllowed: true } : { status, reason: "offline" },
      ));
      vi.stubGlobal("fetch", bridge);
      const provider = new SimpleOAuthProvider("Acme-notes");
      if (remaining > 0) {
        expect(await provider.tokens()).toHaveProperty("access_token", "access-old");
      } else {
        expect(await provider.tokens()).toBeUndefined();
        await expect(
          new RefreshOnlyOAuthProvider(provider).redirectToAuthorization(
            new URL("https://mcp.example.com/mcp"),
          ),
        ).rejects.toThrow(/paused until/);
      }
      expect(await fs.readFile(tokenFile(), "utf8")).toBe(bytes);
      await expect(fs.access(path.join(tempDir, "Acme-notes_needsReconnect.json"))).rejects.toThrow();
      expect(lockCalls).toHaveLength(1);
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith("Host grant preparation deferred", {
        package_id: "Acme-notes",
        error_name: "TokenRefreshLockBusyError",
      });
    },
  );
});
