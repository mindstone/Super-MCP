import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";
import type { McpClient, PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PACKAGE: PackageConfig = {
  id: "records-account-a",
  name: "Records account A",
  transport: "http",
  base_url: "https://records.example.test/mcp",
  visibility: "default",
};

const TOOL = {
  name: "find_records",
  description: "Find records",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  _meta: {
    ui: { resourceUri: "ui://records/viewer.html" },
  },
};

function client(listTools: () => Promise<unknown[]>): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn(listTools),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
  };
}

function createRegistry(getClient: () => Promise<McpClient>): PackageRegistry {
  return {
    getPackages: vi.fn().mockReturnValue([PACKAGE]),
    getPackage: vi.fn().mockReturnValue(PACKAGE),
    getClient: vi.fn(getClient),
  } as unknown as PackageRegistry;
}

describe("Catalog last-known-good retention", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.fails("R6: retains tools and URI ownership while degraded without advertising them or churning the etag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    let currentClient = client(async () => [TOOL]);
    const registry = createRegistry(async () => currentClient);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage(PACKAGE.id);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
    expect(catalog.getPackageForResourceUri("ui://records/viewer.html")).toBe(PACKAGE.id);

    const repeatedFailure = new Error("connect timeout");
    currentClient = client(async () => {
      throw repeatedFailure;
    });

    vi.setSystemTime(new Date("2026-08-19T00:00:01.000Z"));
    await catalog.refreshPackage(PACKAGE.id);
    const firstFailureEtag = catalog.etag();

    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("error");
    expect(catalog.getCacheStats().totalTools).toBe(1);
    expect(catalog.findToolByName(TOOL.name)).toEqual([]);
    expect(catalog.paginate(PACKAGE.id).items).toEqual([]);
    expect(catalog.getPackageForResourceUri("ui://records/viewer.html")).toBeUndefined();
    const retainedUriOwners = (catalog as unknown as {
      resourceUriToPackage: Map<string, string>;
    }).resourceUriToPackage;
    expect(retainedUriOwners.get("ui://records")).toBe(PACKAGE.id);

    vi.setSystemTime(new Date("2026-08-19T00:00:02.000Z"));
    await catalog.refreshPackage(PACKAGE.id);
    expect(catalog.etag()).toBe(firstFailureEtag);
  });
});
