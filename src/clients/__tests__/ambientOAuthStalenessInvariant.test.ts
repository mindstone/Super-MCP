import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { HttpMcpClient } from "../httpClient.js";
import { SimpleOAuthProvider } from "../../auth/providers/simple.js";
import type { PackageConfig } from "../../types.js";

vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// REBEL-7F9 Stage 2a INVARIANT (docs/plans/260803_rebel-7f9-swifteq-oauth-callback,
// arbitrator recall#2 F5): the broadened full-URI staleness comparison must
// fire ONLY on the explicit authenticate path (forceOAuth=true). The
// ambient/refresh path (initializeOAuthIfNeeded(false) → RefreshOnlyOAuthProvider)
// must NEVER invalidate — a 5173-defaulted ambient client judging an
// 8080-saved connector stale would delete the client registration AND tokens
// on disk = silent mass re-auth across the fleet. This pins the existing
// gate so Stage 2a's broadened rule cannot leak onto the ambient path.

const PACKAGE_ID = "Ambient-invariant-test";

let tokenDir: string;

function clientFilePath(): string {
  return path.join(tokenDir, `${PACKAGE_ID}_client.json`);
}

function tokenFilePath(): string {
  return path.join(tokenDir, `${PACKAGE_ID}_tokens.json`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function createClient(): HttpMcpClient {
  const config: PackageConfig = {
    id: PACKAGE_ID,
    name: PACKAGE_ID,
    transport: "http",
    base_url: "https://mcp.example.com/mcp",
    oauth: true,
    visibility: "default",
  } as PackageConfig;
  return new HttpMcpClient(PACKAGE_ID, config);
}

beforeEach(async () => {
  tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-ambient-invariant-"));
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
  // A client registration that is stale under the BROADENED rule
  // (redirect_uris missing → stale) on a non-5173 port — the exact shape an
  // ambient 5173-defaulted client must never act on.
  await fs.writeFile(
    clientFilePath(),
    JSON.stringify({ client_id: "cid", redirect_uris: ["http://localhost:8080/oauth/callback"] }),
  );
  await fs.writeFile(
    tokenFilePath(),
    JSON.stringify({ access_token: "tok", refresh_token: "ref" }),
  );
});

afterEach(async () => {
  delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  await fs.rm(tokenDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ambient/refresh path never invalidates on staleness grounds", () => {
  it("initializeOAuthIfNeeded(false) does NOT consult the staleness check and leaves disk untouched", async () => {
    const spy = vi.spyOn(SimpleOAuthProvider.prototype, "checkAndInvalidateOnPortMismatch");
    const client = createClient();

    await (client as any).initializeOAuthIfNeeded(false);

    expect(spy).not.toHaveBeenCalled();
    expect(await fileExists(clientFilePath())).toBe(true);
    expect(await fileExists(tokenFilePath())).toBe(true);
  });

  it("control: initializeOAuthIfNeeded(true) DOES run the staleness check (non-vacuous gate pin)", async () => {
    const spy = vi.spyOn(SimpleOAuthProvider.prototype, "checkAndInvalidateOnPortMismatch");
    const client = createClient();

    await (client as any).initializeOAuthIfNeeded(true);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
