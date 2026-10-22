import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The startup hold (SUPER_MCP_HOLD_RENEWAL) must be on disk before catalog
// discovery can connect a package and spend its refresh token. The registry,
// catalog, refresher and stdio transport are stubbed; the hold itself is real.

const observed = vi.hoisted(() => ({ heldAtDiscovery: undefined as unknown, tokenFile: "" }));

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), setLevel: vi.fn() }),
}));
vi.mock("../src/registry.js", () => ({
  PackageRegistry: {
    fromConfigFiles: vi.fn(async () => ({ startIdleReaper: vi.fn(), getPackages: () => [], getPackage: () => undefined })),
  },
}));
vi.mock("../src/catalog.js", () => ({ Catalog: class {} }));
vi.mock("../src/catalogRefresher.js", () => ({
  CatalogRefresher: class {
    start(): void {
      observed.heldAtDiscovery = JSON.parse(fs.readFileSync(observed.tokenFile, "utf8")).__superMcpRenewalHeldByHost;
    }
    async dispose(): Promise<void> {}
  },
}));
vi.mock("../src/configWatcher.js", () => ({
  ConfigWatcher: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
  handleConfigurationChange: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

import { startServer } from "../src/server.js";

describe("startup renewal hold", () => {
  let tempDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "super-mcp-startup-hold-"));
    observed.tokenFile = path.join(tempDir, "Acme-notes_tokens.json");
    fs.writeFileSync(
      observed.tokenFile,
      JSON.stringify({ access_token: "access-a", token_type: "Bearer", refresh_token: "refresh-r0" }),
    );
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("is applied before catalog discovery starts", async () => {
    process.env.SUPER_MCP_HOLD_RENEWAL = "Acme-notes";
    await startServer({ configPaths: [path.join(tempDir, "config.json")], transport: "stdio" });
    expect(observed.heldAtDiscovery).toBe(true);
  });
});
