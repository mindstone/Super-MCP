import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import http from "node:http";
import { randomBytes } from "node:crypto";

import { auth, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { PackageRegistry } from "../src/registry.js";
import { isAuthLikeErrorMessageText } from "../src/auth/authLikeVocabulary.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import { RefreshOnlyOAuthProvider } from "../src/auth/providers/refreshOnly.js";
import type { PackageConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// LIVE-over-a-real-socket integration test (260701 confidence add).
//
// The other refresh-race suites drive the fix through an IN-MEMORY fetch
// (createMockTokenEndpoint) or a second OS process holding the proper-lockfile
// (tokenRefreshLock.test.ts GOLD). This suite is the missing middle: FM1
// (two concurrent refreshes against a single-use rotating provider) run against
// a REAL `http.Server` over a real TCP socket, through the REAL super-mcp fetch
// wrapper (`createResponseNormalizingFetch` → the transactional proper-lockfile
// refresh chokepoint) + the SDK's real `refreshAuthorization()`.
//
// Post-fix expectation (same as FM1 mock): the wrapper serializes the two POSTs,
// exactly ONE rotation is consumed, the loser self-heals off the freshly-rotated
// on-disk token, and both converge — nobody ends wedged with invalid_grant.
//
// A live test against a REAL provider (Notion/Linear) is deliberately NOT
// automated: a real refresh rotates the user's real grant server-side
// (destructive → forces re-auth), and providers' grace/reuse windows can HIDE the
// race. See the live-verification runbook in the plan folder for the opt-in,
// operator-run destructive check.
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

function mint(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

interface LocalAuthServer {
  metadata: AuthorizationServerMetadata;
  close(): Promise<void>;
  successCount(): number;
  currentValidRefreshToken(): string;
}

/**
 * Start a real HTTP authorization server that issues single-use rotating refresh
 * tokens. `responseDelayMs` holds each token response open before replying, so a
 * concurrent second caller is forced to arrive while the first refresh transaction
 * is still in flight — exercising the proper-lockfile SERIALIZATION, not merely a
 * sequential post-hoc short-circuit.
 */
async function startLocalAuthServer(
  initialRefreshToken: string,
  responseDelayMs = 0,
): Promise<LocalAuthServer> {
  let validRefreshToken = initialRefreshToken;
  let validAccessToken = mint("access-initial");
  let successes = 0;
  const consumed = new Set<string>();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url || !req.url.endsWith("/token")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const json = (status: number, payload: unknown): void => {
        const send = () => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (responseDelayMs > 0) {
          setTimeout(send, responseDelayMs);
        } else {
          send();
        }
      };

      if (form.get("grant_type") !== "refresh_token") {
        json(400, { error: "unsupported_grant_type" });
        return;
      }
      const presented = form.get("refresh_token") ?? "";
      // Single-use rotation: only the current, not-yet-consumed token works.
      if (presented !== validRefreshToken || consumed.has(presented)) {
        json(400, { error: "invalid_grant", error_description: "Grant not found" });
        return;
      }
      consumed.add(presented);
      successes += 1;
      validAccessToken = mint("access");
      validRefreshToken = mint("refresh");
      json(200, {
        access_token: validAccessToken,
        refresh_token: validRefreshToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind local auth server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const metadata = {
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/token`,
    token_endpoint_auth_methods_supported: ["none"],
    authorization_endpoint: `${baseUrl}/authorize`,
    response_types_supported: ["code"],
  } as AuthorizationServerMetadata;

  return {
    metadata,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    successCount: () => successes,
    currentValidRefreshToken: () => validRefreshToken,
  };
}

async function startConnectionServer() {
  let tokenStatus = 503;
  let tokenError = "server_error";
  let refreshRequests = 0;
  let baseUrl = "";
  const metadata = () => ({ issuer: baseUrl, authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token`, response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"] });
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url?.includes("oauth-protected-resource")) {
      json(200, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
      return;
    }
    if (req.url?.includes(".well-known")) { json(200, metadata()); return; }
    if (req.url === "/token") {
      refreshRequests++;
      req.resume();
      json(tokenStatus, tokenStatus === 200
        ? { access_token: "fictional-new-access", refresh_token: "fictional-new-refresh", token_type: "Bearer", expires_in: 3600 }
        : { error: tokenError });
      return;
    }
    if (req.headers.authorization !== "Bearer fictional-new-access") {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"` });
      res.end("Unauthorized");
      return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fictional-notebook", version: "1.0.0" } }
        : { tools: [] };
      json(200, { jsonrpc: "2.0", id: message.id, result });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the fictional service");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    setTokenStatus: (status: number, error = status === 400 ? "invalid_grant" : "server_error") => {
      tokenStatus = status;
      tokenError = error;
    },
    refreshRequests: () => refreshRequests,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

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

/**
 * Build a "process": a SimpleOAuthProvider + HttpMcpClient sharing the temp token
 * dir, and the REAL wrapped fetch from the client. Unlike the mock-endpoint harness
 * we do NOT swap globalThis.fetch, so the wrapper closes over the real undici fetch
 * and hits our local http server. `initializeOAuthIfNeeded` does no network I/O for
 * an external provider (verified in httpClient.ts), so this is safe.
 */
async function makeWrappedProcess(
  packageId: string,
  port: number,
): Promise<{ provider: SimpleOAuthProvider; wrappedFetch: typeof fetch }> {
  const provider = new SimpleOAuthProvider(packageId, port);
  await provider.initialize();
  const client = new HttpMcpClient(packageId, oauthHttpPackage(packageId), {
    oauthPort: port,
    oauthProvider: provider,
  });
  await (client as unknown as { initializeOAuthIfNeeded(f: boolean): Promise<void> }).initializeOAuthIfNeeded(true);
  const options = (client as unknown as { getTransportOptions(): { fetch: typeof fetch } }).getTransportOptions();
  return { provider, wrappedFetch: options.fetch };
}

interface RefreshOutcome {
  ok: boolean;
  invalidGrant: boolean;
}

/** Mirror of the SDK auth() refresh branch: refresh via the wrapper, persist; on
 * invalid_grant invalidate (refresh-only, the background-connect wedge wrapper)
 * then retry once. Faithful to oauth-refresh-race.test.ts runSdkRefreshCycle. */
async function runSdkRefreshCycle(
  provider: SimpleOAuthProvider,
  wrappedFetch: typeof fetch,
  metadata: AuthorizationServerMetadata,
): Promise<RefreshOutcome> {
  const clientInformation = { client_id: "public-client" } as never;

  const attempt = async (): Promise<RefreshOutcome> => {
    const tokens = await provider.tokens();
    const refreshToken = tokens?.refresh_token as string | undefined;
    if (!refreshToken) {
      return { ok: false, invalidGrant: false };
    }
    try {
      const newTokens = await refreshAuthorization(metadata.issuer, {
        metadata,
        clientInformation,
        refreshToken,
        fetchFn: wrappedFetch,
      });
      await provider.saveTokens(newTokens);
      return { ok: true, invalidGrant: false };
    } catch (error) {
      return { ok: false, invalidGrant: error instanceof InvalidGrantError };
    }
  };

  const first = await attempt();
  if (first.ok || !first.invalidGrant) {
    return first;
  }
  await new RefreshOnlyOAuthProvider(provider).invalidateCredentials("tokens");
  const second = await attempt();
  return { ok: second.ok, invalidGrant: (second.invalidGrant || first.invalidGrant) && !second.ok };
}

async function readDiskTokens(tempDir: string, packageId: string): Promise<{ refresh_token?: string } | undefined> {
  try {
    const raw = await fs.readFile(path.join(tempDir, `${packageId}_tokens.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

describe("OAuth refresh over a real local authorization server", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;
  let servers: Array<{ close(): Promise<void> }> = [];
  let registries: PackageRegistry[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-live-"));
    process.env[ENV_KEY] = tempDir;
    servers = [];
    registries = [];
  });

  afterEach(async () => {
    await Promise.all(registries.map(registry => registry.closeAll()));
    await Promise.all(servers.map((s) => s.close()));
    if (previousTokenDir === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function connectionFixture(issuerMismatch = false) {
    const server = await startConnectionServer();
    servers.push(server);
    const packageId = "fictional-notebook";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();
    await provider.saveClientInformation({ client_id: "fictional-client", redirect_uris: [provider.redirectUrl], issuer: server.baseUrl });
    await provider.saveTokens({ access_token: "fictional-old-access", refresh_token: "fictional-old-refresh", token_type: "Bearer", expires_in: 0, issuer: issuerMismatch ? "https://other.example.test" : server.baseUrl });
    const registry = new PackageRegistry({ mcpServers: { [packageId]: { url: `${server.baseUrl}/mcp`, oauth: true, name: "Fictional Notes" } } });
    registries.push(registry);
    return { server, registry, packageId, provider };
  }

  it.each([
    [undefined, "ECONNRESET", "ECONNRESET"],
    ["ETIMEDOUT", "ECONNRESET", "ETIMEDOUT"],
    [undefined, 42, "42"],
    [undefined, `ECONNRESET\r\n${"x".repeat(100)}`, `ECONNRESET  ${"x".repeat(68)}`],
  ])("bounds the refresh network warning code (top-level %s, cause %s)", async (code, nestedCode, expectedCode) => {
    const packageId = "fictional-network-failure";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();
    await provider.saveTokens({ access_token: "fictional-old-access", refresh_token: "fictional-old-refresh", token_type: "Bearer", expires_in: 0 });
    const canary = "fictional-acme-credential-canary";
    const error = Object.assign(new TypeError(canary, {
      cause: Object.assign(new Error(canary), { code: nestedCode }),
    }), { code });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const client = new HttpMcpClient(packageId, oauthHttpPackage(packageId), { oauthProvider: provider });

    try {
      await (client as unknown as { initializeOAuthIfNeeded(): Promise<void> }).initializeOAuthIfNeeded();
      const { fetch: wrappedFetch } = (client as unknown as { getTransportOptions(): { fetch: typeof fetch } }).getTransportOptions();
      await expect(wrappedFetch("https://oauth.example.test/token", {
        method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "fictional-old-refresh" }),
      })).rejects.toMatchObject({ name: "TemporarilyUnavailableError", cause: error });
      expect(mockLogger.warn).toHaveBeenCalledWith("OAuth refresh temporarily unavailable", {
        package_id: packageId, name: "TypeError", code: expectedCode,
      });
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(canary);
      expect(await readDiskTokens(tempDir, packageId)).toMatchObject({ refresh_token: "fictional-old-refresh" });
    } finally {
      fetchSpy.mockRestore();
      await client.close();
    }
  });

  it("keeps a temporary refresh failure transient and reconnects on the next attempt", async () => {
    const { server, registry, packageId } = await connectionFixture();
    const outcome = await registry.connectForCatalog(packageId);
    expect(server.refreshRequests()).toBeGreaterThan(0);
    expect(outcome.kind).toBe("transient_failure");
    expect(mockLogger.warn).toHaveBeenCalledWith("OAuth refresh temporarily unavailable", { package_id: packageId, status: 503 });
    if (outcome.kind !== "transient_failure") throw new Error("Expected a temporary connection failure");
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const sentence = "This connector's service didn't respond just now. It'll retry automatically.";
    expect(message).toContain(sentence);
    // The registry's wrapper adds the server URL, whose random local port can
    // contain "401", so check the client's own error: the text it classifies.
    const clientError = outcome.error instanceof Error ? outcome.error.cause : undefined;
    expect(clientError).toBeInstanceOf(Error);
    expect((clientError as Error).message).toBe(sentence);
    expect(isAuthLikeErrorMessageText((clientError as Error).message)).toBe(false);
    expect(sentence.toLowerCase()).not.toMatch(/authentication required|unauthorized|401|invalid_token|oauth|authorization/);
    expect(await readDiskTokens(tempDir, packageId)).toMatchObject({ refresh_token: "fictional-old-refresh" });
    expect(await SimpleOAuthProvider.readNeedsReconnectMarkerState(packageId)).toEqual({ state: "absent" });
    server.setTokenStatus(200);
    expect(await registry.connectForCatalog(packageId)).toMatchObject({ kind: "connected" });
    expect(await readDiskTokens(tempDir, packageId)).toMatchObject({ refresh_token: "fictional-new-refresh" });
  });

  it("falls through to browser sign-in after a temporary refresh failure during unforced explicit sign-in", async () => {
    const { server, packageId, provider } = await connectionFixture();
    const client = new HttpMcpClient(packageId, {
      ...oauthHttpPackage(packageId), base_url: `${server.baseUrl}/mcp`,
    }, { oauthProvider: provider });
    await (client as unknown as { initializeOAuthIfNeeded(f: boolean): Promise<void> }).initializeOAuthIfNeeded(true);
    const { fetch: wrappedFetch } = (client as unknown as { getTransportOptions(): { fetch: typeof fetch } }).getTransportOptions();
    const redirect = vi.spyOn(provider, "redirectToAuthorization").mockResolvedValue();

    // Keep the saved refresh token, as an explicit sign-in without force does.
    expect(await auth(provider, { serverUrl: `${server.baseUrl}/mcp`, fetchFn: wrappedFetch })).toBe("REDIRECT");
    expect(server.refreshRequests()).toBe(1);
    expect(redirect).toHaveBeenCalledWith(expect.any(URL));
    expect(await readDiskTokens(tempDir, packageId)).toMatchObject({ refresh_token: "fictional-old-refresh" });
  });

  it("keeps a dead grant as auth_required, removes tokens, and logs the cause", async () => {
    const { server, registry, packageId } = await connectionFixture();
    server.setTokenStatus(400);
    expect(await registry.connectForCatalog(packageId)).toMatchObject({ kind: "auth_required" });
    expect(server.refreshRequests()).toBeGreaterThan(0);
    expect(await readDiskTokens(tempDir, packageId)).toBeUndefined();
    expect(await SimpleOAuthProvider.readNeedsReconnectMarkerState(packageId)).toEqual({ state: "present" });
    expect(mockLogger.error).toHaveBeenCalledWith("Authentication required for MCP server", expect.objectContaining({ package_id: packageId, error: expect.any(String) }));
  });

  it("requires sign-in for tokens from another issuer without attempting a refresh", async () => {
    const { server, registry, packageId } = await connectionFixture(true);
    expect(await registry.connectForCatalog(packageId)).toMatchObject({ kind: "auth_required" });
    expect(server.refreshRequests()).toBe(0);
  });

  it("does not carry a temporary refresh failure across a success into an issuer mismatch", async () => {
    const { server, registry, packageId, provider } = await connectionFixture();
    const client = new HttpMcpClient(packageId, {
      ...oauthHttpPackage(packageId), base_url: `${server.baseUrl}/mcp`,
    }, { oauthProvider: provider });
    await (client as unknown as { initializeOAuthIfNeeded(): Promise<void> }).initializeOAuthIfNeeded();
    const { fetch: wrappedFetch } = (client as unknown as { getTransportOptions(): { fetch: typeof fetch } }).getTransportOptions();
    const refreshOnly = new RefreshOnlyOAuthProvider(provider);
    const options = { serverUrl: `${server.baseUrl}/mcp`, fetchFn: wrappedFetch };
    const redirect = vi.spyOn(refreshOnly, "redirectToAuthorization");

    // Reuse the same provider: replacing it between attempts would hide a stale flag.
    server.setTokenStatus(503, "temporarily_unavailable");
    const temporaryError = await auth(refreshOnly, options).catch(error => error);
    expect(redirect).not.toHaveBeenCalled();
    server.setTokenStatus(200);
    expect(await auth(refreshOnly, options)).toBe("AUTHORIZED");
    expect(await provider.tokens()).toMatchObject({ refresh_token: "fictional-new-refresh" });

    await provider.saveTokens({ access_token: "fictional-other-access", refresh_token: "fictional-other-refresh", token_type: "Bearer", expires_in: 0, issuer: "https://other.example.test" });
    const refreshCount = server.refreshRequests();
    const mismatchError = await auth(refreshOnly, options).catch(error => error);
    expect(mismatchError).toBeInstanceOf(Error);
    expect(mismatchError.message).toContain("Authentication required");
    expect(mismatchError.message).not.toMatch(/retry/i);
    expect(redirect).toHaveBeenCalledTimes(1);
    const outcome = await registry.connectForCatalog(packageId);
    expect(outcome.kind).toBe("auth_required");
    if (outcome.kind !== "auth_required") throw new Error("Expected sign-in for the other issuer");
    expect(String(outcome.error)).not.toMatch(/retry/i);
    expect(server.refreshRequests()).toBe(refreshCount);
    expect(temporaryError).toBeInstanceOf(TemporarilyUnavailableError);
    expect(temporaryError.message).toBe("This connector's service didn't respond just now. It'll retry automatically.");
    expect(temporaryError.cause).toBeInstanceOf(Response);
    expect(temporaryError.cause.status).toBe(503);
    expect(isAuthLikeErrorMessageText(temporaryError.message)).toBe(false);
  });

  it("keeps a rate-limited refresh transient without clearing tokens", async () => {
    const { server, registry, packageId } = await connectionFixture();
    server.setTokenStatus(429, "too_many_requests");
    const outcome = await registry.connectForCatalog(packageId);
    expect(outcome.kind).toBe("transient_failure");
    if (outcome.kind !== "transient_failure") throw new Error("Expected a temporary connection failure");
    expect(outcome.error).toHaveProperty("cause", expect.any(TemporarilyUnavailableError));
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const sentence = "This connector's service didn't respond just now. It'll retry automatically.";
    expect(message).toContain(sentence);
    // Check the client's own error, not the wrapper, whose URL has a random port.
    const clientError = (outcome.error as Error).cause as Error;
    expect(clientError.message).toBe(sentence);
    expect(isAuthLikeErrorMessageText(clientError.message)).toBe(false);
    expect(sentence.toLowerCase()).not.toMatch(/authentication required|unauthorized|401|invalid_token|oauth|authorization/);
    expect(server.refreshRequests()).toBeGreaterThan(0);
    expect(await readDiskTokens(tempDir, packageId)).toMatchObject({ refresh_token: "fictional-old-refresh" });
    expect(await SimpleOAuthProvider.readNeedsReconnectMarkerState(packageId)).toEqual({ state: "absent" });
  });

  it("single refresh rotates and persists over a real socket", async () => {
    const packageId = "Notion-live-single";
    const seedRefresh = "seed-live-single";
    const server = await startLocalAuthServer(seedRefresh);
    servers.push(server);

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "seed-access", refresh_token: seedRefresh, expires_in: 0 });

    const { provider, wrappedFetch } = await makeWrappedProcess(packageId, 5173);
    const outcome = await runSdkRefreshCycle(provider, wrappedFetch, server.metadata);

    expect(outcome.ok).toBe(true);
    expect(server.successCount()).toBe(1);
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe(server.currentValidRefreshToken());
  });

  it("two concurrent refreshes are serialized: exactly one rotation, both converge, none wedged", async () => {
    const packageId = "Notion-live-race";
    const seedRefresh = "seed-live-race";
    // 60ms per-response hold forces the second caller to arrive while the first
    // refresh transaction still holds the proper-lockfile → real lock contention.
    const server = await startLocalAuthServer(seedRefresh, 60);
    servers.push(server);

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "seed-access", refresh_token: seedRefresh, expires_in: 0 });

    const a = await makeWrappedProcess(packageId, 5173);
    const b = await makeWrappedProcess(packageId, 5173);

    const outcomes = await Promise.all([
      runSdkRefreshCycle(a.provider, a.wrappedFetch, server.metadata),
      runSdkRefreshCycle(b.provider, b.wrappedFetch, server.metadata),
    ]);

    // Nobody left permanently wedged with invalid_grant.
    const wedged = outcomes.filter((o) => o.invalidGrant && !o.ok);
    expect(wedged.length).toBe(0);
    // The proper-lockfile chokepoint serializes the race → exactly ONE rotation.
    expect(server.successCount()).toBe(1);
    // Both converge on the server's current valid refresh token.
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe(server.currentValidRefreshToken());
  });
});
