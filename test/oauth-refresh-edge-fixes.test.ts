import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

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
// Round-3 edge fixes (F1 / F2 / F3) for the OAuth rotation-race transaction.
//
// These cover three narrower auth-correctness gaps the round-2 cross-family
// re-review found AFTER the headline persist-under-lock fix (MA1) landed:
//
//   F1 — the stale-echo guard used a SINGLE slot, so multiple same-process
//        sequential authoritative refreshes followed by a delayed SDK echo of an
//        EARLIER token could downgrade a newer on-disk token.
//   F2 — the transaction persisted the RAW 200 body before the SDK applied its
//        token schema, so a malformed 200 could mutate disk token state.
//   F3 — an unreadable / empty-placeholder disk token file early-returned a raw
//        baseFetch(), bypassing the authoritative in-lock persist entirely.
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

function tokenPathFor(tempDir: string, packageId: string): string {
  return path.join(tempDir, `${packageId}_tokens.json`);
}

function markerPathFor(tempDir: string, packageId: string): string {
  return path.join(tempDir, `${packageId}_needsReconnect.json`);
}

async function readDiskTokens(tempDir: string, packageId: string): Promise<any | undefined> {
  try {
    const raw = await fs.readFile(tokenPathFor(tempDir, packageId), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

let tempDir: string;
let previousTokenDir: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  previousTokenDir = process.env[ENV_KEY];
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-edge-"));
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

// ---------------------------------------------------------------------------
// F1 — bounded authoritative-echo queue: no multi-refresh downgrade.
//
// Pre-fix the provider held ONE `lastAuthoritativeTokenEcho` slot. After two
// sequential authoritative persists (v1 then v2), a DELAYED SDK echo of v1 found
// the slot holding v2, so `shouldSkipNonAuthoritativeWrite` failed to recognise
// v1 as a stale echo and wrote v1 back over v2 (a downgrade to a consumed token).
// GPT reproduced this: persist(v1) -> persist(v2) -> saveTokens(v1) left disk at
// v1. With the bounded queue, the delayed echo of v1 still matches a pending
// authoritative identity and is skipped → disk stays v2.
// ---------------------------------------------------------------------------
describe("F1 — bounded authoritative-echo queue prevents multi-refresh downgrade", () => {
  it("persist(v1) -> persist(v2) -> delayed SDK echo(v1) leaves disk at v2 (no downgrade)", async () => {
    const packageId = "Notion-f1";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const v1 = { access_token: "access-v1", refresh_token: "refresh-v1", token_type: "Bearer", expires_in: 3600 };
    const v2 = { access_token: "access-v2", refresh_token: "refresh-v2", token_type: "Bearer", expires_in: 3600 };

    // Two sequential AUTHORITATIVE (in-lock) persists, as two refreshes would do.
    await provider.persistRotatedTokensOrThrow(v1);
    await provider.persistRotatedTokensOrThrow(v2);

    // The SDK's unavoidable second save for the FIRST refresh now arrives LATE,
    // echoing v1 (a now-superseded token).
    await provider.saveTokens(v1);

    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.access_token).toBe("access-v2");
    expect(disk?.refresh_token).toBe("refresh-v2");
  });

  it("handles N>2 outstanding echoes arriving out of order without downgrading", async () => {
    const packageId = "Notion-f1-n";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const versions = [1, 2, 3, 4].map((n) => ({
      access_token: `access-v${n}`,
      refresh_token: `refresh-v${n}`,
      token_type: "Bearer",
      expires_in: 3600,
    }));

    // Four sequential authoritative persists.
    for (const v of versions) {
      await provider.persistRotatedTokensOrThrow(v);
    }

    // Delayed SDK echoes for v1..v3 arrive AFTER v4 is the truth, out of order.
    await provider.saveTokens(versions[2]); // echo v3
    await provider.saveTokens(versions[0]); // echo v1
    await provider.saveTokens(versions[1]); // echo v2

    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.access_token).toBe("access-v4");
    expect(disk?.refresh_token).toBe("refresh-v4");
  });

  it("a CONSUMED echo identity does not suppress a genuinely-new later write of that identity", async () => {
    // Guard against over-suppression: once an echo is consumed (matched once), a
    // subsequent genuinely-new write carrying the same identity must still land.
    const packageId = "Notion-f1-consume";
    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const v1 = { access_token: "access-v1", refresh_token: "refresh-v1", token_type: "Bearer", expires_in: 3600 };
    const v2 = { access_token: "access-v2", refresh_token: "refresh-v2", token_type: "Bearer", expires_in: 3600 };

    await provider.persistRotatedTokensOrThrow(v1);
    await provider.persistRotatedTokensOrThrow(v2);

    // First delayed echo of v1 is correctly skipped (disk stays v2)…
    await provider.saveTokens(v1);
    expect((await readDiskTokens(tempDir, packageId))?.access_token).toBe("access-v2");

    // …and that v1 echo identity is now CONSUMED. If disk later genuinely returns
    // to v1 (e.g. an interactive re-auth that reissued v1), a non-authoritative
    // write of v1 must NOT be suppressed by a stale echo entry. Simulate by
    // clearing disk and writing v1 via the public path.
    await fs.rm(tokenPathFor(tempDir, packageId), { force: true });
    await provider.saveTokens(v1);
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.access_token).toBe("access-v1");
    expect(disk?.refresh_token).toBe("refresh-v1");
  });
});

// ---------------------------------------------------------------------------
// F2 — schema-validate the 200 body BEFORE persisting; fail closed on invalid.
// ---------------------------------------------------------------------------
describe("F2 — malformed 200 token body does not mutate disk; fails closed", () => {
  function malformedEndpoint(): typeof fetch {
    // A token endpoint that returns HTTP 200 (so the single-use token is
    // 'consumed' server-side) but a body MISSING access_token — exactly the case
    // the SDK's OAuthTokensSchema rejects.
    return (async () =>
      new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  it("does NOT overwrite the on-disk token with the invalid body, and writes a reconnect marker", async () => {
    const packageId = "Notion-f2";
    const seedRefresh = "seed-refresh-f2";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    // expires_in:0 forces a real POST (no short-circuit).
    await seeder.saveTokens({ access_token: "seed-access", refresh_token: seedRefresh, expires_in: 0 });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    await expect(
      runRefreshTransaction(
        { provider, baseFetch: malformedEndpoint() },
        TOKEN_URL,
        refreshInit(seedRefresh),
      ),
    ).rejects.toThrow();

    // Fail closed: the disk token must NOT have been mutated to the invalid body
    // (which had no access_token), and a reconnect marker must be written. The
    // dead seed token is cleared rather than left intact as if authorized.
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk).toBeUndefined();
    expect(await fileExists(markerPathFor(tempDir, packageId))).toBe(true);
  });

  it("a VALID 200 body still persists normally (no false-positive fail-closed)", async () => {
    const packageId = "Notion-f2-valid";
    const seedRefresh = "seed-refresh-f2-valid";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "seed-access", refresh_token: seedRefresh, expires_in: 0 });

    const endpoint: MockTokenEndpointHandle = createMockTokenEndpoint({
      initialRefreshToken: seedRefresh,
      tokenUrl: TOKEN_URL,
    });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const response = await runRefreshTransaction(
      { provider, baseFetch: endpoint.fetch },
      TOKEN_URL,
      refreshInit(seedRefresh),
    );
    expect(response.ok).toBe(true);

    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe(endpoint.currentValidRefreshToken());
    expect(await fileExists(markerPathFor(tempDir, packageId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F3 — unreadable / empty-placeholder disk does NOT bypass the authoritative path.
//
// Pre-fix, a disk-read failure early-returned baseFetch(input, init), running the
// refresh OUTSIDE the in-lock persist: a 200 consumed the single-use token and the
// rotated value was only ever written by the fail-OPEN public saveTokens(). Here we
// prove the refresh result IS persisted under the lock even when the disk token
// file is an empty placeholder (the lock's own placeholder for a first-ever refresh)
// — i.e. the single-use token is not silently consumed without a durable persist.
// ---------------------------------------------------------------------------
describe("F3 — empty/unreadable disk token file stays on the authoritative path", () => {
  it("empty-placeholder token file during a needed refresh persists the result under the lock", async () => {
    const packageId = "Notion-f3-empty";
    const seedRefresh = "seed-refresh-f3";

    // Create an EMPTY placeholder token file (mirrors the lock's placeholder, and
    // a truncated/torn write). readDiskTokens() does JSON.parse("") → throws, which
    // pre-fix triggered the early-return baseFetch bypass.
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tokenPathFor(tempDir, packageId), "", { mode: 0o600 });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh, tokenUrl: TOKEN_URL });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    // The SDK-supplied refresh token is the seed; disk is empty so the transaction
    // must send the supplied token and persist the rotation under the lock.
    const response = await runRefreshTransaction(
      { provider, baseFetch: endpoint.fetch },
      TOKEN_URL,
      refreshInit(seedRefresh),
    );
    expect(response.ok).toBe(true);

    // Exactly one rotation consumed AND the rotated token is durably on disk —
    // proving it was persisted under the lock, not lost to a fail-open bypass.
    expect(endpoint.successCount()).toBe(1);
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk).toBeDefined();
    expect(disk?.refresh_token).toBe(endpoint.currentValidRefreshToken());
    expect(disk?.access_token).toBe(endpoint.currentValidAccessToken());
  });

  it("genuinely-corrupt (non-empty, unparseable) disk content still proceeds under lock and persists", async () => {
    const packageId = "Notion-f3-corrupt";
    const seedRefresh = "seed-refresh-f3-corrupt";

    await fs.mkdir(tempDir, { recursive: true });
    // Non-empty but invalid JSON → genuinely unreadable; must still stay on the
    // authoritative path (warn), not bypass.
    await fs.writeFile(tokenPathFor(tempDir, packageId), "{ this is not json", { mode: 0o600 });

    const endpoint = createMockTokenEndpoint({ initialRefreshToken: seedRefresh, tokenUrl: TOKEN_URL });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const response = await runRefreshTransaction(
      { provider, baseFetch: endpoint.fetch },
      TOKEN_URL,
      refreshInit(seedRefresh),
    );
    expect(response.ok).toBe(true);
    expect(endpoint.successCount()).toBe(1);

    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe(endpoint.currentValidRefreshToken());

    // It was treated as genuinely unreadable (a structured warn), not the benign
    // empty-placeholder debug path.
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// N1 — SDK omit-reattach must not downgrade a refresh token the transaction
// substituted.
//
// When the transaction substitutes the FRESHER disk refresh token (r-fresh) for
// the POST but the token endpoint returns a valid 200 that OMITS refresh_token
// (no rotation this round), the SDK's refreshAuthorization() reattaches its
// ORIGINAL supplied argument (the stale r-old) via
// `return { refresh_token: refreshToken, ...tokens }`. The transaction must hand
// the SDK a response body carrying the PERSISTED refresh token (r-fresh) so that
// omit-reattach is a no-op and the SDK's subsequent saveTokens() does not
// downgrade disk to r-old.
//
// Driven through the REAL SDK refreshAuthorization + REAL runRefreshTransaction
// (as fetchFn) + REAL SimpleOAuthProvider, mirroring the round-3 probe.
// ---------------------------------------------------------------------------
function authServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: "https://auth.example.test",
    token_endpoint: TOKEN_URL,
    token_endpoint_auth_methods_supported: ["none"],
    authorization_endpoint: "https://auth.example.test/authorize",
    response_types_supported: ["code"],
  } as AuthorizationServerMetadata;
}

/**
 * A token endpoint that returns a valid 200 with a NEW access_token but
 * deliberately OMITS refresh_token (the "no rotation this round" case the SDK
 * schema permits). Accepts whatever refresh token is presented.
 */
function nonRotatingEndpoint(newAccessToken: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ access_token: newAccessToken, token_type: "Bearer", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

describe("N1 — omitted refresh_token after substitution does not downgrade disk", () => {
  it("disk has r-fresh, SDK supplies stale r-old, 200 omits refresh_token ⇒ disk stays r-fresh", async () => {
    const packageId = "Notion-n1";

    // Seed disk with the FRESHER refresh token (a peer/our earlier refresh
    // rotated to r-fresh). expires_in:0 forces a real POST (no short-circuit).
    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "access-old", refresh_token: "r-fresh", expires_in: 0 });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    const baseFetch = nonRotatingEndpoint("access-new");
    // The wrapped fetch the SDK calls: every POST goes through the real transaction.
    const wrappedFetch: typeof fetch = (input, init) =>
      runRefreshTransaction({ provider, baseFetch }, input as RequestInfo | URL, init);

    // The SDK supplies the STALE r-old (e.g. it hasn't re-read disk yet). The
    // transaction substitutes r-fresh from disk for the actual POST.
    const newTokens = await refreshAuthorization(authServerMetadata().issuer, {
      metadata: authServerMetadata(),
      clientInformation: { client_id: "public-client" } as any,
      refreshToken: "r-old",
      fetchFn: wrappedFetch,
    });

    // The SDK then performs its unavoidable second save with what it returned.
    await provider.saveTokens(newTokens);

    // The SDK-visible response must have carried r-fresh, so the SDK did NOT
    // reattach r-old; disk must remain r-fresh (NOT downgraded to r-old).
    expect((newTokens as any).refresh_token).toBe("r-fresh");
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe("r-fresh");
    expect(disk?.refresh_token).not.toBe("r-old");
    expect(disk?.access_token).toBe("access-new");
  });

  it("control: a 200 that DOES rotate carries the new token to BOTH disk and the SDK-visible response", async () => {
    const packageId = "Notion-n1-rotate";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "access-old", refresh_token: "r-fresh", expires_in: 0 });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    // Rotating endpoint: returns BOTH a new access_token and a new refresh_token.
    const baseFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "access-rotated",
          refresh_token: "r-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const wrappedFetch: typeof fetch = (input, init) =>
      runRefreshTransaction({ provider, baseFetch }, input as RequestInfo | URL, init);

    const newTokens = await refreshAuthorization(authServerMetadata().issuer, {
      metadata: authServerMetadata(),
      clientInformation: { client_id: "public-client" } as any,
      refreshToken: "r-old",
      fetchFn: wrappedFetch,
    });
    await provider.saveTokens(newTokens);

    expect((newTokens as any).refresh_token).toBe("r-rotated");
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk?.refresh_token).toBe("r-rotated");
    expect(disk?.access_token).toBe("access-rotated");
  });

  it("unreadable-JSON 200 after a refresh writes a reconnect marker and throws", async () => {
    const packageId = "Notion-n1-unreadable";
    const seedRefresh = "seed-refresh-n1-unreadable";

    const seeder = new SimpleOAuthProvider(packageId, 5173);
    await seeder.initialize();
    await seeder.saveTokens({ access_token: "seed-access", refresh_token: seedRefresh, expires_in: 0 });

    const provider = new SimpleOAuthProvider(packageId, 5173);
    await provider.initialize();

    // 200 with a body that is NOT valid JSON → parseTokenResponseBody throws.
    const unreadableEndpoint: typeof fetch = (async () =>
      new Response("<<<not json>>>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await expect(
      runRefreshTransaction(
        { provider, baseFetch: unreadableEndpoint },
        TOKEN_URL,
        refreshInit(seedRefresh),
      ),
    ).rejects.toThrow();

    // Fail closed: the (likely-consumed) seed token is cleared and a reconnect
    // marker is written — consistent with the schema-invalid 200 path.
    expect(await fileExists(markerPathFor(tempDir, packageId))).toBe(true);
    const disk = await readDiskTokens(tempDir, packageId);
    expect(disk).toBeUndefined();
  });
});
