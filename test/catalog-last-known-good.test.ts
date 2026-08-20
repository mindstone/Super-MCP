import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { buildPackageSummary } from "../src/catalogFormatters.js";
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

  it("R6: retains tools and URI ownership while degraded without advertising them or churning the etag", async () => {
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
    const retainedEmbeddingHash = catalog.computePackageEmbeddingHash(PACKAGE.id);

    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("error");
    expect(catalog.getCacheStats().totalTools).toBe(1);
    expect(catalog.findToolByName(TOOL.name)).toEqual([]);
    expect(catalog.paginate(PACKAGE.id).items).toEqual([]);
    expect(catalog.getPackageForResourceUri("ui://records/viewer.html")).toBeUndefined();
    const retainedUriOwners = (catalog as unknown as {
      resourceUriToPackage: Map<string, string>;
    }).resourceUriToPackage;
    expect(retainedUriOwners.get("ui://records")).toBe(PACKAGE.id);
    expect(retainedEmbeddingHash).not.toBe("");
    expect(buildPackageSummary(PACKAGE, catalog)).toContain(
      "degraded — showing last-known-good tools",
    );

    vi.setSystemTime(new Date("2026-08-19T00:00:02.000Z"));
    await catalog.refreshPackage(PACKAGE.id);
    expect(catalog.etag()).toBe(firstFailureEtag);
  });

  it("retains without a time ceiling and invalidates only changed or removed identities", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    let packages = [PACKAGE];
    let currentClient = client(async () => [TOOL]);
    const registry = {
      getPackages: vi.fn(() => packages),
      getPackage: vi.fn((packageId: string) =>
        packages.find((pkg) => pkg.id === packageId)),
      getClient: vi.fn(async () => currentClient),
    } as unknown as PackageRegistry;
    const catalog = new Catalog(registry);

    await catalog.refreshPackage(PACKAGE.id);
    currentClient = client(async () => {
      throw new Error("temporary failure");
    });
    await catalog.refreshPackage(PACKAGE.id);

    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    expect(catalog.getCacheStats().totalTools).toBe(1);

    catalog.setConfigurationGeneration(2, []);
    expect(catalog.getCacheStats().totalTools).toBe(1);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("error");

    packages = [{ ...PACKAGE, base_url: "https://replacement.example.test/mcp" }];
    catalog.setConfigurationGeneration(3, [PACKAGE.id]);
    expect(catalog.getCacheStats().totalTools).toBe(0);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("connecting");
    expect(catalog.getPackageForResourceUri("ui://records/viewer.html")).toBeUndefined();

    packages = [];
    catalog.setConfigurationGeneration(4, [PACKAGE.id]);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("unknown");
  });

  it("keeps last-known-good data inactive when setup becomes incomplete", async () => {
    let blocked = false;
    const registry = {
      getPackages: vi.fn(() => [PACKAGE]),
      getPackage: vi.fn(() => blocked
        ? {
            ...PACKAGE,
            setupStatus: {
              state: "blocked" as const,
              reason: "cloud_reprovision_required" as const,
            },
          }
        : PACKAGE),
      getClient: vi.fn(async () => client(async () => [TOOL])),
    } as unknown as PackageRegistry;
    const catalog = new Catalog(registry);

    await catalog.refreshPackage(PACKAGE.id);
    blocked = true;
    await catalog.refreshPackage(PACKAGE.id);

    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("setup_incomplete");
    expect(catalog.getCacheStats().totalTools).toBe(1);
    expect(catalog.paginate(PACKAGE.id).items).toEqual([]);
    expect(catalog.getPackageForResourceUri("ui://records/viewer.html")).toBeUndefined();
  });
});
