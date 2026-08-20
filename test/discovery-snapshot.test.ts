import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { Catalog } from "../src/catalog.js";
import { handleListToolPackages } from "../src/handlers/listToolPackages.js";
import { handleGetHelp } from "../src/handlers/getHelp.js";
import {
  handleSearchTools,
  invalidateSearchCache,
} from "../src/handlers/searchTools.js";
import type { PackageRegistry } from "../src/registry.js";
import { registerHttpApiRoutes } from "../src/server.js";
import type { McpClient, PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function packageConfig(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    base_url: `https://${id}.example.test/mcp`,
    visibility: "default",
  };
}

function clientWithTools(tools: unknown[]): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
  };
}

function registryStub(
  packages: PackageConfig[],
  getClient: (packageId: string) => Promise<McpClient>,
): PackageRegistry {
  const registry = {
    getPackages: vi.fn().mockReturnValue(packages),
    getPackage: vi.fn((packageId: string) =>
      packages.find((pkg) => pkg.id === packageId)),
    getClient: vi.fn(getClient),
    healthCheck: vi.fn(async (packageId: string) => {
      const client = await registry.getClient(packageId);
      const health = await client.healthCheck?.();
      return health === "ok" ? "ok" : "unavailable";
    }),
  };
  return registry as unknown as PackageRegistry;
}

async function raceAgainstSentinel<T>(promise: Promise<T>): Promise<
  | { kind: "settled"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "sentinel" }
> {
  const observed = promise.then(
    (value) => ({ kind: "settled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  const sentinel = new Promise<{ kind: "sentinel" }>((resolve) => {
    setTimeout(() => resolve({ kind: "sentinel" }), 250);
  });

  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(250);
  return Promise.race([observed, sentinel]);
}

function parseTextResult(result: unknown): Record<string, unknown> {
  const block = result as { content?: Array<{ text?: string }> };
  const text = block.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

function invokeCatalogEndpoint(
  registry: PackageRegistry,
  catalog: Catalog,
  path: "/api/tools" | "/api/tools/manifest" = "/api/tools",
  query: Record<string, string> = { wait_for_snapshot_ms: "50" },
  catalogRefresher?: {
    scheduleRefresh(packageId: string): void;
    whenCurrentGenerationReady(): Promise<void>;
  },
) {
  const app = express();
  app.use(express.json());
  registerHttpApiRoutes(app, {
    registry,
    catalog,
    catalogRefresher,
    dnsRebindingGuard: (_request, _response, next) => next(),
  });

  const router = (app as express.Express & {
    router: {
      stack: Array<{
        route?: {
          path: string;
          stack: Array<{ handle: express.RequestHandler }>;
        };
      }>;
    };
  }).router;
  const route = router.stack.find((layer) => layer.route?.path === path)?.route;
  const handler = route?.stack[route.stack.length - 1]?.handle;
  if (!handler) throw new Error(`${path} route was not registered`);

  return new Promise<{ statusCode: number; payload: Record<string, unknown> }>((resolve, reject) => {
    let statusCode = 200;
    const response = {
      status(code: number) {
        statusCode = code;
        return response;
      },
      setHeader: vi.fn(),
      json(payload: Record<string, unknown>) {
        resolve({ statusCode, payload });
        return response;
      },
    } as unknown as express.Response;
    const request = {
      query,
    } as unknown as express.Request;

    void Promise.resolve(handler(request, response, reject)).catch(reject);
  });
}

describe("snapshot-only discovery", () => {
  afterEach(() => {
    invalidateSearchCache();
    vi.useRealTimers();
  });

  it("R4: list_tool_packages settles before a hung connect and reports every package with retry state", async () => {
    vi.useFakeTimers();
    const packages = [packageConfig("alpha"), packageConfig("beta")];
    const neverConnects = new Promise<McpClient>(() => {});
    const registry = registryStub(packages, async () => neverConnects);
    const catalog = new Catalog(registry);

    const outcome = await raceAgainstSentinel(handleListToolPackages(
      { safe_only: true, limit: 100, include_health: true },
      registry,
      catalog,
    ));

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;

    const payload = parseTextResult(outcome.value);
    const packageRows = payload.packages as Array<Record<string, unknown>>;
    expect(packageRows.map((row) => row.package_id)).toEqual(["alpha", "beta"]);
    expect(packageRows.every((row) => typeof row.catalog_status === "string")).toBe(true);
    expect(packageRows.every((row) => "retry_in_ms" in row)).toBe(true);
  });

  it("R5: search_tools returns healthy tools and names a hung package as unavailable", async () => {
    vi.useFakeTimers();
    const healthy = packageConfig("healthy");
    const hung = packageConfig("hung");
    const neverConnects = new Promise<McpClient>(() => {});
    const healthyClient = clientWithTools([
      {
        name: "find_records",
        description: "Find records",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        name: "list_records",
        description: "List records",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "count_records",
        description: "Count records",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const registry = registryStub([healthy, hung], async (packageId) =>
      packageId === healthy.id ? healthyClient : neverConnects);
    const catalog = new Catalog(registry);
    await catalog.refreshPackage(healthy.id);

    const outcome = await raceAgainstSentinel(handleSearchTools(
      { query: "find records", limit: 5 },
      registry,
      catalog,
    ));

    if (outcome.kind === "rejected") throw outcome.error;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;

    const payload = parseTextResult(outcome.value);
    const results = payload.results as Array<Record<string, unknown>>;
    const unavailable = payload.unavailable_packages as Array<Record<string, unknown>>;
    expect(results.some((result) => result.package_id === healthy.id)).toBe(true);
    expect(unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ package_id: hung.id }),
    ]));
  });

  it("package help is a passive snapshot read while the package is unreachable", async () => {
    vi.useFakeTimers();
    const pkg = packageConfig("hung");
    const registry = registryStub([pkg], async () => new Promise<McpClient>(() => {}));
    const catalog = new Catalog(registry);
    const refreshScheduler = { scheduleRefresh: vi.fn() };

    const outcome = await raceAgainstSentinel(handleGetHelp(
      { package_id: pkg.id },
      registry,
      catalog,
      refreshScheduler,
    ));

    if (outcome.kind === "rejected") throw outcome.error;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.value.content[0].text).toContain("catalog snapshot");
    expect(registry.getClient).not.toHaveBeenCalled();
    expect(refreshScheduler.scheduleRefresh).toHaveBeenCalledWith(pkg.id);
  });

  it("R12 primitive: bounded REST readiness returns an explicit incomplete snapshot on timeout", async () => {
    vi.useFakeTimers();
    const pkg = packageConfig("hung");
    const neverConnects = new Promise<McpClient>(() => {});
    const registry = registryStub([pkg], async () => neverConnects);
    const catalog = new Catalog(registry);
    const catalogRefresher = {
      scheduleRefresh: vi.fn(),
      whenCurrentGenerationReady: vi.fn(() => new Promise<void>(() => {})),
    };
    let settled = false;
    const responsePromise = invokeCatalogEndpoint(
      registry,
      catalog,
      "/api/tools",
      { wait_for_snapshot_ms: "50" },
      catalogRefresher,
    )
      .then((response) => {
        settled = true;
        return response;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(catalogRefresher.whenCurrentGenerationReady).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.payload.snapshot_complete).toBe(false);
    expect(response.payload.degraded_packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ package_id: pkg.id }),
    ]));
  });

  it("R12 primitive: bounded REST readiness returns the completed current-generation snapshot", async () => {
    vi.useFakeTimers();
    const pkg = packageConfig("warming");
    const registry = registryStub([pkg], async () => clientWithTools([]));
    const catalog = new Catalog(registry);
    const catalogRefresher = {
      scheduleRefresh: vi.fn(),
      whenCurrentGenerationReady: vi.fn(() => new Promise<void>((resolve) => {
        setTimeout(() => {
          const generation = catalog.beginRefresh(pkg.id, "startup");
          catalog.commitReady(pkg.id, [{ name: "ready_tool", inputSchema: { type: "object" } }], generation);
          resolve();
        }, 20);
      })),
    };

    const responsePromise = invokeCatalogEndpoint(
      registry,
      catalog,
      "/api/tools",
      { wait_for_snapshot_ms: "50" },
      catalogRefresher,
    );
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.payload.snapshot_complete).toBe(true);
    expect(response.payload.degraded_packages).toEqual([]);
    expect(response.payload.tool_count).toBe(1);
  });

  it.each(["/api/tools", "/api/tools/manifest"] as const)(
    "%s returns an incomplete snapshot immediately by default without connecting",
    async (path) => {
      vi.useFakeTimers();
      const pkg = packageConfig("hung");
      const registry = registryStub([pkg], async () => new Promise<McpClient>(() => {}));
      const catalog = new Catalog(registry);
      const catalogRefresher = {
        scheduleRefresh: vi.fn(),
        whenCurrentGenerationReady: vi.fn(() => new Promise<void>(() => {})),
      };

      const outcome = await raceAgainstSentinel(invokeCatalogEndpoint(
        registry,
        catalog,
        path,
        {},
        catalogRefresher,
      ));

      if (outcome.kind === "rejected") throw outcome.error;
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(registry.getClient).not.toHaveBeenCalled();
      expect(catalogRefresher.whenCurrentGenerationReady).not.toHaveBeenCalled();
      expect(outcome.value.payload.snapshot_complete).toBe(false);
      expect(outcome.value.payload.degraded_packages).toEqual(expect.arrayContaining([
        expect.objectContaining({ package_id: pkg.id }),
      ]));
    },
  );
});
