import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  refreshAuthorization,
  parseErrorResponse,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { HttpMcpClient } from "../src/clients/httpClient.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import { RefreshOnlyOAuthProvider } from "../src/auth/providers/refreshOnly.js";
import type { PackageConfig } from "../src/types.js";
import {
  createMockTokenEndpoint,
  type MockTokenEndpointHandle,
} from "./helpers/mockTokenEndpoint.js";

// ---------------------------------------------------------------------------
// DRIVING APPROACH (see subagent report for the full rationale)
//
// The real fix (Stage 5) lives in/around super-mcp's fetch wrapper
// (`createResponseNormalizingFetch` in httpClient.ts), but in CURRENT code that
// wrapper is a transparent pass-through for the rotation race — the race today
// is produced entirely by the providers:
//   - SimpleOAuthProvider.tokens()   -> serves a STALE per-process in-memory cache
//   - SimpleOAuthProvider.saveTokens() -> NON-ATOMIC write + STALE in-memory merge base
//   - RefreshOnlyOAuthProvider.invalidateCredentials('tokens') -> unconditional wedge
//
// So we drive the EXACT SDK refresh cycle the production code runs:
//   1. read provider.tokens()  (real provider)
//   2. POST grant_type=refresh_token via the SDK's real refreshAuthorization(),
//      using fetchFn = the REAL super-mcp fetch wrapper obtained from
//      `client.getTransportOptions().fetch` (so the production wrapper + the
//      production SDK token-request/error-parsing code are both exercised),
//      against the mock authorization server.
//   3. on success -> provider.saveTokens(result)  (real provider)
//   4. on InvalidGrantError -> provider.invalidateCredentials('tokens') then
//      retry once (mirrors SDK auth() at auth.js L156-158).
//
// This is faithful to how `@modelcontextprotocol/sdk` auth.js drives the
// provider hooks. Each "process" is its own provider+client pair sharing one
// temp token dir via SUPER_MCP_OAUTH_TOKEN_DIR.
//
// The tests are written so the SAME assertions flip green after Stages 2-5.
// Current-behaviour expectations are marked `CURRENT (red)` and the post-fix
// expectation is documented inline right next to them.
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
const TOKEN_URL = "https://auth.example.test/token";

function authServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: "https://auth.example.test",
    token_endpoint: TOKEN_URL,
    // Public client (no secret) — SDK adds client_id to the form body.
    token_endpoint_auth_methods_supported: ["none"],
    // AuthorizationServerMetadata requires these; the refresh path ignores them.
    authorization_endpoint: "https://auth.example.test/authorize",
    response_types_supported: ["code"],
  } as AuthorizationServerMetadata;
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
 * Build a "process": a SimpleOAuthProvider + HttpMcpClient sharing the temp
 * token dir, and the REAL fetch wrapper from the client. The wrapper's
 * baseFetch is overridden to the mock token endpoint by temporarily swapping
 * globalThis.fetch (which is what createResponseNormalizingFetch closes over).
 */
async function makeProcess(
  packageId: string,
  endpoint: MockTokenEndpointHandle,
): Promise<{
  provider: SimpleOAuthProvider;
  wrappedFetch: typeof fetch;
}> {
  const provider = new SimpleOAuthProvider(packageId, 5173);
  await provider.initialize();

  const config = oauthHttpPackage(packageId);
  const client = new HttpMcpClient(packageId, config, {
    oauthPort: 5173,
    oauthProvider: provider,
  });

  // The fetch wrapper closes over globalThis.fetch as baseFetch. Point it at
  // the mock authorization server while we construct the wrapper.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = endpoint.fetch;
  try {
    await (client as any).initializeOAuthIfNeeded(true);
    const options = (client as any).getTransportOptions() as { fetch: typeof fetch };
    return { provider, wrappedFetch: options.fetch };
  } finally {
    globalThis.fetch = savedFetch;
  }
}

interface RefreshOutcome {
  ok: boolean;
  invalidGrant: boolean;
  /** The refresh token this process presented to the server. */
  presented?: string;
  error?: unknown;
}

/**
 * Faithfully replicate the SDK auth() refresh-token branch for ONE process,
 * using the real provider + the real wrapped fetch + the real SDK
 * refreshAuthorization. `clientInformation` is a minimal public client.
 *
 * `refreshOnly` selects which invalidate path runs on invalid_grant:
 *   - true  -> RefreshOnlyOAuthProvider (the wedge wrapper used on background connects)
 *   - false -> SimpleOAuthProvider directly (the authenticate() path)
 */
async function runSdkRefreshCycle(
  provider: SimpleOAuthProvider,
  wrappedFetch: typeof fetch,
  opts: { refreshOnly: boolean } = { refreshOnly: false },
): Promise<RefreshOutcome> {
  const metadata = authServerMetadata();
  const clientInformation = { client_id: "public-client" } as any;

  const attempt = async (): Promise<RefreshOutcome> => {
    const tokens = await provider.tokens();
    const refreshToken = tokens?.refresh_token as string | undefined;
    if (!refreshToken) {
      return { ok: false, invalidGrant: false, error: new Error("no refresh token") };
    }

    try {
      const newTokens = await refreshAuthorization(metadata.issuer, {
        metadata,
        clientInformation,
        refreshToken,
        fetchFn: wrappedFetch,
      });
      await provider.saveTokens(newTokens);
      return { ok: true, invalidGrant: false, presented: refreshToken };
    } catch (error) {
      return {
        ok: false,
        invalidGrant: error instanceof InvalidGrantError,
        presented: refreshToken,
        error,
      };
    }
  };

  const first = await attempt();
  if (first.ok || !first.invalidGrant) {
    return first;
  }

  // SDK auth(): on InvalidGrantError -> invalidateCredentials('tokens') -> retry
  const invalidator = opts.refreshOnly
    ? new RefreshOnlyOAuthProvider(provider)
    : provider;
  await invalidator.invalidateCredentials("tokens");

  const second = await attempt();
  // Carry the first attempt's invalid_grant signal forward if the retry also failed
  // for lack of usable credentials (the wedge case keeps the dead token in place).
  return {
    ok: second.ok,
    invalidGrant: second.invalidGrant || (!second.ok && first.invalidGrant),
    presented: second.presented ?? first.presented,
    error: second.error ?? first.error,
  };
}

async function readDiskTokens(tempDir: string, packageId: string): Promise<any | undefined> {
  try {
    const raw = await fs.readFile(path.join(tempDir, `${packageId}_tokens.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

describe("OAuth refresh-token rotation race (red harness)", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;
  let savedFetch: typeof fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    savedFetch = globalThis.fetch;
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-race-"));
    process.env[ENV_KEY] = tempDir;
  });

  afterEach(async () => {
    globalThis.fetch = savedFetch;
    if (previousTokenDir === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousTokenDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Sanity: confirm parseErrorResponse maps our mock 400 to InvalidGrantError,
  // so the cycle's invalid_grant detection is genuinely exercising the SDK.
  it("precondition: mock invalid_grant 400 parses to InvalidGrantError via the SDK", async () => {
    const res = new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Grant not found" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const parsed = await parseErrorResponse(res);
    expect(parsed).toBeInstanceOf(InvalidGrantError);
  });

  // -------------------------------------------------------------------------
  // FM1 — Rotation race: two processes refresh concurrently.
  // -------------------------------------------------------------------------
  it("FM1: two concurrent refreshes — one loses with invalid_grant (current bug)", async () => {
    const packageId = "Notion-fm1";
    const seedRefresh = "seed-refresh-fm1";

    // Seed shared on-disk tokens both processes start from. expires_in:0 marks
    // the access token already-expired so a refresh is genuinely triggered (the
    // real-world trigger). With a still-valid access token the fix correctly
    // short-circuits without any network POST, which is a separate path.
    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 0,
    });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh });

    const a = await makeProcess(packageId, endpoint);
    const b = await makeProcess(packageId, endpoint);

    // Both read the SAME seed refresh token from their (stale) in-memory cache,
    // then race to POST it. Single-use rotation means the second POST is a replay.
    const [outA, outB] = await Promise.all([
      runSdkRefreshCycle(a.provider, a.wrappedFetch, { refreshOnly: true }),
      runSdkRefreshCycle(b.provider, b.wrappedFetch, { refreshOnly: true }),
    ]);

    const outcomes = [outA, outB];
    const losers = outcomes.filter((o) => o.invalidGrant && !o.ok);

    // CURRENT (red): exactly one process loses the race with invalid_grant,
    // because both replay the same single-use token and the loser's
    // invalidate-then-retry re-reads its OWN stale token (tokens() never re-reads
    // disk) and/or the wedge keeps the dead token in place.
    //
    // POST-FIX (green): no process ends invalid_grant — the loser detects the
    // stale-vs-disk token and short-circuits / self-heals, so BOTH converge.
    expect(losers.length).toBe(0); // FAILS on current code (one loser survives)

    // Exactly one rotation should ever be consumed against the server.
    expect(endpoint.successCount()).toBe(1);

    // Both processes should converge on the latest on-disk refresh token.
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe(endpoint.currentValidRefreshToken());
  });

  // -------------------------------------------------------------------------
  // FM2 — Partial read: a torn / non-atomic write yields a parse-failing read.
  // -------------------------------------------------------------------------
  it("FM2: saveTokens() is non-atomic — a concurrent reader can observe a torn file", async () => {
    const packageId = "Notion-fm2";

    const writer = new SimpleOAuthProvider(packageId, 5173);
    await writer.initialize();
    // Establish a baseline file first.
    await writer.saveTokens({ access_token: "a0", refresh_token: "r0", expires_in: 3600 });

    const tokenFile = path.join(tempDir, `${packageId}_tokens.json`);

    // Hammer the same file with overlapping large writes and concurrent reads.
    // With non-atomic fs.writeFile (truncate-then-write), a reader can observe a
    // partially-written file -> JSON.parse throws.
    const big = "x".repeat(64 * 1024);
    let tornObserved = false;

    const writes: Promise<void>[] = [];
    const reads: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) {
      writes.push(
        writer.saveTokens({
          access_token: `a${i}`,
          refresh_token: `r${i}`,
          expires_in: 3600,
          padding: big,
        }),
      );
      reads.push(
        (async () => {
          try {
            const raw = await fs.readFile(tokenFile, "utf8");
            JSON.parse(raw);
          } catch (err) {
            // ENOENT during temp+rename is fine post-fix; a JSON SyntaxError is the
            // torn-read symptom we are pinning here.
            if (err instanceof SyntaxError) {
              tornObserved = true;
            }
          }
        })(),
      );
    }
    await Promise.all([...writes, ...reads]);

    // The assertion is written for the POST-FIX contract: reads must be
    // all-or-nothing, so a parse-failing (torn) read is NEVER observable.
    //
    // CURRENT (red): saveTokens() uses non-atomic fs.writeFile (truncate then
    // stream), so a concurrent reader CAN observe a torn file -> tornObserved
    // becomes true -> this expectation FAILS (proves the bug).
    //
    // POST-FIX (green): temp-file + rename makes every write atomic, so
    // tornObserved stays false and this passes.
    expect(tornObserved).toBe(false); // FAILS on current code (torn read observed)
  });

  // -------------------------------------------------------------------------
  // FM3 — Stale in-memory cache: tokens() serves a token a peer already rotated.
  // -------------------------------------------------------------------------
  it("FM3: tokens() returns a stale token after a peer rotated on disk (current bug)", async () => {
    const packageId = "Notion-fm3";
    const seedRefresh = "seed-refresh-fm3";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    // expires_in:0 → access token already expired, so a refresh genuinely fires.
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 0,
    });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh });

    // Process A and Process B both load the seed token into memory.
    const a = await makeProcess(packageId, endpoint);
    const b = await makeProcess(packageId, endpoint);

    // Process A refreshes + persists the rotated token to disk.
    const outA = await runSdkRefreshCycle(a.provider, a.wrappedFetch, { refreshOnly: true });
    expect(outA.ok).toBe(true);

    const disk = await readDiskTokens(tempDir, packageId);
    const rotatedRefresh = disk?.refresh_token as string;
    expect(rotatedRefresh).toBe(endpoint.currentValidRefreshToken());
    expect(rotatedRefresh).not.toBe(seedRefresh);

    // Process B now calls tokens(). It must reflect A's rotation.
    const bTokens = await b.provider.tokens();

    // CURRENT (red): B serves the OLD seed token from its in-memory cache.
    //
    // POST-FIX (green): tokens() re-reads disk -> B returns the rotated token.
    expect(bTokens?.refresh_token).toBe(rotatedRefresh); // FAILS on current code
  });

  // -------------------------------------------------------------------------
  // FM4 — Permanent wedge: a genuinely dead grant is never cleared.
  // -------------------------------------------------------------------------
  it("FM4: genuinely-revoked grant stays wedged in refresh-only mode (current bug)", async () => {
    const packageId = "Notion-fm4";
    const seedRefresh = "seed-refresh-fm4";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    // expires_in:0 → access token already expired, so a refresh genuinely fires
    // and hits the revoked grant (rather than short-circuiting on a valid token).
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 0,
    });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh });
    // The provider revoked the grant entirely (user disconnected the app, etc.).
    endpoint.revokeGrant();

    const a = await makeProcess(packageId, endpoint);

    const out = await runSdkRefreshCycle(a.provider, a.wrappedFetch, { refreshOnly: true });
    expect(out.ok).toBe(false);
    expect(out.invalidGrant).toBe(true);

    const tokenFile = path.join(tempDir, `${packageId}_tokens.json`);
    const reconnectMarker = path.join(tempDir, `${packageId}_needsReconnect.json`);

    const tokensStillThere = await fs
      .readFile(tokenFile, "utf8")
      .then(() => true)
      .catch(() => false);
    const markerExists = await fs
      .access(reconnectMarker)
      .then(() => true)
      .catch(() => false);

    // The assertions are written for the POST-FIX contract: a genuinely-dead
    // grant must be recognised (disk unchanged after bounded re-read) -> the
    // dead token cleared + a needsReconnect marker written, so the connector
    // surfaces a clean reconnect instead of silently wedging.
    //
    // CURRENT (red): RefreshOnlyOAuthProvider.invalidateCredentials('tokens')
    // unconditionally swallows the request, so the dead token file is LEFT in
    // place and NO needsReconnect marker is written -> both expectations FAIL
    // (proves the permanent silent wedge).
    //
    // POST-FIX (green): tokensStillThere === false and markerExists === true.
    expect(tokensStillThere).toBe(false); // FAILS on current code (wedge: token kept)
    expect(markerExists).toBe(true); // FAILS on current code (wedge: no marker)
  });

  // -------------------------------------------------------------------------
  // FM4b — Peer-rotated invalidate should be SWALLOWED (distinct from dead grant).
  // This documents the post-fix smart-invalidate contract and currently passes
  // trivially via the blanket swallow; after the fix it must STILL pass but for
  // the right reason (disk token differs from the one that failed).
  // -------------------------------------------------------------------------
  it("FM4b: invalidate after a peer already rotated must NOT delete the fresh on-disk token", async () => {
    const packageId = "Notion-fm4b";
    const seedRefresh = "seed-refresh-fm4b";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 3600,
    });

    // A peer rotated: disk now holds a DIFFERENT, fresh refresh token.
    const peerWriter = new SimpleOAuthProvider(packageId, 5173);
    await peerWriter.initialize();
    await peerWriter.saveTokens({
      access_token: "peer-access",
      refresh_token: "peer-rotated-refresh",
      expires_in: 3600,
    });

    // This process failed with invalid_grant on the OLD seed token, then the SDK
    // calls invalidateCredentials('tokens') in refresh-only mode.
    const loser = new SimpleOAuthProvider(packageId, 5173);
    await loser.initialize();
    loser.setLastOAuthError({ error: "invalid_grant", error_description: "Grant not found" });
    const refreshOnly = new RefreshOnlyOAuthProvider(loser);
    await refreshOnly.invalidateCredentials("tokens");

    // The peer's freshly-rotated on-disk token must survive (both pre- and
    // post-fix). This assertion is GREEN on current code (blanket swallow) and
    // must STAY green after the fix (disk-compare swallow).
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe("peer-rotated-refresh");
  });
});
