import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CallToolRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InvalidScopeError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Catalog } from "../src/catalog.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { PackageRegistry } from "../src/registry.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import { handleReadResource } from "../src/handlers/readResource.js";
import { handleBulkExport } from "../src/handlers/bulkExport.js";
import { SecurityPolicy, setSecurityPolicy } from "../src/security.js";
import { startServer } from "../src/server.js";
import type { McpClient, PackageConfig } from "../src/types.js";

const logger = vi.hoisted(() => ({
  setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
const handlers = vi.hoisted(() => new Map<unknown, (...args: any[]) => Promise<unknown>>());

vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<unknown>) {
      handlers.set(schema, handler);
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
vi.mock("../src/configWatcher.js", () => ({
  ConfigWatcher: class { async start() {} },
}));
vi.mock("../src/catalogRefresher.js", () => ({
  CatalogRefresher: class { start() {} },
}));

const SENTINEL = "provider-wrapped-description-sentinel";
const config: PackageConfig = {
  id: "Acme", name: "Acme", transport: "http",
  base_url: "https://mcp.example.com/mcp", visibility: "default",
};
const tool = {
  name: "read_item", description: "Read an item",
  inputSchema: { type: "object", properties: {} },
};

describe("wrapped OAuth errors at the server logging boundary", () => {
  let registry: PackageRegistry;
  let catalog: Catalog;
  let original: InvalidScopeError;

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    setSecurityPolicy(new SecurityPolicy());
    original = new InvalidScopeError(SENTINEL);
    registry = new PackageRegistry({ packages: [config] });
    const client: McpClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listTools: vi.fn(async () => [tool]),
      callTool: vi.fn().mockRejectedValue(original),
      readResource: vi.fn().mockRejectedValue(original),
    };
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    vi.spyOn(registry, "callTool").mockRejectedValue(original);
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);
    catalog = new Catalog(registry);
    await catalog.refreshPackage(config.id);
    await startServer({ configPaths: [], transport: "stdio" });
  });

  afterEach(async () => {
    await registry.closeAll();
    vi.restoreAllMocks();
  });

  function expectPrivateCause(error: unknown): void {
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({
      value: original, enumerable: false,
    });
    expect(JSON.stringify(error)).not.toContain('"cause"');
    expect({ ...(error as object) }).not.toHaveProperty("cause");
  }

  function expectSafeLogs(): void {
    expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))).not.toContain(SENTINEL);
  }

  it("preserves catalog failure text while redacting legacy and background refresh logs", async () => {
    const error = new TemporarilyUnavailableError(SENTINEL);
    vi.mocked(registry.getClient).mockRestore();
    vi.spyOn(HttpMcpClient.prototype, "connect").mockRejectedValue(error);
    const wrapped = await registry.getClient(config.id).catch((caught: unknown) => caught);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toContain(`Original error: ${SENTINEL}`);
    expect(wrapped.cause).toBe(error);

    await catalog.refreshPackage(config.id);
    expect(catalog.getPackageError(config.id)).toBe(wrapped.message);

    const { CatalogRefresher } = await vi.importActual<typeof import("../src/catalogRefresher.js")>(
      "../src/catalogRefresher.js",
    );
    const refresher = new CatalogRefresher(catalog, registry);
    try {
      refresher.start();
      await refresher.refreshNow(config.id);
      expect(catalog.getPackageDiagnostics(config.id)).toMatchObject({
        status: "error", lastError: wrapped.message,
      });
      expect(catalog.listDegraded()[0]?.lastError).toBe(wrapped.message);
      expect(logger.error.mock.calls.filter(([message]) => message === "Failed to refresh package catalog"))
        .toHaveLength(2);
      expect(logger.error).toHaveBeenCalledWith("Failed to refresh package catalog", expect.objectContaining({
        package_id: config.id, error: "temporarily_unavailable",
      }));
      expectSafeLogs();
    } finally {
      await refresher.dispose();
    }
  });

  it("keeps the tool error description and private cause while sanitizing the server log", async () => {
    const input = { package_id: config.id, tool_id: tool.name, args: {} };
    const validator = { validate: vi.fn(() => ({ valid: true, errors: [], strippedArgs: false })) };
    const wrapped = await handleUseTool(input, registry, catalog, validator).catch((error: unknown) => error);
    expect(wrapped).toMatchObject({
      message: expect.stringContaining(`❌ ${SENTINEL}`), data: { original_error: SENTINEL },
    });
    expectPrivateCause(wrapped);

    const callTool = handlers.get(CallToolRequestSchema)!;
    await expect(callTool({ params: { name: "use_tool", arguments: input } })).rejects.toMatchObject({
      message: expect.stringContaining(SENTINEL), data: { original_error: SENTINEL },
    });
    expect(logger.error).toHaveBeenCalledWith("Tool execution failed", {
      tool_name: "use_tool", error: "invalid_scope",
    });
    expectSafeLogs();
  });

  it("preserves bulk export failure diagnostics while redacting wrapped OAuth logs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-export-log-"));
    vi.stubEnv("REBEL_WORKSPACE_PATH", workspace);
    const wrapped = new Error(`Request failed: ${SENTINEL}`, { cause: original });
    vi.mocked(registry.callTool).mockRejectedValue(wrapped);
    try {
      const result = await handleBulkExport({
        package_id: config.id, tool_id: tool.name, args: {}, output_file: "items.jsonl",
      }, registry, catalog);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        status: "failed", errors: [`Page 1: ${wrapped.message}`],
      });
      expect(logger.warn).toHaveBeenCalledWith("bulk_export tool call failed", {
        package_id: config.id, tool_id: tool.name, error: "invalid_scope",
      });
      expectSafeLogs();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps the resource error message and private cause while sanitizing both resource logs", async () => {
    const input = { uri: `ui://${config.id}/item` };
    const wrapped = await handleReadResource(input, registry, catalog).catch((error: unknown) => error);
    expect(wrapped).toMatchObject({ message: `Failed to read resource from ${config.id}: ${SENTINEL}` });
    expectPrivateCause(wrapped);

    const readResource = handlers.get(ReadResourceRequestSchema)!;
    await expect(readResource({ params: input })).rejects.toMatchObject({
      message: `Failed to read resource from ${config.id}: ${SENTINEL}`,
    });
    expect(logger.error).toHaveBeenCalledWith("Resource read failed", {
      uri: input.uri, error: "invalid_scope",
    });
    expect(logger.error).toHaveBeenCalledWith("Resource read failed", {
      uri: input.uri, package_id: config.id, error: "invalid_scope",
    });
    expectSafeLogs();
  });
});
