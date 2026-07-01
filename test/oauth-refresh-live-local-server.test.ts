import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import http from "node:http";
import { randomBytes } from "node:crypto";

import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

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
  let servers: LocalAuthServer[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-live-"));
    process.env[ENV_KEY] = tempDir;
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    if (previousTokenDir === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
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
