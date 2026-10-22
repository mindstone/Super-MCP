import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import express from "express";
import type { AddressInfo } from "node:net";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  setLevel: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => mockLogger,
}));

import { createResponseNormalizingFetch } from "../src/clients/httpClient.js";
import {
  SimpleOAuthProvider,
  RENEWAL_HELD_FIELD,
  OBTAINED_AT_FIELD,
} from "../src/auth/providers/simple.js";
import { RefreshOnlyOAuthProvider } from "../src/auth/providers/refreshOnly.js";
import { withTokenRefreshLock } from "../src/auth/tokenRefreshLock.js";
import { applyStartupRenewalHold, runHostOp, type HostOpsDeps } from "../src/auth/hostOps.js";
import { registerHttpApiRoutes } from "../src/server.js";
import type { PackageConfig } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import { createMockTokenEndpoint, type MockTokenEndpointHandle } from "./helpers/mockTokenEndpoint.js";

// Host operations for a host that keeps one owner per refresh token across
// machines (app repo plan 261022_fox-5673-connector-token-owner, Stage 3). All
// fixtures are synthetic; no real accounts or secrets.

const PKG = "Acme-notes";
const TOKEN_URL = "https://auth.example.test/token";
const BASE_URL = "https://mcp.example.com/mcp";

let tempDir: string;
let exportDir: string;
const savedEnv = { ...process.env };

function tokenPath(id = PKG): string {
  return path.join(tempDir, `${id}_tokens.json`);
}
function markerPath(id = PKG): string {
  return path.join(tempDir, `${id}_needsReconnect.json`);
}
function clientPath(id = PKG): string {
  return path.join(tempDir, `${id}_client.json`);
}
async function readJson(filePath: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data), { mode: 0o600 });
}
async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

function oauthPackage(): PackageConfig {
  return { id: PKG, name: PKG, transport: "http", base_url: BASE_URL, oauth: true, visibility: "default" } as PackageConfig;
}

function deps(overrides: Partial<HostOpsDeps> = {}): HostOpsDeps {
  return { getPackage: (id) => (id === PKG ? oauthPackage() : undefined), ...overrides };
}

/** Token file whose access token has `remainingMs` left (obtained-at stamp back-dated). */
function tokensWithRemaining(refreshToken: string | undefined, remainingMs: number, expiresIn = 3600): any {
  return {
    access_token: "access-old",
    token_type: "Bearer",
    expires_in: expiresIn,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    [OBTAINED_AT_FIELD]: Date.now() - (expiresIn * 1000 - remainingMs),
  };
}

function metadata(): AuthorizationServerMetadata {
  return {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: TOKEN_URL,
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  } as AuthorizationServerMetadata;
}

/** Network for SDK auth(): no protected-resource metadata, AS metadata, token endpoint. */
function sdkNetwork(endpoint: MockTokenEndpointHandle): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("oauth-protected-resource")) return new Response("not found", { status: 404 });
    if (url.includes("oauth-authorization-server")) {
      return new Response(JSON.stringify(metadata()), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === TOKEN_URL) return endpoint.fetch(input, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-host-ops-"));
  exportDir = path.join(tempDir, "pending");
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
  process.env.SUPER_MCP_EXPORT_DIR = exportDir;
  delete process.env.SUPER_MCP_HOLD_RENEWAL;
  delete process.env.SUPER_MCP_APP_NAME;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("spender boundary on a held file", () => {
  it("a held file plus a stale SDK refresh token makes no POST and writes no marker", async () => {
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    // Access-only held cache, expired; the SDK still remembers r0 in memory.
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, -1000), [RENEWAL_HELD_FIELD]: true });
    const provider = new SimpleOAuthProvider(PKG);
    await provider.initialize();
    const wrapped = createResponseNormalizingFetch(endpoint.fetch, undefined, provider);

    await expect(
      refreshAuthorization(metadata().issuer, {
        metadata: metadata(),
        clientInformation: { client_id: "public-client" } as any,
        refreshToken: "refresh-r0",
        fetchFn: wrapped,
      }),
    ).rejects.toThrow(/is paused until/);

    expect(endpoint.callCount()).toBe(0);
    expect(await exists(markerPath())).toBe(false);
    expect((await readJson(tokenPath()))[RENEWAL_HELD_FIELD]).toBe(true);
  });

  it("a held file that still has its refresh token is not spent either", async () => {
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r0", -1000), [RENEWAL_HELD_FIELD]: true });
    const provider = new SimpleOAuthProvider(PKG);
    const wrapped = createResponseNormalizingFetch(endpoint.fetch, undefined, provider);
    await expect(
      refreshAuthorization(metadata().issuer, {
        metadata: metadata(),
        clientInformation: { client_id: "public-client" } as any,
        refreshToken: "refresh-r0",
        fetchFn: wrapped,
      }),
    ).rejects.toThrow();
    expect(endpoint.callCount()).toBe(0);
    expect((await readJson(tokenPath())).refresh_token).toBe("refresh-r0");
  });

  it("a delayed save can't restore a refresh token to a held cache", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true });
    const provider = new SimpleOAuthProvider(PKG);
    await provider.saveTokens({ access_token: "access-late", token_type: "Bearer", refresh_token: "refresh-stale" });
    const disk = await readJson(tokenPath());
    expect(disk.refresh_token).toBeUndefined();
    expect(disk.access_token).toBe("access-late");
    expect(disk[RENEWAL_HELD_FIELD]).toBe(true);
  });

  it("an authorization-code save on a held file writes the new grant and keeps the field", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, -1000), [RENEWAL_HELD_FIELD]: true });
    const provider = new SimpleOAuthProvider(PKG);
    // The interactive flow opened the browser, so the next save is a new grant.
    (provider as any).redirectStarted = true;
    await provider.saveTokens({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
    const disk = await readJson(tokenPath());
    expect(disk.refresh_token).toBe("refresh-new");
    expect(disk[RENEWAL_HELD_FIELD]).toBe(true);
  });

  it("dead-grant clears never run for held files", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r0", -1000), [RENEWAL_HELD_FIELD]: true });
    const provider = new SimpleOAuthProvider(PKG);
    await provider.clearTokensAndMarkNeedsReconnect({ error: "invalid_grant" });
    await new RefreshOnlyOAuthProvider(provider).invalidateCredentials("tokens");
    expect((await readJson(tokenPath())).refresh_token).toBe("refresh-r0");
    expect(await exists(markerPath())).toBe(false);
  });

  it("the SDK never sees the private fields", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true });
    const tokens = await new SimpleOAuthProvider(PKG).tokens();
    expect(tokens).not.toHaveProperty(RENEWAL_HELD_FIELD);
    expect(tokens).not.toHaveProperty(OBTAINED_AT_FIELD);
  });
});

describe("paused text", () => {
  it("is shown only for a held file with no reconnect marker, named with SUPER_MCP_APP_NAME", async () => {
    process.env.SUPER_MCP_APP_NAME = "Acme";
    const refreshOnly = new RefreshOnlyOAuthProvider(new SimpleOAuthProvider(PKG));
    const url = new URL("https://auth.example.test/authorize");

    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, -1000), [RENEWAL_HELD_FIELD]: true });
    await expect(refreshOnly.redirectToAuthorization(url)).rejects.toThrow(
      `${PKG} is paused until Acme can renew its sign-in. It will resume automatically, with no need to reconnect.`,
    );

    await writeJson(markerPath(), { needs_reconnect: true });
    await expect(refreshOnly.redirectToAuthorization(url)).rejects.toThrow(/Authentication required/);

    await fs.rm(markerPath());
    await writeJson(tokenPath(), tokensWithRemaining(undefined, -1000));
    await expect(refreshOnly.redirectToAuthorization(url)).rejects.toThrow(/Authentication required/);
  });
});

describe("hold, resume, cache, install, remove", () => {
  it("hold sets the field; resume removes it only while the refresh token is there", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    expect(await runHostOp({ op: "hold", package_id: PKG }, deps())).toEqual({ status: "held" });
    expect((await readJson(tokenPath()))[RENEWAL_HELD_FIELD]).toBe(true);
    expect(await runHostOp({ op: "resume", package_id: PKG }, deps())).toEqual({ status: "resumed" });
    expect(await readJson(tokenPath())).not.toHaveProperty(RENEWAL_HELD_FIELD);

    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true });
    expect(await runHostOp({ op: "resume", package_id: PKG }, deps())).toEqual({ status: "no_refresh_token" });
    expect((await readJson(tokenPath()))[RENEWAL_HELD_FIELD]).toBe(true);

    expect(await runHostOp({ op: "hold", package_id: "Absent" }, deps())).toEqual({ status: "missing" });
    expect(await exists(tokenPath("Absent"))).toBe(false);
  });

  it("cache writes an access-only held file and clears the marker, but never drops a refresh token", async () => {
    const access = { access_token: "access-borrowed", token_type: "Bearer", expires_in: 1800 };
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    expect(await runHostOp({ op: "cache", package_id: PKG, access }, deps())).toEqual({
      status: "refused",
      reason: "holds_refresh_token",
    });

    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, -1000), [RENEWAL_HELD_FIELD]: true });
    await writeJson(markerPath(), { needs_reconnect: true });
    expect(await runHostOp({ op: "cache", package_id: PKG, access }, deps())).toEqual({ status: "cached" });
    const disk = await readJson(tokenPath());
    expect(disk).toMatchObject({ ...access, [RENEWAL_HELD_FIELD]: true });
    expect(disk.refresh_token).toBeUndefined();
    expect(typeof disk[OBTAINED_AT_FIELD]).toBe("number");
    expect(await exists(markerPath())).toBe(false);
  });

  it("install writes client then tokens without the held field, clears the marker and restarts", async () => {
    const onCredentialsChanged = vi.fn(async () => {});
    await writeJson(markerPath(), { needs_reconnect: true });
    const result = await runHostOp(
      {
        op: "install",
        package_id: PKG,
        tokens: { access_token: "access-i", token_type: "Bearer", refresh_token: "refresh-i", [RENEWAL_HELD_FIELD]: true },
        client: { client_id: "public-client" },
      },
      deps({ onCredentialsChanged }),
    );
    expect(result).toEqual({ status: "installed" });
    expect(await readJson(tokenPath())).toEqual({ access_token: "access-i", token_type: "Bearer", refresh_token: "refresh-i" });
    expect(await readJson(clientPath())).toEqual({ client_id: "public-client" });
    expect(await exists(markerPath())).toBe(false);
    expect(onCredentialsChanged).toHaveBeenCalledWith(PKG);
  });

  it("remove deletes tokens, client and marker", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    await writeJson(clientPath(), { client_id: "public-client" });
    await writeJson(markerPath(), { needs_reconnect: true });
    expect(await runHostOp({ op: "remove", package_id: PKG }, deps())).toEqual({ status: "removed" });
    for (const p of [tokenPath(), clientPath(), markerPath()]) expect(await exists(p)).toBe(false);
  });
});

describe("export", () => {
  it("writes the pending bundle, then leaves the token file access-only and held; a repeat is idempotent", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    await writeJson(clientPath(), { client_id: "public-client" });

    expect(await runHostOp({ op: "export", package_id: PKG, discard: false }, deps())).toEqual({ status: "exported" });
    const pending = await readJson(path.join(exportDir, `${PKG}.json`));
    expect(pending).toMatchObject({ version: 1, package_id: PKG, client: { client_id: "public-client" } });
    expect(pending.tokens.refresh_token).toBe("refresh-r0");
    expect(pending.tokens).not.toHaveProperty(RENEWAL_HELD_FIELD);
    const disk = await readJson(tokenPath());
    expect(disk.refresh_token).toBeUndefined();
    expect(disk[RENEWAL_HELD_FIELD]).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(exportDir, `${PKG}.json`))).mode & 0o777).toBe(0o600);
    }

    expect(await runHostOp({ op: "export", package_id: PKG, discard: false }, deps())).toEqual({
      status: "exported",
      repeat: true,
    });
  });

  it("discard strips only, with no pending bundle", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    expect(await runHostOp({ op: "export", package_id: PKG, discard: true }, deps())).toEqual({ status: "discarded" });
    expect((await readJson(tokenPath())).refresh_token).toBeUndefined();
    expect(await exists(path.join(exportDir, `${PKG}.json`))).toBe(false);
  });

  it("a crash between the pending write and the strip leaves the file held and the bundle present", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r0", 600_000), [RENEWAL_HELD_FIELD]: true });
    const realWrite = SimpleOAuthProvider.prototype.atomicWriteTokens;
    const strip = vi
      .spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens")
      .mockImplementation(async function (this: SimpleOAuthProvider, data: any, target?: string) {
        if (target === undefined) throw new Error("simulated crash"); // the token-file strip
        return realWrite.call(this, data, target);
      });
    await expect(runHostOp({ op: "export", package_id: PKG, discard: false }, deps())).rejects.toThrow("simulated crash");
    strip.mockRestore();

    const disk = await readJson(tokenPath());
    expect(disk[RENEWAL_HELD_FIELD]).toBe(true);
    expect((await readJson(path.join(exportDir, `${PKG}.json`))).tokens.refresh_token).toBe("refresh-r0");

    expect(await runHostOp({ op: "export", package_id: PKG, discard: false }, deps())).toEqual({ status: "exported" });
    expect((await readJson(tokenPath())).refresh_token).toBeUndefined();
  });

  it("waits for a second real lock holder on the same path and exports what it persisted", async () => {
    await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r0", 600_000), [RENEWAL_HELD_FIELD]: true });
    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const entered = new Promise<void>((resolve) => (holderEntered = resolve));
    // A different package id bypasses the in-process mutex, so this contends on
    // the on-disk proper-lockfile exactly as a peer process would.
    const holder = withTokenRefreshLock("peer-holder", tokenPath(), async () => {
      holderEntered();
      await new Promise<void>((resolve) => (releaseHolder = resolve));
      await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r1", 600_000), [RENEWAL_HELD_FIELD]: true });
    });
    await entered;

    let exportDone = false;
    const exporting = runHostOp({ op: "export", package_id: PKG, discard: false }, deps()).then((r) => {
      exportDone = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exportDone).toBe(false);

    releaseHolder();
    await holder;
    expect(await exporting).toEqual({ status: "exported" });
    expect((await readJson(path.join(exportDir, `${PKG}.json`))).tokens.refresh_token).toBe("refresh-r1");
    expect((await readJson(tokenPath())).refresh_token).toBeUndefined();
  }, 20_000);
});

describe("refresh (owner side, no MCP connection)", () => {
  async function seedOwner(remainingMs: number, refreshToken = "refresh-r0"): Promise<void> {
    await writeJson(tokenPath(), tokensWithRemaining(refreshToken, remainingMs));
    await writeJson(clientPath(), { client_id: "public-client", redirect_uris: ["http://localhost:5173/oauth/callback"] });
  }

  it("renews below min_remaining_ms and completes (the op takes no outer lock)", async () => {
    await seedOwner(30 * 60_000);
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const result = await runHostOp(
      { op: "refresh", package_id: PKG, min_remaining_ms: 60 * 60_000 },
      deps({ baseFetch: sdkNetwork(endpoint) }),
    );
    expect(result.status).toBe("fresh");
    expect(result.remaining_ms as number).toBeGreaterThan(59 * 60_000);
    expect(result).not.toHaveProperty("access_token");
    expect(endpoint.callCount()).toBe(1);
    expect((await readJson(tokenPath())).refresh_token).toBe(endpoint.currentValidRefreshToken());
  }, 5_000);

  it("short-circuits when enough life is left", async () => {
    await seedOwner(30 * 60_000);
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const result = await runHostOp(
      { op: "refresh", package_id: PKG, min_remaining_ms: 10 * 60_000 },
      deps({ baseFetch: sdkNetwork(endpoint) }),
    );
    expect(result.status).toBe("fresh");
    expect(endpoint.callCount()).toBe(0);
  });

  it("a dead grant is needs_reconnect, with the owner's own marker", async () => {
    await seedOwner(-1000);
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    endpoint.revokeGrant();
    const result = await runHostOp(
      { op: "refresh", package_id: PKG, min_remaining_ms: 0 },
      deps({ baseFetch: sdkNetwork(endpoint) }),
    );
    expect(result).toEqual({ status: "needs_reconnect" });
    expect(await exists(markerPath())).toBe(true);
  }, 10_000);

  it("an unreachable provider is unavailable and keeps the refresh token and a legacy marker", async () => {
    await seedOwner(-1000);
    await writeJson(markerPath(), { needs_reconnect: true });
    const offline = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth-protected-resource")) return new Response("", { status: 404 });
      if (String(input).includes("oauth-authorization-server")) {
        return new Response(JSON.stringify(metadata()), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await runHostOp({ op: "refresh", package_id: PKG, min_remaining_ms: 0 }, deps({ baseFetch: offline }));
    expect(result).toEqual({ status: "unavailable", reason: "provider_unreachable" });
    expect((await readJson(tokenPath())).refresh_token).toBe("refresh-r0");
    expect(await exists(markerPath())).toBe(true);
  });

  it("a provider error is unavailable with provider_error", async () => {
    await seedOwner(-1000);
    const failing = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const network = sdkNetwork(failing);
    const serverError = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === TOKEN_URL
        ? new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "Content-Type": "application/json" } })
        : network(input, init)) as typeof fetch;
    const result = await runHostOp({ op: "refresh", package_id: PKG, min_remaining_ms: 0 }, deps({ baseFetch: serverError }));
    expect(result).toEqual({ status: "unavailable", reason: "provider_error" });
  });

  it("is setup_required without package config, and needs_reconnect without anything to renew with", async () => {
    expect(await runHostOp({ op: "refresh", package_id: "Unconfigured", min_remaining_ms: 0 }, deps())).toEqual({
      status: "setup_required",
    });
    await writeJson(tokenPath(), tokensWithRemaining(undefined, -1000));
    expect(await runHostOp({ op: "refresh", package_id: PKG, min_remaining_ms: 0 }, deps())).toEqual({
      status: "needs_reconnect",
    });
  });
});

describe("POST /api/oauth/host", () => {
  async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express();
    const dnsRebindingGuard: express.RequestHandler = (req, res, next) => {
      const host = req.headers.host?.split(":")[0]?.toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1") {
        res.status(403).json({ error: "Forbidden - invalid host" });
        return;
      }
      next();
    };
    app.use(express.json());
    const registry = {
      getPackage: (id: string) => (id === PKG ? oauthPackage() : undefined),
      getPackages: () => [oauthPackage()],
      getSkippedPackages: () => [],
      restartPackage: vi.fn(async () => ({ success: true, message: "" })),
    } as unknown as PackageRegistry;
    const catalog = { clearPackage: vi.fn() } as unknown as Catalog;
    registerHttpApiRoutes(app, { registry, catalog, dnsRebindingGuard });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/api/oauth/host`, close: () => new Promise((r) => server.close(() => r())) };
  }

  it("accepts JSON only and validates the op", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    const app = await startApp();
    try {
      const asForm = await fetch(app.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ op: "hold", package_id: PKG }),
      });
      expect(asForm.status).toBe(415);
      expect(await readJson(tokenPath())).not.toHaveProperty(RENEWAL_HELD_FIELD);

      const bad = await fetch(app.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "hold", package_id: "../escape" }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(app.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "hold", package_id: PKG }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "held" });
    } finally {
      await app.close();
    }
  });
});

describe("startup hold and standalone use", () => {
  it("SUPER_MCP_HOLD_RENEWAL holds each listed package and skips bad or absent ids", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    await applyStartupRenewalHold({ SUPER_MCP_HOLD_RENEWAL: ` ${PKG} ,../bad, Absent` });
    expect((await readJson(tokenPath()))[RENEWAL_HELD_FIELD]).toBe(true);
    expect(await exists(tokenPath("Absent"))).toBe(false);
  });

  it("without the environment nothing is held and a normal refresh rotates as before", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
    const before = await fs.readFile(tokenPath(), "utf8");
    await applyStartupRenewalHold({});
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(before);

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const provider = new SimpleOAuthProvider(PKG);
    const wrapped = createResponseNormalizingFetch(endpoint.fetch, undefined, provider);
    const fresh = await refreshAuthorization(metadata().issuer, {
      metadata: metadata(),
      clientInformation: { client_id: "public-client" } as any,
      refreshToken: "refresh-r0",
      fetchFn: wrapped,
    });
    await provider.saveTokens(fresh);
    const disk = await readJson(tokenPath());
    expect(endpoint.callCount()).toBe(1);
    expect(disk.refresh_token).toBe(endpoint.currentValidRefreshToken());
    expect(disk).not.toHaveProperty(RENEWAL_HELD_FIELD);
  });
});
