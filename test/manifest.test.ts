import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Catalog } from "../src/catalog.js";
import { registerHttpApiRoutes } from "../src/server.js";
import type { PackageConfig } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

const mockSecurityPolicy = {
  getUserDisabledSummary: vi.fn().mockReturnValue({ totalDisabled: 0 }),
  getAdminDisabledSummary: vi.fn().mockReturnValue({ totalDisabled: 0 }),
  getUserDisabledHash: vi.fn().mockReturnValue("userhash"),
  getAdminDisabledHash: vi.fn().mockReturnValue("adminhash"),
  isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
  isUserDisabled: vi.fn().mockReturnValue(false),
  isAdminDisabled: vi.fn().mockReturnValue(false),
};

vi.mock("../src/security.js", () => ({
  getSecurityPolicy: () => mockSecurityPolicy,
}));

function createMockRegistry(packages: PackageConfig[]): PackageRegistry {
  return {
    getPackages: vi.fn().mockReturnValue(packages),
    getPackage: vi.fn().mockImplementation((packageId: string) => packages.find((pkg) => pkg.id === packageId)),
    getSkippedPackages: vi.fn().mockReturnValue([]),
  } as unknown as PackageRegistry;
}

function seedCatalogPackage(
  catalog: Catalog,
  packageId: string,
  tools: Array<{
    name: string;
    description?: string;
    summary?: string;
    inputSchema?: unknown;
  }>
): void {
  (catalog as any).cache.set(packageId, {
    packageId,
    tools: tools.map((tool) => ({
      packageId,
      tool: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      summary: tool.summary,
      argsSkeleton: {},
      schemaHash: `sha256:${tool.name}`,
    })),
    lastUpdated: Date.now(),
    etag: `sha256:${packageId}`,
    status: "ready",
    lastError: undefined,
  });
}

function createRouteCatalog() {
  return {
    getPackageTools: vi.fn().mockImplementation((packageId: string) => [
      {
        packageId,
        tool: {
          name: "tool",
          description: `Description for ${packageId}`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
        summary: `Summary for ${packageId}`,
        argsSkeleton: {},
        schemaHash: `sha256:${packageId}`,
      },
    ]),
    etag: vi.fn().mockReturnValue("sha256:catalog"),
    countTools: vi.fn().mockReturnValue(1),
    computePackageEmbeddingHash: vi.fn().mockImplementation((packageId: string) => `hash-${packageId}`),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    isSnapshotComplete: vi.fn().mockReturnValue(true),
  };
}

async function startApiServer(registry: PackageRegistry, catalog: ReturnType<typeof createRouteCatalog>) {
  const app = express();
  app.use(express.json());
  registerHttpApiRoutes(app, {
    registry,
    catalog: catalog as unknown as Catalog,
    dnsRebindingGuard: (_req, _res, next) => next(),
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const httpServer = app.listen(0, "127.0.0.1", () => resolve(httpServer));
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Catalog.computePackageEmbeddingHash", () => {
  it("returns empty string for an unloaded package", () => {
    const registry = createMockRegistry([
      { id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" },
    ]);
    const catalog = new Catalog(registry);

    expect(catalog.computePackageEmbeddingHash("alpha")).toBe("");
  });

  it("returns the same deterministic hash for equivalent loaded package data", () => {
    const packages = [{ id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" }] satisfies PackageConfig[];
    const registry = createMockRegistry(packages);
    const firstCatalog = new Catalog(registry);
    const secondCatalog = new Catalog(registry);

    const toolData = [
      {
        name: "search",
        summary: "Search records",
        description: "Search records",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
      },
    ];

    seedCatalogPackage(firstCatalog, "alpha", toolData);
    seedCatalogPackage(secondCatalog, "alpha", toolData);

    const firstHash = firstCatalog.computePackageEmbeddingHash("alpha");
    const secondHash = secondCatalog.computePackageEmbeddingHash("alpha");

    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondHash).toBe(firstHash);
  });

  it("changes when tool content changes", () => {
    const registry = createMockRegistry([
      { id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" },
    ]);
    const catalog = new Catalog(registry);

    seedCatalogPackage(catalog, "alpha", [
      {
        name: "search",
        summary: "Search records",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    const before = catalog.computePackageEmbeddingHash("alpha");

    seedCatalogPackage(catalog, "alpha", [
      {
        name: "search",
        summary: "Search contacts",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    const after = catalog.computePackageEmbeddingHash("alpha");

    expect(after).not.toBe(before);
  });

  it("is stable across repeated calls with the same cached data", () => {
    const registry = createMockRegistry([
      { id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" },
    ]);
    const catalog = new Catalog(registry);

    seedCatalogPackage(catalog, "alpha", [
      {
        name: "search",
        summary: "Search records",
        inputSchema: { type: "object", properties: { limit: { type: "number" }, query: { type: "string" } } },
      },
      {
        name: "list",
        description: "List records",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const firstHash = catalog.computePackageEmbeddingHash("alpha");
    const secondHash = catalog.computePackageEmbeddingHash("alpha");

    expect(secondHash).toBe(firstHash);
  });
});

describe("/api/tools package filtering", () => {
  it("returns only the requested packages when packages filter is provided", async () => {
    const packages = [
      { id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" },
      { id: "beta", name: "Beta", transport: "stdio", visibility: "default" },
      { id: "gamma", name: "Gamma", transport: "stdio", visibility: "default" },
    ] satisfies PackageConfig[];
    const registry = createMockRegistry(packages);
    const catalog = createRouteCatalog();
    const server = await startApiServer(registry, catalog);

    try {
      const response = await fetch(`${server.baseUrl}/api/tools?packages=beta,gamma`);
      const body = await response.json();

      expect(response.ok).toBe(true);
      expect(body.package_count).toBe(2);
      expect(body.tools.map((tool: { package_id: string }) => tool.package_id)).toEqual(["beta", "gamma"]);
      expect(catalog.getPackageTools).toHaveBeenCalledTimes(2);
      expect(catalog.getPackageTools).toHaveBeenCalledWith("beta");
      expect(catalog.getPackageTools).toHaveBeenCalledWith("gamma");
    } finally {
      await server.close();
    }
  });

  it("returns all packages when no filter is provided", async () => {
    const packages = [
      { id: "alpha", name: "Alpha", transport: "stdio", visibility: "default" },
      { id: "beta", name: "Beta", transport: "stdio", visibility: "default" },
      { id: "gamma", name: "Gamma", transport: "stdio", visibility: "default" },
    ] satisfies PackageConfig[];
    const registry = createMockRegistry(packages);
    const catalog = createRouteCatalog();
    const server = await startApiServer(registry, catalog);

    try {
      const response = await fetch(`${server.baseUrl}/api/tools`);
      const body = await response.json();

      expect(response.ok).toBe(true);
      expect(body.package_count).toBe(3);
      expect(body.tools.map((tool: { package_id: string }) => tool.package_id)).toEqual(["alpha", "beta", "gamma"]);
      expect(catalog.getPackageTools).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });
});
