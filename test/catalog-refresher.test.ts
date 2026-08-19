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

type Refresher = {
  start(): void;
  scheduleRefresh(packageId: string): void;
  dispose(): void | Promise<void>;
};

type CatalogRefresherConstructor = new (
  catalog: Catalog,
  registry: PackageRegistry,
  options?: {
    concurrency?: number;
    refreshTimeoutMs?: number;
    now?: () => number;
    random?: () => number;
  },
) => Refresher;

async function loadCatalogRefresher(): Promise<CatalogRefresherConstructor> {
  const modulePath = "../src/catalogRefresher.js";
  const module = await import(modulePath) as { CatalogRefresher: CatalogRefresherConstructor };
  return module.CatalogRefresher;
}

function packageConfig(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    base_url: `https://${id}.example.test/mcp`,
    visibility: "default",
  };
}

function clientWithTools(toolName: string): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: toolName, inputSchema: { type: "object" } },
    ]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
  };
}

function registryStub(
  packages: PackageConfig[],
  getClient: (packageId: string) => Promise<McpClient>,
): PackageRegistry {
  return {
    getPackages: vi.fn().mockReturnValue(packages),
    getPackage: vi.fn((packageId: string) =>
      packages.find((pkg) => pkg.id === packageId)),
    getClient: vi.fn(getClient),
  } as unknown as PackageRegistry;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("CatalogRefresher lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.fails("R8b: executes retry timers, single-flights concurrent refreshes, and disposes safely in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    const CatalogRefresher = await loadCatalogRefresher();
    const pkg = packageConfig("records");
    const inFlightRecovery = deferred<McpClient>();
    let callCount = 0;
    const registry = registryStub([pkg], async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("temporary connect failure");
      return inFlightRecovery.promise;
    });
    const catalog = new Catalog(registry);
    const refresher = new CatalogRefresher(catalog, registry, {
      concurrency: 1,
      refreshTimeoutMs: 60_000,
      now: () => Date.now(),
      random: () => 0.5,
    });

    refresher.start();
    await flushMicrotasks();
    expect(callCount).toBe(1);
    expect(catalog.getPackageStatus(pkg.id)).toBe("error");

    expect(refresher.scheduleRefresh(pkg.id)).toBeUndefined();
    expect(refresher.scheduleRefresh(pkg.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(14_999);
    await flushMicrotasks();
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(callCount).toBe(2);

    const disposePromise = Promise.resolve(refresher.dispose());
    inFlightRecovery.resolve(clientWithTools("find_records"));
    await disposePromise;
    await flushMicrotasks();
    expect(catalog.getPackageStatus(pkg.id)).toBe("error");

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(callCount).toBe(2);
  });

  it.fails("R15: a healthy package reaches ready while the warm-sweep budget is saturated by hung packages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    const CatalogRefresher = await loadCatalogRefresher();
    const hungA = packageConfig("hung-a");
    const hungB = packageConfig("hung-b");
    const healthy = packageConfig("healthy");
    const neverConnects = new Promise<McpClient>(() => {});
    const registry = registryStub([hungA, hungB, healthy], async (packageId) =>
      packageId === healthy.id ? clientWithTools("find_records") : neverConnects);
    const catalog = new Catalog(registry);
    const refresher = new CatalogRefresher(catalog, registry, {
      concurrency: 2,
      refreshTimeoutMs: 100,
      now: () => Date.now(),
      random: () => 0.5,
    });

    refresher.start();
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(catalog.getPackageStatus(healthy.id)).toBe("ready");
    expect(catalog.countTools(healthy.id)).toBe(1);
    await refresher.dispose();
  });
});
