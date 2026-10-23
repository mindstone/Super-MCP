import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { auth, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
import { SimpleOAuthProvider, RENEWAL_HELD_FIELD, OBTAINED_AT_FIELD } from "../src/auth/providers/simple.js";
import { RefreshOnlyOAuthProvider } from "../src/auth/providers/refreshOnly.js";
import { withTokenRefreshLock } from "../src/auth/tokenRefreshLock.js";
import { handleHostOpRequest } from "../src/auth/hostOps.js";
import {
  prepareHostGrants,
  validateHostGrantsDirectory,
  buildRenewalSpec,
  pullHostAccess,
  accessTokenHash,
} from "../src/auth/hostGrants.js";
import { registerHttpApiRoutes } from "../src/server.js";
import type { PackageConfig } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import { createMockTokenEndpoint, type MockTokenEndpointHandle } from "./helpers/mockTokenEndpoint.js";

// Synthetic fixtures for host-managed OAuth grants.

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
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

function oauthPackage(): PackageConfig {
  return {
    id: PKG,
    name: PKG,
    transport: "http",
    base_url: BASE_URL,
    oauth: true,
    visibility: "default",
  } as PackageConfig;
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

function metadata(tokenUrl = TOKEN_URL): AuthorizationServerMetadata {
  return {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: tokenUrl,
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  } as AuthorizationServerMetadata;
}

/** Network for SDK auth(): no protected-resource metadata, AS metadata, token endpoint. */
function sdkNetwork(endpoint: Pick<MockTokenEndpointHandle, "fetch">, tokenUrl = TOKEN_URL): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("oauth-protected-resource")) return new Response("not found", { status: 404 });
    if (url.includes("oauth-authorization-server")) {
      return new Response(JSON.stringify(metadata(tokenUrl)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === tokenUrl) return endpoint.fetch(input, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-host-ops-"));
  exportDir = path.join(tempDir, "pending");
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
  process.env.SUPER_MCP_HOST_GRANTS_DIR = exportDir;
  process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
  await fs.mkdir(exportDir, { mode: 0o700 });
  await writeJson(process.env.MCP_HOST_BRIDGE_STATE, { port: 12345, token: "bridge-secret-sentinel" });
  delete process.env.SUPER_MCP_APP_NAME;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("a held file with valid access gets no synthesized 200 and keeps its marker", async () => {
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    await writeJson(tokenPath(), {
      ...tokensWithRemaining(undefined, 10 * 60_000),
      [RENEWAL_HELD_FIELD]: true,
    });
    await writeJson(markerPath(), { needs_reconnect: true, error: "owner_ended" });
    const provider = new SimpleOAuthProvider(PKG);
    const wrapped = createResponseNormalizingFetch(endpoint.fetch, undefined, provider);
    let status: number | undefined;
    const observing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wrapped(input, init);
      status = response.status;
      return response;
    }) as typeof fetch;
    await expect(
      refreshAuthorization(metadata().issuer, {
        metadata: metadata(),
        clientInformation: { client_id: "public-client" } as any,
        refreshToken: "refresh-stale",
        fetchFn: observing,
      }),
    ).rejects.toThrow(/is paused until/);
    expect(status).toBe(503);
    expect(endpoint.callCount()).toBe(0);
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true, error: "owner_ended" });
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

  it("a held file never exposes its refresh token to the SDK, even when the token endpoint path has no 'token'", async () => {
    const RENEW_URL = "https://auth.example.test/renew";
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0", tokenUrl: RENEW_URL });

    await writeJson(tokenPath(), { ...tokensWithRemaining("refresh-r0", -1000), [RENEWAL_HELD_FIELD]: true });
    await writeJson(clientPath(), { client_id: "public-client" });
    const provider = new SimpleOAuthProvider(PKG);
    provider.setHostGrantConfig(oauthPackage());
    await provider.initialize();
    vi.stubGlobal("fetch", sdkNetwork(endpoint, RENEW_URL));
    expect(await provider.tokens()).toBeUndefined();
    const wrapped = createResponseNormalizingFetch(sdkNetwork(endpoint, RENEW_URL), undefined, provider);

    // The SDK's own auth(): with no refresh token visible it never POSTs.
    await expect(
      auth(new RefreshOnlyOAuthProvider(provider), { serverUrl: BASE_URL, fetchFn: wrapped }),
    ).rejects.toThrow(/is paused until/);
    // A stale in-memory refresh token sent to /renew is refused under the lock too.
    await expect(
      refreshAuthorization(metadata().issuer, {
        metadata: metadata(RENEW_URL),
        clientInformation: { client_id: "public-client" } as any,
        refreshToken: "refresh-r0",
        fetchFn: wrapped,
      }),
    ).rejects.toThrow(/is paused until/);
    expect(endpoint.callCount()).toBe(0);
    expect((await readJson(tokenPath())).refresh_token).toBeUndefined();
  });
});

async function configured(extra: Partial<PackageConfig> = {}) {
  const provider = new SimpleOAuthProvider(PKG);
  provider.setHostGrantConfig({ ...oauthPackage(), ...extra });
  await provider.initialize();
  return provider;
}
const fresh = (access = "access-new", expires = true) => ({
  status: "fresh",
  generation: 2,
  components: {
    default: {
      access_token: access,
      token_type: "Bearer",
      obtained_at: Date.now(),
      ...(expires ? { expires_at: Date.now() + 3_600_000 } : {}),
    },
  },
});
const pendingFiles = async () => (await fs.readdir(exportDir)).filter((name) => name.endsWith(".json"));

describe("standalone", () => {
  it.each([
    { form: "empty placeholder", content: "", expectedBearer: "Bearer access-old" },
    { form: "empty object", content: "{}", expectedBearer: "Bearer undefined" },
    { form: "deleted", content: undefined, expectedBearer: null },
  ])(
    "compares $form with a never-signed-in package at the SDK boundary",
    async ({ form, content, expectedBearer }) => {
      delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      delete process.env.MCP_HOST_BRIDGE_STATE;
      const original = tokensWithRemaining(undefined, 600_000);
      await writeJson(tokenPath(), original);
      await writeJson(clientPath(), { client_id: "public-client" });
      const provider = await configured();
      const cached = await provider.tokens();
      await withTokenRefreshLock(PKG, tokenPath(), async () => {
        if (content === undefined) await fs.unlink(tokenPath());
        else await fs.writeFile(tokenPath(), content);
      });
      expect(await exists(`${tokenPath()}.lock`)).toBe(false);
      if (form === "empty placeholder") {
        await expect(provider.readDiskTokens()).rejects.toThrow(SyntaxError);
        expect(await provider.tokens()).toEqual(cached);
      } else {
        const emptyState = form === "deleted" ? undefined : {};
        await expect(provider.readDiskTokens()).resolves.toEqual(emptyState);
        await expect(provider.tokens()).resolves.toEqual(emptyState);
      }
      const resource = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(expectedBearer);
        return new Response(null, { status: 202 });
      });
      const transport = new StreamableHTTPClientTransport(new URL(BASE_URL), {
        authProvider: provider,
        fetch: resource,
      });
      try {
        await transport.start();
        await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
      } finally {
        await transport.close();
      }
      const tokenPost = vi.fn(async () => {
        throw new Error("Unexpected token POST");
      });
      await expect(
        auth(new RefreshOnlyOAuthProvider(provider), {
          serverUrl: BASE_URL,
          fetchFn: sdkNetwork({ fetch: tokenPost }),
        }),
      ).rejects.toThrow(/Authentication required/);
      expect(tokenPost).not.toHaveBeenCalled();
      if (form === "empty placeholder") {
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "Failed to read OAuth tokens from disk; using in-memory fallback",
          expect.objectContaining({ package_id: PKG }),
        );
      } else {
        expect(mockLogger.warn).not.toHaveBeenCalled();
      }
      expect(mockLogger.error).not.toHaveBeenCalled();
    },
  );

  it.each(["both", "dir", "bridge"])(
    "refuses grant_changed without touching files or registry when %s are unset",
    async (which) => {
      if (which !== "bridge") delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      if (which !== "dir") delete process.env.MCP_HOST_BRIDGE_STATE;
      await writeJson(tokenPath(), tokensWithRemaining(undefined, 600_000));
      await writeJson(markerPath(), { needs_reconnect: true });
      const before = await fs.readFile(tokenPath());
      const marker = await fs.readFile(markerPath());
      const files = (await fs.readdir(tempDir)).sort();
      const registry = { getPackage: vi.fn(), restartPackage: vi.fn() };
      const catalog = { clearPackage: vi.fn() };
      const catalogRefresher = { scheduleRefresh: vi.fn(), whenCurrentGenerationReady: vi.fn() };
      const routes = new Map<string, Function[]>();
      const app = {
        get: vi.fn(),
        post: (route: string, ...handlers: Function[]) => routes.set(route, handlers),
      };
      registerHttpApiRoutes(app as never, {
        registry: registry as unknown as PackageRegistry,
        catalog: catalog as unknown as Catalog,
        catalogRefresher,
        dnsRebindingGuard: vi.fn(),
      });
      for (const id of [PKG, "never-connected"]) {
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await routes.get("/api/oauth/host")!.at(-1)!(
          {
            is: () => true,
            body: { op: "grant_changed", package_id: id },
          },
          res,
        );
        expect(res.status).toHaveBeenCalledWith(404);
      }
      expect(await fs.readFile(tokenPath())).toEqual(before);
      expect(await fs.readFile(markerPath())).toEqual(marker);
      expect((await fs.readdir(tempDir)).sort()).toEqual(files);
      expect(await pendingFiles()).toEqual([]);
      expect(registry.getPackage).not.toHaveBeenCalled();
      expect(registry.restartPackage).not.toHaveBeenCalled();
      expect(catalog.clearPackage).not.toHaveBeenCalled();
      expect(catalogRefresher.scheduleRefresh).not.toHaveBeenCalled();
    },
  );
  it.each(["both", "dir", "bridge"])(
    "preserves byte-identical token files when %s are unset",
    async (which) => {
      if (which !== "bridge") delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      if (which !== "dir") delete process.env.MCP_HOST_BRIDGE_STATE;
      const bytes = JSON.stringify(tokensWithRemaining("refresh-r0", 600_000), null, 4) + "\n";
      await fs.writeFile(tokenPath(), bytes);
      const network = vi.fn();
      vi.stubGlobal("fetch", network);
      await prepareHostGrants(() => oauthPackage());
      const provider = await configured();
      const tokens = await provider.tokens();
      expect(tokens).toHaveProperty("refresh_token", "refresh-r0");
      await provider.saveTokens(tokens);
      const response = Response.json({ access_token: "server-access", token_type: "Bearer" });
      const baseFetch = vi.fn(async () => response);
      const wrapped = createResponseNormalizingFetch(baseFetch, undefined, provider);
      const init = {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh-r0" }),
      };
      // origin/main forwards /renew even with a valid disk token: only /token is intercepted.
      expect(await wrapped("https://auth.example.test/renew", init)).toBe(response);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      expect(baseFetch).toHaveBeenCalledWith("https://auth.example.test/renew", init);
      expect(await fs.readFile(tokenPath(), "utf8")).toBe(bytes);
      expect(await pendingFiles()).toEqual([]);
      expect(network).not.toHaveBeenCalled();
    },
  );
  it("retains standalone SDK renewal and the original serialized token shape", async () => {
    delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
    delete process.env.MCP_HOST_BRIDGE_STATE;
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const provider = await configured();
    const result = await refreshAuthorization(metadata().issuer, {
      metadata: metadata(),
      clientInformation: { client_id: "public-client" },
      refreshToken: "refresh-r0",
      fetchFn: createResponseNormalizingFetch(endpoint.fetch, undefined, provider),
    });
    await provider.saveTokens(result);
    const stamp = (await readJson(tokenPath()))[OBTAINED_AT_FIELD];
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(
      JSON.stringify(
        {
          access_token: result.access_token,
          token_type: result.token_type,
          expires_in: result.expires_in,
          refresh_token: result.refresh_token,
          [OBTAINED_AT_FIELD]: stamp,
        },
        null,
        2,
      ),
    );
    expect(endpoint.callCount()).toBe(1);
  });
});

describe("SDK renewal metadata", () => {
  it("returns no spec without marking when client information is missing", async () => {
    const provider = await configured();
    expect(await buildRenewalSpec(provider)).toBeUndefined();
    expect(await exists(markerPath())).toBe(false);
  });

  it.each([
    ["DCR public", undefined, ["none"], "none", false, false],
    ["static basic", "secret-sentinel", ["client_secret_basic"], "client_secret_basic", false, false],
    ["static post", "secret-sentinel", ["client_secret_post"], "client_secret_post", true, false],
    ["fallback", undefined, [], "none", false, true],
  ] as const)(
    "%s matches the SDK refresh request",
    async (_name, secret, methods, method, resource, fallback) => {
      await writeJson(clientPath(), { client_id: "public-client-sentinel" });
      const network: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes("oauth-protected-resource") && resource)
          return Response.json({ resource: BASE_URL, authorization_servers: [metadata().issuer] });
        if (url.includes("oauth-authorization-server") && !fallback)
          return Response.json({ ...metadata(), token_endpoint_auth_methods_supported: methods });
        return new Response("", { status: 404 });
      };
      const p = await configured(
        secret ? { oauthClientId: "static-client-sentinel", oauthClientSecret: secret } : {},
      );
      const spec = (await buildRenewalSpec(p, network))!;
      expect(spec.auth).toBe(method);
      expect(spec.token_endpoint).toBe(fallback ? "https://mcp.example.com/token" : TOKEN_URL);
      expect(spec.params?.resource).toBe(resource ? BASE_URL : undefined);
      const endpoint = createMockTokenEndpoint({
        initialRefreshToken: "synthetic-refresh",
        tokenUrl: spec.token_endpoint,
      });
      let sent!: { url: string; headers: Headers; form: URLSearchParams };
      await refreshAuthorization(fallback ? "https://mcp.example.com" : metadata().issuer, {
        metadata: fallback
          ? undefined
          : { ...metadata(), token_endpoint_auth_methods_supported: [...methods] },
        clientInformation: { client_id: spec.client.id, ...(secret ? { client_secret: secret } : {}) },
        refreshToken: "synthetic-refresh",
        resource: resource ? new URL(BASE_URL) : undefined,
        fetchFn: async (input, init) => {
          sent = {
            url: String(input),
            headers: new Headers(init?.headers),
            form: new URLSearchParams(init?.body as URLSearchParams),
          };
          return endpoint.fetch(input, init);
        },
      });
      expect(sent.url).toBe(spec.token_endpoint);
      expect(sent.form.get("resource")).toBe(spec.params?.resource ?? null);
      if (method === "client_secret_basic") expect(sent.headers.get("authorization")).toMatch(/^Basic /);
      else expect(sent.form.get("client_id")).toBe(spec.client.id);
      if (method === "client_secret_post") expect(sent.form.get("client_secret")).toBe(secret);
    },
  );
});

describe("durable grant offers", () => {
  beforeEach(async () => {
    await writeJson(clientPath(), { client_id: "public-client-sentinel" });
    vi.stubGlobal("fetch", sdkNetwork({ fetch: vi.fn() }));
  });
  it("offers an access-only legacy file once across two startup passes, before holding it", async () => {
    await fs.unlink(clientPath());
    const before = tokensWithRemaining(undefined, 600_000);
    await writeJson(tokenPath(), before);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const actual = SimpleOAuthProvider.prototype.atomicWriteTokens;
    const writes = vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens").mockImplementation(
      async function (this: SimpleOAuthProvider, data, target, strict) {
        if (target?.startsWith(exportDir)) expect(await readJson(tokenPath())).toEqual(before);
        return actual.call(this, data, target, strict);
      },
    );
    await prepareHostGrants(() => oauthPackage());
    await prepareHostGrants(() => oauthPackage());
    expect(await pendingFiles()).toHaveLength(1);
    const [name] = await pendingFiles();
    expect(writes.mock.calls.map(([, target]) => target ?? tokenPath())).toEqual([
      path.join(exportDir, name),
      tokenPath(),
    ]);
    const offer = await readJson(path.join(exportDir, name));
    expect(offer).toMatchObject({
      version: 1,
      sourcePath: tokenPath(),
      legacy: true,
      components: {
        default: { access_token: "access-old", expires_at: before[OBTAINED_AT_FIELD] + 3_600_000 },
      },
    });
    expect(offer).not.toHaveProperty("renewal");
    expect(offer.components.default).not.toHaveProperty("refresh_token");
    expect(await readJson(tokenPath())).toEqual({ ...before, [RENEWAL_HELD_FIELD]: true });
    expect(await exists(markerPath())).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it("does not offer or rewrite a borrowed cache from a fresh pull at startup", async () => {
    const bridge = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    expect(await (await configured()).tokens()).toHaveProperty("access_token", "access-new");
    const bytes = await fs.readFile(tokenPath(), "utf8");
    const writes = vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens");
    await prepareHostGrants(() => oauthPackage());
    expect(await pendingFiles()).toEqual([]);
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(bytes);
    expect(writes).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("discovers renewal before locking and offers the grant re-read under the lock", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    const discovery = sdkNetwork({ fetch: vi.fn() });
    let updated = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!updated) {
        await withTokenRefreshLock(
          "discovery-peer",
          tokenPath(),
          async () => {
            await writeJson(tokenPath(), tokensWithRemaining("refresh-newer", 600_000));
          },
          { retries: 0 },
        );
        updated = true;
      }
      return discovery(input, init);
    });
    await prepareHostGrants(() => oauthPackage());
    expect(updated).toBe(true);
    const [name] = await pendingFiles();
    expect((await readJson(path.join(exportDir, name))).components.default.refresh_token).toBe(
      "refresh-newer",
    );
  });
  it("writes a durable offer before stripping and stores absolute expiry", async () => {
    const before = tokensWithRemaining("refresh-r0", 600_000);
    await writeJson(tokenPath(), before);
    const actual = SimpleOAuthProvider.prototype.atomicWriteTokens;
    const writes: string[] = [];
    vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens").mockImplementation(async function (
      this: SimpleOAuthProvider,
      data,
      target,
      strict,
    ) {
      await actual.call(this, data, target, strict);
      writes.push(target ?? this.getTokenFilePath());
      if (target?.startsWith(exportDir)) {
        expect(strict).toBe(true);
        expect((await readJson(tokenPath())).refresh_token).toBe("refresh-r0");
      }
    });
    await prepareHostGrants(() => oauthPackage());
    const [name] = await pendingFiles();
    expect(name).toMatch(/^[\da-f-]{36}\.json$/);
    expect(writes).toEqual([tokenPath(), path.join(exportDir, name), tokenPath()]);
    expect(await readJson(path.join(exportDir, name))).toMatchObject({
      version: 1,
      sourcePath: tokenPath(),
      legacy: true,
      components: {
        default: { refresh_token: "refresh-r0", expires_at: before[OBTAINED_AT_FIELD] + 3_600_000 },
      },
      renewal: { token_endpoint: TOKEN_URL },
    });
    expect(await readJson(tokenPath())).not.toHaveProperty("refresh_token");
    if (process.platform !== "win32")
      expect((await fs.stat(path.join(exportDir, name))).mode & 0o777).toBe(0o600);
  });
  it("recovers a crash after pending fsync but before strip", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    const actual = SimpleOAuthProvider.prototype.atomicWriteTokens;
    const spy = vi
      .spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens")
      .mockImplementation(async function (this: SimpleOAuthProvider, data, target, strict) {
        if (!target && !data.refresh_token) throw new Error("simulated crash");
        return actual.call(this, data, target, strict);
      });
    await expect(prepareHostGrants(() => oauthPackage())).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith("Host grant preparation deferred", {
      package_id: PKG,
      code: "host_grant_prepare_failed",
    });
    expect(await pendingFiles()).toHaveLength(1);
    expect(await readJson(tokenPath())).toMatchObject({
      refresh_token: "refresh-r0",
      [RENEWAL_HELD_FIELD]: true,
    });
    spy.mockRestore();
    await prepareHostGrants(() => oauthPackage());
    expect(await readJson(tokenPath())).not.toHaveProperty("refresh_token");
    const offers = await Promise.all(
      (await pendingFiles()).map((name) => readJson(path.join(exportDir, name))),
    );
    expect(offers).toHaveLength(2);
    expect(offers[0]).toEqual(offers[1]);
    // The host treats a repeat legacy offer as stale.
    await prepareHostGrants(() => oauthPackage());
    expect(await pendingFiles()).toHaveLength(2);
  });
  it.each([false, true])("re-reads after another real lock holder (borrowed=%s)", async (borrowed) => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    let unlock!: () => void;
    let entered!: () => void;
    const parked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holding = withTokenRefreshLock("peer-lock-key", tokenPath(), async () => {
      entered();
      await release;
      await writeJson(
        tokenPath(),
        borrowed
          ? { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true }
          : tokensWithRemaining("refresh-newer", 600_000),
      );
    });
    await parked;
    const writes = vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens");
    const preparing = prepareHostGrants(() => oauthPackage());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await pendingFiles()).toEqual([]);
    unlock();
    await holding;
    await preparing;
    if (borrowed) {
      expect(await pendingFiles()).toEqual([]);
      expect(writes).not.toHaveBeenCalled();
      return;
    }
    const [name] = await pendingFiles();
    expect((await readJson(path.join(exportDir, name))).components.default.refresh_token).toBe(
      "refresh-newer",
    );
  });
  it("holds metadata failures and retries on the next pull", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
    await prepareHostGrants(() => undefined);
    expect(await pendingFiles()).toEqual([]);
    const network = sdkNetwork({ fetch: vi.fn() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/oauth/access") ? Response.json(fresh()) : network(input, init),
    );
    expect(await (await configured()).tokens()).toHaveProperty("access_token", "access-new");
    expect(await pendingFiles()).toHaveLength(1);
  });
  it("marks missing client info without making an offer", async () => {
    await fs.unlink(clientPath());
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    await prepareHostGrants(() => oauthPackage());
    expect(await pendingFiles()).toEqual([]);
    expect(await readJson(markerPath())).toMatchObject({ needs_reconnect: true });
    expect(await readJson(tokenPath())).toHaveProperty("refresh_token", "refresh-r0");
  });
  it("marks a new sign-in when client information is missing", async () => {
    await fs.unlink(clientPath());
    const provider = await configured();
    (provider as any).redirectStarted = true;
    await expect(provider.saveTokens(tokensWithRemaining("refresh-new", 600_000))).rejects.toThrow(
      /could not save/,
    );
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    expect(await pendingFiles()).toEqual([]);
  });
  it("offers a new sign-in then keeps only held access and refuses delayed refresh echoes", async () => {
    const p = await configured();
    (p as any).redirectStarted = true;
    await p.saveTokens({
      ...tokensWithRemaining("refresh-new-grant", 600_000),
      id_token: "identity-token-sentinel",
      client_secret: "secret-sentinel",
    });
    const [name] = await pendingFiles();
    expect((await readJson(path.join(exportDir, name))).legacy).toBe(false);
    expect(await readJson(tokenPath())).toMatchObject({ [RENEWAL_HELD_FIELD]: true });
    expect(await readJson(tokenPath())).not.toHaveProperty("id_token");
    expect(await readJson(tokenPath())).not.toHaveProperty("client_secret");
    const before = await fs.readFile(tokenPath(), "utf8");
    await p.saveTokens({ access_token: "late-access", refresh_token: "late-refresh", token_type: "Bearer" });
    expect((p as any).redirectStarted).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      "Could not read existing tokens before save; merging against in-memory state",
      expect.anything(),
    );
    expect(await readJson(tokenPath())).not.toHaveProperty("refresh_token");
    expect(await pendingFiles()).toHaveLength(1);
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(before);
  });
});

describe("pulls and resource invalidation", () => {
  it.each(["fresh", "unavailable", "missing"])(
    "handles a corrupt cache with a %s host response",
    async (status) => {
      await fs.writeFile(tokenPath(), "{corrupt");
      const bridge = vi.fn(async () =>
        Response.json(
          status === "fresh"
            ? fresh()
            : status === "missing"
              ? { status, bootstrapAllowed: true }
              : { status, reason: "offline" },
        ),
      );
      vi.stubGlobal("fetch", bridge);
      const provider = await configured();
      if (status === "fresh") {
        expect(await provider.tokens()).toHaveProperty("access_token", "access-new");
        expect(await readJson(tokenPath())).toMatchObject({
          access_token: "access-new",
          [RENEWAL_HELD_FIELD]: true,
        });
        expect(await provider.tokens()).toHaveProperty("access_token", "access-new");
      } else {
        expect(await provider.tokens()).toBeUndefined();
        await expect(
          new RefreshOnlyOAuthProvider(provider).redirectToAuthorization(new URL(BASE_URL)),
        ).rejects.toThrow(status === "missing" ? /Authentication required/ : /paused until/);
      }
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith("Host grant preparation deferred", {
        package_id: PKG,
        error_name: "SyntaxError",
      });
    },
  );

  it("marks an expired unheld access-only file missing from the host for sign-in", async () => {
    await writeJson(tokenPath(), tokensWithRemaining(undefined, -1000));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "missing", bootstrapAllowed: true })),
    );
    const provider = await configured();
    expect(await provider.tokens()).toBeUndefined();
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    await expect(
      new RefreshOnlyOAuthProvider(provider).redirectToAuthorization(new URL(BASE_URL)),
    ).rejects.toThrow(/Authentication required/);
  });
  it("an absent file pulls then enables the client's refresh-only provider", async () => {
    const bridge = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(fresh()));
    const resource = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-new");
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(init.body as string);
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "mock", version: "1" },
        },
      });
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/oauth/access") ? bridge(input, init) : resource(input, init),
    );
    const { HttpMcpClient } = await import("../src/clients/httpClient.js");
    const client = new HttpMcpClient(PKG, oauthPackage());
    await client.connect();
    expect((client as any).isConnected).toBe(true);
    expect(JSON.parse(bridge.mock.calls[0][1]!.body as string)).toEqual({ source: tokenPath() });
    expect(resource).toHaveBeenCalled();
    expect(await (await configured()).tokens()).toMatchObject({ access_token: "access-new" });
    expect(bridge).toHaveBeenCalledTimes(1);
    await client.close();
    expect(Object.keys(await readJson(tokenPath())).sort()).toEqual(
      ["access_token", "token_type", OBTAINED_AT_FIELD, "expires_in", RENEWAL_HELD_FIELD].sort(),
    );
  });
  it("single-flights pulls per source", async () => {
    const network = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json(fresh());
    });
    vi.stubGlobal("fetch", network);
    const p = await configured();
    await Promise.all([p.tokens(), p.tokens(), (await configured()).tokens()]);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "unavailable"])("serves unexpired cache on %s, then pauses", async (status) => {
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 60_000), [RENEWAL_HELD_FIELD]: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          status === "missing" ? { status, bootstrapAllowed: true } : { status, reason: "provider_error" },
        ),
      ),
    );
    const p = await configured();
    expect(await p.tokens()).toHaveProperty("access_token", "access-old");
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, -1000), [RENEWAL_HELD_FIELD]: true });
    expect(await p.tokens()).toBeUndefined();
    await expect(new RefreshOnlyOAuthProvider(p).redirectToAuthorization(new URL(BASE_URL))).rejects.toThrow(
      /paused until/,
    );
  });
  it.each(["needs_reconnect", "disconnected"])(
    "marks %s and does not serve that cache again",
    async (status) => {
      await writeJson(tokenPath(), tokensWithRemaining(undefined, 60_000));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ status, generation: 2 })),
      );
      const p = await configured();
      expect(await p.tokens()).toBeUndefined();
      expect(await readJson(markerPath())).toMatchObject({ needs_reconnect: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ status: "unavailable", reason: "provider_error" })),
      );
      expect(await p.tokens()).toBeUndefined();
    },
  );
  it.each([
    ["POST", true],
    ["GET", false],
  ] as const)("retries %s once for a 401 with expiry=%s", async (method, expiry) => {
    await writeJson(tokenPath(), {
      access_token: "access-old",
      token_type: "Bearer",
      [OBTAINED_AT_FIELD]: Date.now(),
      ...(expiry ? { expires_in: 3600 } : {}),
    });
    const bridge = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    const resource = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer access-new"
        ? new Response("ok")
        : new Response("", { status: 401 }),
    );
    const request = createResponseNormalizingFetch(resource, undefined, await configured());
    expect(
      (
        await request(BASE_URL, {
          method,
          headers: { Authorization: "Bearer access-old" },
          ...(method === "POST" ? { body: "{}" } : {}),
        })
      ).status,
    ).toBe(200);
    expect(resource).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bridge.mock.calls[0][1]!.body as string)).toEqual({
      source: tokenPath(),
      invalidate: accessTokenHash("access-old"),
    });
  });
  it("returns a second 401 and uses paused wording without another resource retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(fresh())),
    );
    const resource = vi.fn(async () => new Response("", { status: 401 }));
    const p = await configured();
    expect(
      (
        await createResponseNormalizingFetch(
          resource,
          undefined,
          p,
        )(BASE_URL, { headers: { Authorization: "Bearer access-old" } })
      ).status,
    ).toBe(401);
    expect(resource).toHaveBeenCalledTimes(2);
    await expect(new RefreshOnlyOAuthProvider(p).redirectToAuthorization(new URL(BASE_URL))).rejects.toThrow(
      /paused/,
    );
  });
  it("retries a resource whose configured path contains token", async () => {
    const url = "https://mcp.example.com/tokens/mcp";
    const bridge = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    const resource = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer access-new"
        ? new Response("ok")
        : new Response("", { status: 401 }),
    );
    const wrapped = createResponseNormalizingFetch(resource, undefined, await configured({ base_url: url }));
    expect((await wrapped(url, { headers: { Authorization: "Bearer access-old" } })).status).toBe(200);
    expect(resource).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bridge.mock.calls[0][1]!.body as string)).toEqual({
      source: tokenPath(),
      invalidate: accessTokenHash("access-old"),
    });
  });
  it("never serves an invalidated cache on outage, and never logs credential sentinels", async () => {
    await writeJson(tokenPath(), {
      ...tokensWithRemaining(undefined, 600_000),
      access_token: "access-secret-sentinel",
    });
    await writeJson(clientPath(), { client_id: "client-secret-sentinel" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("raw-secret jane@example.com grant-secret-sentinel");
      }),
    );
    const p = await configured({ oauthClientId: "id-secret-sentinel", oauthClientSecret: "secret-sentinel" });
    expect(await pullHostAccess(p, accessTokenHash("access-secret-sentinel"))).toBeUndefined();
    await buildRenewalSpec(p).catch(() => undefined);
    await new SimpleOAuthProvider("public-package", 5173, {
      clientId: "id-secret-sentinel",
      clientSecret: "secret-sentinel",
    }).initialize();
    const logs = JSON.stringify(Object.values(mockLogger).flatMap((fn) => fn.mock.calls));
    for (const value of [
      "access-secret-sentinel",
      "bridge-secret-sentinel",
      "client-secret-sentinel",
      "id-secret-sentinel",
      "secret-sentinel",
      "jane@example.com",
      "grant-secret-sentinel",
      "raw-secret",
    ])
      expect(logs).not.toContain(value);
  });
  it("host mode refuses refresh even if a file was never held", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const p = await configured();
    await expect(
      refreshAuthorization(metadata().issuer, {
        metadata: metadata(),
        clientInformation: { client_id: "public-client" },
        refreshToken: "refresh-r0",
        fetchFn: createResponseNormalizingFetch(endpoint.fetch, undefined, p),
      }),
    ).rejects.toThrow(/paused/);
    expect(endpoint.callCount()).toBe(0);
    await p.clearTokensAndMarkNeedsReconnect({ error: "invalid_grant" });
    await p.invalidateTokensRefreshOnly();
    expect((await readJson(tokenPath())).refresh_token).toBe("refresh-r0");
  });
});

describe("replacement host operations", () => {
  it.each([false, true])(
    "grant_changed evicts access before restarting and pulling (held=%s)",
    async (held) => {
      await writeJson(tokenPath(), {
        access_token: "previous-account",
        token_type: "Bearer",
        ...(held ? { [RENEWAL_HELD_FIELD]: true } : {}),
      });
      const bridge = vi.fn(async () => Response.json(fresh()));
      vi.stubGlobal("fetch", bridge);
      const restart = vi.fn(async () => {
        expect(await readJson(tokenPath())).toEqual({ [RENEWAL_HELD_FIELD]: true });
        expect(await (await configured()).tokens()).toHaveProperty("access_token", "access-new");
      });
      expect(
        (
          await handleHostOpRequest(
            { op: "grant_changed", package_id: PKG },
            {
              onCredentialsChanged: restart,
            },
          )
        ).httpStatus,
      ).toBe(200);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledWith(PKG);
      expect(bridge).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])("grant_changed preserves local renewal (held=%s)", async (held) => {
    const disk = {
      ...tokensWithRemaining("local-refresh", 600_000),
      ...(held ? { [RENEWAL_HELD_FIELD]: true } : {}),
    };
    await writeJson(tokenPath(), disk);
    const bytes = await fs.readFile(tokenPath(), "utf8");
    await handleHostOpRequest({ op: "grant_changed", package_id: PKG }, {});
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(bytes);
  });

  it("grant_changed clears a marker and restarts the package", async () => {
    await writeJson(markerPath(), { needs_reconnect: true });
    const restart = vi.fn(async () => {});
    expect(
      (await handleHostOpRequest({ op: "grant_changed", package_id: PKG }, { onCredentialsChanged: restart }))
        .httpStatus,
    ).toBe(200);
    expect(restart).toHaveBeenCalledWith(PKG);
    expect(await exists(markerPath())).toBe(false);
  });
  it.each([
    [false, undefined], [true, undefined], [false, "local-refresh"], [true, "local-refresh"],
  ] as const)(
    "release_all only releases held files (host=%s, refresh=%s)",
    async (host, refreshToken) => {
      if (!host) {
        delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
        delete process.env.MCP_HOST_BRIDGE_STATE;
      }
      const held = { ...tokensWithRemaining(refreshToken, 600_000), [RENEWAL_HELD_FIELD]: true };
      await writeJson(tokenPath(), held);
      const other = path.join(tempDir, "other_tokens.json");
      await writeJson(other, { access_token: "other", token_type: "Bearer" });
      const before = await fs.readFile(other, "utf8");
      expect((await handleHostOpRequest({ op: "release_all" }, {})).body.status).toBe("released");
      expect((await readJson(markerPath())).needs_reconnect).toBe(true);
      if (refreshToken) {
        const { [RENEWAL_HELD_FIELD]: _held, ...unheld } = held;
        expect(await readJson(tokenPath())).toEqual(unheld);
      } else {
        expect(await exists(tokenPath())).toBe(false);
      }
      expect(await fs.readFile(other, "utf8")).toBe(before);
    },
  );

  it("never re-offers a borrowed cache after standalone release and host-mode startup", async () => {
    await writeJson(clientPath(), { client_id: "public-client" });
    const bridge = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    const provider = await configured();
    expect(await provider.tokens()).toHaveProperty("access_token", "access-new");
    expect(await readJson(tokenPath())).toHaveProperty(RENEWAL_HELD_FIELD, true);
    const grantsDir = process.env.SUPER_MCP_HOST_GRANTS_DIR;
    const bridgeState = process.env.MCP_HOST_BRIDGE_STATE;
    delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
    delete process.env.MCP_HOST_BRIDGE_STATE;
    expect(await handleHostOpRequest({ op: "release_all" }, {})).toEqual({
      httpStatus: 200,
      body: { status: "released", skipped: 0 },
    });
    expect(await exists(tokenPath())).toBe(false);
    expect(await exists(`${tokenPath()}.lock`)).toBe(false);
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    await expect(provider.readDiskTokens()).resolves.toBeUndefined();
    await expect(provider.tokens()).resolves.toBeUndefined();
    const standalone = await configured();
    await expect(standalone.tokens()).resolves.toBeUndefined();
    const tokenPost = vi.fn(async () => {
      throw new Error("Unexpected token POST");
    });
    await expect(
      auth(new RefreshOnlyOAuthProvider(standalone), {
        serverUrl: BASE_URL,
        fetchFn: sdkNetwork({ fetch: tokenPost }),
      }),
    ).rejects.toThrow(/Authentication required/);
    expect(tokenPost).not.toHaveBeenCalled();
    process.env.SUPER_MCP_HOST_GRANTS_DIR = grantsDir;
    process.env.MCP_HOST_BRIDGE_STATE = bridgeState;
    const writes = vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens");
    await prepareHostGrants(() => oauthPackage());
    expect(await pendingFiles()).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(await exists(tokenPath())).toBe(false);
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
  it.each([false, true])("release_all removes a grant_changed lock placeholder (host=%s)", async (host) => {
    const absent = "A-placeholder";
    expect((await handleHostOpRequest({ op: "grant_changed", package_id: absent }, {})).httpStatus).toBe(200);
    expect(await fs.readFile(tokenPath(absent), "utf8")).toBe("");
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true });
    if (!host) {
      delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      delete process.env.MCP_HOST_BRIDGE_STATE;
      await expect(new SimpleOAuthProvider(absent).readDiskTokens()).rejects.toThrow(SyntaxError);
    }
    expect(await handleHostOpRequest({ op: "release_all" }, {})).toEqual({
      httpStatus: 200,
      body: { status: "released", skipped: 0 },
    });
    expect(await exists(tokenPath(absent))).toBe(false);
    expect(await exists(markerPath(absent))).toBe(false);
    expect(await exists(tokenPath())).toBe(false);
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
  });

  it.each([false, true])("release_all skips a corrupt file and releases later files (host=%s)", async (host) => {
    const corrupt = "A-corrupt";
    await fs.writeFile(tokenPath(corrupt), "{corrupt-secret-sentinel");
    await writeJson(tokenPath(), { ...tokensWithRemaining(undefined, 600_000), [RENEWAL_HELD_FIELD]: true });
    if (!host) {
      delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      delete process.env.MCP_HOST_BRIDGE_STATE;
    }
    expect(await handleHostOpRequest({ op: "release_all" }, {})).toEqual({
      httpStatus: 200,
      body: { status: "released", skipped: 1 },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith("Host grant release deferred", {
      package_id: corrupt,
      code: "host_grant_release_failed",
      error_name: "SyntaxError",
    });
    expect(await fs.readFile(tokenPath(corrupt), "utf8")).toBe("{corrupt-secret-sentinel");
    expect(await exists(tokenPath())).toBe(false);
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    expect(JSON.stringify(Object.values(mockLogger).flatMap((fn) => fn.mock.calls))).not.toContain(
      "corrupt-secret-sentinel",
    );
  });
  it("rejects deleted operations, unsafe ids and non-JSON route requests", async () => {
    for (const op of ["refresh", "install", "cache", "remove", "hold", "resume", "export"])
      expect((await handleHostOpRequest({ op, package_id: PKG }, {})).httpStatus).toBe(400);
    expect((await handleHostOpRequest({ op: "grant_changed", package_id: "../bad" }, {})).httpStatus).toBe(
      400,
    );
    const routes = new Map<string, Function[]>();
    const app = {
      get: vi.fn(),
      post: (route: string, ...handlers: Function[]) => routes.set(route, handlers),
    };
    registerHttpApiRoutes(app as never, {} as never, {} as never);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await routes.get("/api/oauth/host")!.at(-1)!({ is: () => false }, res);
    expect(res.status).toHaveBeenCalledWith(415);
  });
});

describe("host boundary edge cases", () => {
  it.each([false, true])("forwards JSON-RPC grant text unchanged (host=%s)", async (host) => {
    if (!host) {
      delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
      delete process.env.MCP_HOST_BRIDGE_STATE;
    }
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", 600_000));
    const before = await fs.readFile(tokenPath(), "utf8");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_page",
        arguments: { body: 'curl -d "client_id=x&grant_type=refresh_token&refresh_token=quoted"' },
      },
    });
    expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
    const response = Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    const resource = vi.fn(async () => response);
    const bridge = vi.fn();
    vi.stubGlobal("fetch", bridge);
    const wrapped = createResponseNormalizingFetch(resource, undefined, await configured());
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body };
    for (const url of [BASE_URL, `${BASE_URL}/token-tool`]) {
      expect(await wrapped(url, init)).toBe(response);
      expect(resource).toHaveBeenLastCalledWith(url, init);
    }
    expect(resource).toHaveBeenCalledTimes(2);
    expect(bridge).not.toHaveBeenCalled();
    expect(await fs.readFile(tokenPath(), "utf8")).toBe(before);
  });

  it.each([false, true])(
    "recognizes string form grants only with form Content-Type (host=%s)",
    async (host) => {
      if (!host) {
        delete process.env.SUPER_MCP_HOST_GRANTS_DIR;
        delete process.env.MCP_HOST_BRIDGE_STATE;
      }
      await writeJson(tokenPath(), {
        ...tokensWithRemaining("refresh-r0", 600_000),
        [RENEWAL_HELD_FIELD]: true,
      });
      const network = vi.fn(async () => new Response("forwarded"));
      const wrapped = createResponseNormalizingFetch(network, undefined, await configured());
      const body = "grant_type=refresh_token&refresh_token=refresh-r0";
      expect((await wrapped(TOKEN_URL, { method: "POST", body })).status).toBe(200);
      expect(
        (
          await wrapped(TOKEN_URL, {
            method: "POST",
            body,
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          })
        ).status,
      ).toBe(503);
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "https://foreign.example.test/.well-known/oauth-authorization-server",
    "https://foreign.example.test/custom-metadata",
    "https://mcp.example.com/.well-known/oauth-protected-resource",
    "https://mcp.example.com/token",
  ])("never borrows or substitutes access for a 401 from %s", async (url) => {
    const bridge = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    const foreign = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer configured-access");
      return new Response("", { status: 401 });
    });
    const wrapped = createResponseNormalizingFetch(foreign, undefined, await configured());
    expect((await wrapped(url, { headers: { Authorization: "Bearer configured-access" } })).status).toBe(401);
    expect(foreign).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveBeenCalled();
    expect(await exists(tokenPath())).toBe(false);
  });

  it("retries a resource Request object once, preserving its POST body", async () => {
    const bridge = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", bridge);
    const bodies: string[] = [];
    const resource = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(await request.text());
      expect(request.headers.get("Content-Type")).toBe("application/json");
      return new Response("", {
        status: request.headers.get("Authorization") === "Bearer access-new" ? 200 : 401,
      });
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const request = new Request(BASE_URL, {
      method: "POST",
      body,
      headers: { Authorization: "Bearer access-old", "Content-Type": "application/json" },
    });
    const text = vi.spyOn(Request.prototype, "text");
    expect(
      (await createResponseNormalizingFetch(resource, undefined, await configured())(request)).status,
    ).toBe(200);
    // Only the resource reads each body; grant detection does not buffer JSON.
    expect(text).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual([body, body]);
    expect(resource).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bridge.mock.calls[0][1]!.body as string)).toEqual({
      source: tokenPath(),
      invalidate: accessTokenHash("access-old"),
    });
  });

  it.each([
    ["application/json", "application/x-www-form-urlencoded", true, 503, 1],
    ["application/x-www-form-urlencoded", "application/json", true, 200, 0],
    ["application/x-www-form-urlencoded", undefined, false, 200, 0],
  ] as const)(
    "buffers Request grants using effective Content-Type (%s, override=%s, provider=%s)",
    async (contentType, override, hasProvider, status, reads) => {
      await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
      const network = vi.fn(async () => new Response("forwarded"));
      const request = new Request(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: "grant_type=refresh_token&refresh_token=refresh-r0",
      });
      const text = vi.spyOn(Request.prototype, "text");
      const wrapped = createResponseNormalizingFetch(
        network,
        undefined,
        hasProvider ? await configured() : undefined,
      );
      expect(
        (await wrapped(request, override ? { headers: { "Content-Type": override } } : undefined)).status,
      ).toBe(status);
      expect(text).toHaveBeenCalledTimes(reads);
      expect(network).toHaveBeenCalledTimes(status === 503 ? 0 : 1);
    },
  );

  it("marks a never-connected missing package for sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "missing", bootstrapAllowed: true })),
    );
    const provider = await configured();
    expect(await provider.tokens()).toBeUndefined();
    expect(await readJson(markerPath())).toEqual({ needs_reconnect: true });
    await expect(
      new RefreshOnlyOAuthProvider(provider).redirectToAuthorization(new URL(BASE_URL)),
    ).rejects.toThrow(/Authentication required/);
  });

  it.each([true, false])(
    "offers a refresh token that arrives during a fresh pull (metadata=%s)",
    async (available) => {
      await writeJson(clientPath(), { client_id: "public-client" });
      const discovery = sdkNetwork({ fetch: vi.fn() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/oauth/access")) {
          await writeJson(tokenPath(), tokensWithRemaining("arriving-refresh", -1000));
          return Response.json(fresh());
        }
        return discovery(input, init);
      });
      const provider = available ? await configured() : new SimpleOAuthProvider(PKG);
      expect(await provider.tokens()).toBeUndefined();
      const disk = await readJson(tokenPath());
      expect(disk.access_token).toBe("access-old");
      expect(disk[RENEWAL_HELD_FIELD]).toBe(true);
      if (available) {
        expect(disk.refresh_token).toBeUndefined();
        const [offer] = await pendingFiles();
        expect((await readJson(path.join(exportDir, offer))).components.default.refresh_token).toBe(
          "arriving-refresh",
        );
      } else {
        expect(disk.refresh_token).toBe("arriving-refresh");
        expect(await pendingFiles()).toEqual([]);
      }
    },
  );

  it("rejects a symlinked grants directory", async () => {
    const linked = path.join(tempDir, "linked");
    await fs.symlink(exportDir, linked, process.platform === "win32" ? "junction" : "dir");
    process.env.SUPER_MCP_HOST_GRANTS_DIR = linked;
    await expect(validateHostGrantsDirectory()).rejects.toThrow(/symlink/);
  });

  it.skipIf(process.platform === "win32")("rejects a grants directory owned by another uid", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(validateHostGrantsDirectory()).rejects.toThrow(/owned by the current user/);
  });

  it("refuses a Request-object refresh POST before it reaches the provider", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
    const endpoint = createMockTokenEndpoint({ initialRefreshToken: "refresh-r0" });
    const request = new Request(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh-r0" }),
    });
    const response = await createResponseNormalizingFetch(
      endpoint.fetch,
      undefined,
      await configured(),
    )(request);
    expect(response.status).toBe(503);
    expect(endpoint.callCount()).toBe(0);
  });
  it("preserves a held grant if metadata is still unavailable and the host has older access", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-r0", -1000));
    const network = vi.fn(async () => Response.json(fresh()));
    vi.stubGlobal("fetch", network);
    expect(await new SimpleOAuthProvider(PKG).tokens()).toBeUndefined();
    expect(await readJson(tokenPath())).toMatchObject({
      refresh_token: "refresh-r0",
      [RENEWAL_HELD_FIELD]: true,
    });
    expect(network).not.toHaveBeenCalled();
  });
  it("fails a new sign-in if its offer cannot be persisted, retaining the old disk grant", async () => {
    await writeJson(tokenPath(), tokensWithRemaining("refresh-old-grant", 600_000));
    const p = await configured();
    (p as any).redirectStarted = true;
    await expect(p.saveTokens(tokensWithRemaining("refresh-new-grant", 600_000))).rejects.toThrow(
      /could not save/,
    );
    expect((await readJson(tokenPath())).refresh_token).toBe("refresh-old-grant");
  });
  it("returns the original 401 for an unchanged access token and excludes authorization-code exchanges", async () => {
    const bridge = vi.fn(async () => Response.json(fresh("access-old")));
    vi.stubGlobal("fetch", bridge);
    const resource = vi.fn(async () => new Response("", { status: 401 }));
    const request = createResponseNormalizingFetch(resource, undefined, await configured());
    expect((await request(BASE_URL, { headers: { Authorization: "Bearer access-old" } })).status).toBe(401);
    expect(resource).toHaveBeenCalledTimes(1);
    await request("https://auth.example.test/renew", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: "synthetic-code" }),
      headers: { Authorization: "Bearer access-old" },
    });
    expect(bridge).toHaveBeenCalledTimes(1);
  });
  it("rejects relative and non-private grants directories before startup", async () => {
    process.env.SUPER_MCP_HOST_GRANTS_DIR = "relative";
    await expect(validateHostGrantsDirectory()).rejects.toThrow(/Absolute/);
    process.env.SUPER_MCP_HOST_GRANTS_DIR = exportDir;
    if (process.platform !== "win32") {
      await fs.chmod(exportDir, 0o755);
      await expect(validateHostGrantsDirectory()).rejects.toThrow(/Private/);
    }
  });
});
