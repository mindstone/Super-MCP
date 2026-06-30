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

import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import { runRefreshTransaction } from "../src/auth/refreshTransaction.js";
import {
  createMockTokenEndpoint,
  type MockTokenEndpointHandle,
} from "./helpers/mockTokenEndpoint.js";

// ---------------------------------------------------------------------------
// MA1 regression — transaction-owned persistence UNDER the lock.
//
// The Phase-5 defect: the rotated token was persisted by the SDK's saveTokens()
// AFTER runRefreshTransaction() returned and the lock released. That leaves a
// gap where a peer acquires the lock, reads the OLD on-disk token, replays it →
// invalid_grant, exhausts the FM5 backoff, and clears/marks a LIVE grant dead.
//
// This test forces that exact interleaving DETERMINISTICALLY by modelling the
// SDK's post-transaction persist as a SLOW operation: process A runs its
// transaction (POST + rotate), then process B runs its transaction in the gap
// BEFORE A's (simulated, slow) SDK saveTokens lands. With persist moved INSIDE
// the transaction (the fix), B reads A's freshly-persisted token and never
// replays a dead one. Without the fix, B replays the consumed token, fails
// invalid_grant, and the dead-grant path clears the live grant.
// ---------------------------------------------------------------------------

const ENV_KEY = "SUPER_MCP_OAUTH_TOKEN_DIR";
const TOKEN_URL = "https://auth.example.test/token";

function refreshInit(refreshToken: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "public-client",
    }),
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

describe("MA1 — rotated token is persisted under the refresh lock", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-ma1-"));
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

  it("persists the rotated token before releasing the lock, so a peer in the gap never replays a dead token", async () => {
    const packageId = "Notion-ma1";
    const seedRefresh = "seed-refresh-ma1";

    // Seed shared on-disk tokens; expires_in:0 forces a real refresh POST (no
    // short-circuit on a still-valid access token).
    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 0,
    });

    const endpoint: MockTokenEndpointHandle = createMockTokenEndpoint({
      initialRefreshToken: seedRefresh,
      tokenUrl: TOKEN_URL,
    });

    // Two independent "processes" (providers) sharing the same token dir.
    const providerA = new SimpleOAuthProvider(packageId, 5173);
    await providerA.initialize();
    const providerB = new SimpleOAuthProvider(packageId, 5173);
    await providerB.initialize();

    // Process A runs the transaction: POST seed token under the lock → rotate.
    // (The transaction itself persists under the lock in the fixed code.)
    const responseA = await runRefreshTransaction(
      { provider: providerA, baseFetch: endpoint.fetch },
      TOKEN_URL,
      refreshInit(seedRefresh),
    );
    expect(responseA.ok).toBe(true);

    // SIMULATE THE SLOW SDK PERSIST: the SDK would now call providerA.saveTokens()
    // with the parsed body, but we DELAY it to model real-world scheduling/slow
    // disk. Pre-fix, the on-disk token is still the consumed seed token here, so
    // B (next) replays it. Post-fix, the transaction already persisted, so disk
    // already holds A's rotated token regardless of this delayed save.
    // The slow SDK save is deliberately LONGER than the transaction's whole FM5
    // backoff budget (~3 × up-to-500ms ≈ 1.4s) so the loser's bounded backoff
    // cannot rescue it. This isolates the STRUCTURAL guarantee (persist-under-lock)
    // from the empirical one (backoff happens to absorb a fast save).
    const bodyA = await responseA.clone().json();
    const slowSdkSaveA = (async () => {
      await new Promise((r) => setTimeout(r, 1800));
      await providerA.saveTokens(bodyA);
    })();

    // Process B runs its transaction IN THE GAP, before A's slow SDK save lands.
    const responseB = await runRefreshTransaction(
      { provider: providerB, baseFetch: endpoint.fetch },
      TOKEN_URL,
      refreshInit(seedRefresh),
    );

    await slowSdkSaveA;

    // POST-FIX: B must NOT have failed invalid_grant — it should read A's
    // already-persisted rotated token under the lock and short-circuit / present
    // the fresh token. So B's response is ok.
    expect(responseB.ok).toBe(true);

    // Exactly one rotation should ever be consumed against the server.
    expect(endpoint.successCount()).toBe(1);

    // The live grant must NOT have been cleared, and no dead-grant marker written.
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk).toBeDefined();
    expect(disk?.refresh_token).toBe(endpoint.currentValidRefreshToken());

    const markerExists = await fs
      .access(path.join(tempDir, `${packageId}_needsReconnect.json`))
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(false);
  });

  // MA2 — fail closed when persistence fails after a real rotation.
  it("MA2: a persistence failure after a real rotation throws (fail closed) and flags reconnect", async () => {
    const packageId = "Notion-ma2";
    const seedRefresh = "seed-refresh-ma2";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({
      access_token: "seed-access",
      refresh_token: seedRefresh,
      expires_in: 0,
    });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh, tokenUrl: TOKEN_URL });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    // Simulate a disk write failure for the rotation persist (e.g. ENOSPC/EACCES)
    // AFTER the server already consumed the single-use token.
    const persistSpy = vi
      .spyOn(provider, "persistRotatedTokensOrThrow")
      .mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      runRefreshTransaction(
        { provider, baseFetch: endpoint.fetch },
        TOKEN_URL,
        refreshInit(seedRefresh),
      ),
    ).rejects.toThrow(/ENOSPC/);

    expect(persistSpy).toHaveBeenCalledTimes(1);
    // The server consumed exactly one rotation; we did NOT report AUTHORIZED.
    expect(endpoint.successCount()).toBe(1);

    // Fail closed: a reconnect marker is written so the next run surfaces a clean
    // reconnect rather than silently wedging on the dead disk token.
    const markerExists = await fs
      .access(path.join(tempDir, `${packageId}_needsReconnect.json`))
      .then(() => true)
      .catch(() => false);
    expect(markerExists).toBe(true);
  });

  // MA2 corollary — the SDK's unavoidable second save (and interactive paths)
  // must stay TOLERANT: a write failure there is logged, never thrown.
  it("MA2: public saveTokens() stays fail-open (tolerant) on a write error", async () => {
    const packageId = "Notion-ma2-tolerant";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    // Force the storage dir to be a FILE so mkdir/write fails inside saveTokens.
    // (No throw must escape — the SDK relies on this being tolerant.)
    const badDir = path.join(tempDir, "as-a-file");
    await fs.writeFile(badDir, "not a dir");
    process.env[ENV_KEY] = badDir;
    const tolerantProvider = new SimpleOAuthProvider("Notion-ma2-tolerant-2", 5173);
    await tolerantProvider.initialize();

    await expect(
      tolerantProvider.saveTokens({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    ).resolves.toBeUndefined();

    process.env[ENV_KEY] = tempDir;
  });
});
