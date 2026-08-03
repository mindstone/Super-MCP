import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { SimpleOAuthProvider } from "../simple.js";

vi.mock("../../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// REBEL-7F9 Stage 2a (docs/plans/260803_rebel-7f9-swifteq-oauth-callback):
// the persisted-DCR-client staleness compare moves from a port-only `[0] ===`
// check to a FULL-URI comparison: the saved client is stale when its normalized
// redirect_uris (localhost ≡ 127.0.0.1 ≡ [::1]) does NOT include the current
// redirectUrl, or when a client file exists on disk but its redirect_uris is
// missing/unparseable. A client file ABSENT from disk is NOT stale (fresh
// registration or static-credential provider — the latter synthesizes
// redirect_uris in memory and must never have its working tokens invalidated).

const PACKAGE_ID = "Swifteq-test";

let tokenDir: string;

function clientFilePath(): string {
  return path.join(tokenDir, `${PACKAGE_ID}_client.json`);
}

function tokenFilePath(): string {
  return path.join(tokenDir, `${PACKAGE_ID}_tokens.json`);
}

async function writeClientFile(contents: unknown): Promise<void> {
  await fs.writeFile(
    clientFilePath(),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

async function writeTokenFile(): Promise<void> {
  await fs.writeFile(tokenFilePath(), JSON.stringify({ access_token: "tok", refresh_token: "ref" }));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-staleness-"));
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
});

afterEach(async () => {
  delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  await fs.rm(tokenDir, { recursive: true, force: true });
});

describe("checkAndInvalidateOnPortMismatch — full-URI staleness", () => {
  it("invalidates when the saved registration has the SAME PORT but a different path", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: ["http://localhost:5173/callback"],
    });
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(true);
    expect(await fileExists(clientFilePath())).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(false);
  });

  it("does NOT invalidate when the current redirectUrl appears at a NON-ZERO position (RFC 7591 echo order not guaranteed)", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: [
        "http://localhost:9999/oauth/callback",
        "http://localhost:5173/oauth/callback",
      ],
    });
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(false);
    expect(await fileExists(clientFilePath())).toBe(true);
    expect(await fileExists(tokenFilePath())).toBe(true);
  });

  it("treats loopback spellings as equivalent (127.0.0.1 / [::1] ≡ localhost) — no per-launch invalidation", async () => {
    for (const uri of [
      "http://127.0.0.1:5173/oauth/callback",
      "http://[::1]:5173/oauth/callback",
    ]) {
      await writeClientFile({ client_id: "cid", redirect_uris: [uri] });
      await writeTokenFile();
      const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
      await provider.initialize();

      const invalidated = await provider.checkAndInvalidateOnPortMismatch();

      expect(invalidated).toBe(false);
      expect(await fileExists(clientFilePath())).toBe(true);
    }
  });

  it("still invalidates on a plain port mismatch (classic case)", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: ["http://localhost:8080/oauth/callback"],
    });
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(true);
    expect(await fileExists(clientFilePath())).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(false);
  });

  it("client file PRESENT but redirect_uris missing → stale (re-register)", async () => {
    await writeClientFile({ client_id: "cid" });
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(true);
    expect(await fileExists(clientFilePath())).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(false);
  });

  it("client file PRESENT but unparseable → stale (re-register)", async () => {
    await writeClientFile("{ not json");
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(true);
    expect(await fileExists(clientFilePath())).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(false);
  });

  it("client file ABSENT → NOT stale (fresh registration path)", async () => {
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173);
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(true);
  });

  it("static-credential provider is NEVER stale and never invalidates working tokens", async () => {
    // Residual client file from a previous life, pointing at a different port.
    // Static-cred connectors synthesize redirect_uris in memory from the
    // current port (simple.ts constructor) and deliberately skip the disk
    // client load — classifying them stale would destroy WORKING tokens.
    await writeClientFile({
      client_id: "residual",
      redirect_uris: ["http://localhost:9999/oauth/callback"],
    });
    await writeTokenFile();
    const provider = new SimpleOAuthProvider(PACKAGE_ID, 5173, {
      clientId: "static-id",
      clientSecret: "static-secret",
    });
    await provider.initialize();

    const invalidated = await provider.checkAndInvalidateOnPortMismatch();

    expect(invalidated).toBe(false);
    expect(await fileExists(tokenFilePath())).toBe(true);
  });
});

describe("getSavedClientPort — loopback scan", () => {
  it("scans redirect_uris for the first LOOPBACK URI rather than trusting [0]", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: [
        "https://example.com/oauth/callback",
        "http://localhost:8080/oauth/callback",
      ],
    });

    const port = await SimpleOAuthProvider.getSavedClientPort(PACKAGE_ID);

    expect(port).toBe(8080);
  });

  it("returns the [0] port when it is loopback (common case)", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: ["http://localhost:5177/oauth/callback"],
    });

    expect(await SimpleOAuthProvider.getSavedClientPort(PACKAGE_ID)).toBe(5177);
  });

  it("accepts 127.0.0.1 loopback spellings", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:5174/oauth/callback"],
    });

    expect(await SimpleOAuthProvider.getSavedClientPort(PACKAGE_ID)).toBe(5174);
  });

  it("returns undefined when no loopback URI is present", async () => {
    await writeClientFile({
      client_id: "cid",
      redirect_uris: ["https://example.com/oauth/callback"],
    });

    expect(await SimpleOAuthProvider.getSavedClientPort(PACKAGE_ID)).toBeUndefined();
  });

  it("returns undefined when no client file exists", async () => {
    expect(await SimpleOAuthProvider.getSavedClientPort(PACKAGE_ID)).toBeUndefined();
  });
});
