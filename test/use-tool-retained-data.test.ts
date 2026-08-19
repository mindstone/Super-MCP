import { beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import type { PackageRegistry } from "../src/registry.js";
import { SecurityPolicy, setSecurityPolicy } from "../src/security.js";
import { ERROR_CODES, type McpClient, type PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PACKAGE: PackageConfig = {
  id: "work-account-a",
  name: "Work account A",
  transport: "http",
  base_url: "https://work.example.test/mcp",
  visibility: "default",
};

const TOOL = {
  name: "do_work",
  description: "Do work",
  inputSchema: {
    type: "object",
    properties: { task: { type: "string" } },
    required: ["task"],
  },
};

function client(): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([TOOL]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
  };
}

function harness() {
  const catalogClient = client();
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
  const registry = {
    getPackages: vi.fn().mockReturnValue([PACKAGE]),
    getPackage: vi.fn().mockReturnValue(PACKAGE),
    findPackagesByAlias: vi.fn().mockReturnValue([]),
    getClient: vi.fn().mockResolvedValue(catalogClient),
    callTool,
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const catalog = new Catalog(registry);
  const validator = {
    validate: vi.fn().mockReturnValue({
      valid: true,
      errors: [],
      strippedArgs: false,
    }),
  };
  return { catalog, callTool, registry, validator };
}

async function preload(catalog: Catalog): Promise<void> {
  await catalog.refreshPackage(PACKAGE.id);
  expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
}

function cacheEntry(catalog: Catalog): Record<string, unknown> {
  const cache = (catalog as unknown as {
    cache: Map<string, Record<string, unknown>>;
  }).cache;
  const entry = cache.get(PACKAGE.id);
  expect(entry).toBeDefined();
  return entry!;
}

const INPUT = {
  package_id: PACKAGE.id,
  tool_id: TOOL.name,
  args: { task: "draft" },
};

describe("use_tool retained-data execution guard", () => {
  beforeEach(() => {
    setSecurityPolicy(new SecurityPolicy());
  });

  it("R17a: an unsuccessful bounded refresh cannot execute a retained schema", async () => {
    const { catalog, callTool, registry, validator } = harness();
    await preload(catalog);
    vi.spyOn(catalog, "ensurePackageLoaded").mockImplementation(async () => {
      const entry = cacheEntry(catalog);
      entry.status = "error";
      entry.lastError = "temporary connect failure";
    });

    await expect(handleUseTool(INPUT, registry, catalog, validator)).rejects.toMatchObject({
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      data: { package_id: PACKAGE.id, status: "error" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("R17b: a successful refresh that removes the tool returns TOOL_NOT_FOUND", async () => {
    const { catalog, callTool, registry, validator } = harness();
    await preload(catalog);
    vi.spyOn(catalog, "ensurePackageLoaded").mockImplementation(async () => {
      const entry = cacheEntry(catalog);
      entry.status = "ready";
      entry.tools = [];
    });

    await expect(handleUseTool(INPUT, registry, catalog, validator)).rejects.toMatchObject({
      code: ERROR_CODES.TOOL_NOT_FOUND,
      data: { package_id: PACKAGE.id, tool_id: TOOL.name },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("R17c: execution proceeds from the current ready catalog", async () => {
    const { catalog, callTool, registry, validator } = harness();
    await preload(catalog);

    await expect(handleUseTool(INPUT, registry, catalog, validator)).resolves.toMatchObject({
      isError: false,
    });
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(PACKAGE.id, TOOL.name, INPUT.args);
  });
});
