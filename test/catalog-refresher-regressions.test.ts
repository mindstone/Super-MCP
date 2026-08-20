import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { CatalogRefresher } from "../src/catalogRefresher.js";
import { PackageRegistry } from "../src/registry.js";
import type {
  ConnectOutcome,
  McpClient,
  PackageConfig,
} from "../src/types.js";

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
  inputSchema: { type: "object" },
};

function packageConfig(id: string): PackageConfig {
  return {
    ...PACKAGE,
    id,
    name: id,
    base_url: `https://${id}.example.test/mcp`,
  };
}

function clientWithTools(
  tools: unknown[] = [TOOL],
  callTool: McpClient["callTool"] = vi.fn().mockResolvedValue({ content: [] }),
): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool,
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
  };
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

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function seedReady(catalog: Catalog, packageId: string, tools: unknown[] = [TOOL]): void {
  const generation = catalog.beginRefresh(packageId);
  expect(catalog.commitReady(packageId, tools, generation)).toBe(true);
}

function registryStub(
  packages: PackageConfig[],
  connect: (
    packageId: string,
    options?: { forceReconnect?: boolean },
  ) => Promise<ConnectOutcome>,
): {
  registry: PackageRegistry;
  connectForCatalog: ReturnType<typeof vi.fn>;
} {
  const connectForCatalog = vi.fn(connect);
  const registry = {
    getPackages: vi.fn().mockReturnValue(packages),
    getPackage: vi.fn((packageId: string) =>
      packages.find((pkg) => pkg.id === packageId)),
    connectForCatalog,
    subscribeLifecycle: vi.fn(() => () => undefined),
  } as unknown as PackageRegistry;
  return { registry, connectForCatalog };
}

describe("CatalogRefresher regression coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("adopts client-created and authenticated lifecycle events without forced eviction", async () => {
    const registry = new PackageRegistry({ packages: [PACKAGE] });
    const explicitClient = clientWithTools();
    const registryInternals = registry as unknown as {
      clients: Map<string, McpClient>;
      createAndConnectClient(
        packageId: string,
        config: PackageConfig,
      ): Promise<ConnectOutcome>;
    };
    vi.spyOn(registryInternals, "createAndConnectClient").mockResolvedValue({
      kind: "connected",
      client: explicitClient,
    });
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry);
    refresher.start();
    catalog.clearPackage(PACKAGE.id);

    const returnedClient = await registry.getClient(PACKAGE.id);
    await flushMicrotasks();

    expect(returnedClient).toBe(explicitClient);
    expect(explicitClient.close).not.toHaveBeenCalled();
    expect(registryInternals.clients.get(PACKAGE.id)).toBe(explicitClient);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");

    registry.notifyAuthOutcome(PACKAGE.id, "auth_required");
    catalog.clearPackage(PACKAGE.id);
    await expect(registry.getClient(PACKAGE.id)).resolves.toBe(explicitClient);
    await flushMicrotasks();

    expect(explicitClient.close).not.toHaveBeenCalled();
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
    await refresher.dispose();
  });

  it("does not let a background forced refresh close a client during explicit tool execution", async () => {
    const registry = new PackageRegistry({ packages: [PACKAGE] });
    const toolResult = deferred<unknown>();
    const callStarted = deferred<void>();
    const activeClient = clientWithTools(
      [TOOL],
      vi.fn(() => {
        callStarted.resolve();
        return toolResult.promise;
      }),
    );
    const replacementClient = clientWithTools();
    const registryInternals = registry as unknown as {
      clients: Map<string, McpClient>;
      createAndConnectClient(
        packageId: string,
        config: PackageConfig,
      ): Promise<ConnectOutcome>;
    };
    registryInternals.clients.set(PACKAGE.id, activeClient);
    vi.spyOn(registryInternals, "createAndConnectClient").mockResolvedValue({
      kind: "connected",
      client: replacementClient,
    });
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry);
    refresher.start();

    const explicitCall = registry.callTool(PACKAGE.id, TOOL.name, {});
    await callStarted.promise;
    refresher.notify(PACKAGE.id, "authentication");
    await flushMicrotasks();

    expect(activeClient.close).not.toHaveBeenCalled();

    toolResult.resolve({ content: [{ type: "text", text: "done" }] });
    await explicitCall;
    await flushMicrotasks(24);

    expect(activeClient.close).toHaveBeenCalledOnce();
    await refresher.dispose();
  });

  it("treats connecting as immediately due so clearPackage cannot wedge discovery", async () => {
    const client = clientWithTools();
    const { registry, connectForCatalog } = registryStub(
      [PACKAGE],
      async () => ({ kind: "connected", client }),
    );
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry, {
      now: () => 1_000,
    });
    refresher.start();
    catalog.clearPackage(PACKAGE.id);

    expect(catalog.getRetryHint(PACKAGE.id, 1_000)).toMatchObject({
      retryAt: 1_000,
      retryInMs: 0,
    });
    await catalog.ensurePackageLoaded(PACKAGE.id);

    expect(connectForCatalog).toHaveBeenCalledOnce();
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
    await refresher.dispose();
  });

  it("does not schedule permanently failed packages whose retry hint is null", async () => {
    const client = clientWithTools();
    const { registry, connectForCatalog } = registryStub(
      [PACKAGE],
      async () => ({ kind: "connected", client }),
    );
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry, {
      now: () => 1_000,
    });
    refresher.start();
    const generation = catalog.beginRefresh(PACKAGE.id);
    catalog.commitFailure(PACKAGE.id, generation, {
      status: "error",
      lastError: "command not found",
      failureClass: "permanent",
      nextRetryAt: null,
      nextAuthProbeAt: null,
    });

    refresher.scheduleRefresh(PACKAGE.id);
    await flushMicrotasks();

    expect(connectForCatalog).not.toHaveBeenCalled();
    await refresher.dispose();
  });

  it("queues one forced successor when explicit refresh joins a passive refresh", async () => {
    const firstAttempt = deferred<ConnectOutcome>();
    const recoveredClient = clientWithTools();
    let attempt = 0;
    const { registry, connectForCatalog } = registryStub(
      [PACKAGE],
      async () => {
        attempt += 1;
        return attempt === 1
          ? firstAttempt.promise
          : { kind: "connected", client: recoveredClient };
      },
    );
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry, {
      now: () => 1_000,
      random: () => 0.5,
    });
    refresher.start();
    const generation = catalog.beginRefresh(PACKAGE.id);
    catalog.commitFailure(PACKAGE.id, generation, {
      status: "error",
      lastError: "temporary failure",
      failureClass: "timeout",
      nextRetryAt: 1_000,
      nextAuthProbeAt: null,
    });

    const passiveRefresh = refresher.refreshNow(PACKAGE.id, { reason: "passive" });
    await flushMicrotasks();
    expect(connectForCatalog).toHaveBeenCalledOnce();
    const forcedRefresh = refresher.refreshNow(PACKAGE.id, {
      forceReconnect: true,
      reason: "explicit",
    });
    firstAttempt.resolve({
      kind: "transient_failure",
      failureClass: "timeout",
      error: new Error("temporary failure"),
    });

    await Promise.all([passiveRefresh, forcedRefresh]);

    expect(connectForCatalog).toHaveBeenCalledTimes(2);
    expect(connectForCatalog.mock.calls.map((call) => call[1]?.forceReconnect)).toEqual([
      false,
      true,
    ]);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
    await refresher.dispose();
  });

  it("re-enqueues an in-flight refresh when the configuration generation advances", async () => {
    const firstAttempt = deferred<ConnectOutcome>();
    const client = clientWithTools();
    let attempt = 0;
    const { registry, connectForCatalog } = registryStub(
      [PACKAGE],
      async () => {
        attempt += 1;
        return attempt === 1
          ? firstAttempt.promise
          : { kind: "connected", client };
      },
    );
    const catalog = new Catalog(registry);
    const refresher = new CatalogRefresher(catalog, registry);
    refresher.start();
    await flushMicrotasks();
    expect(connectForCatalog).toHaveBeenCalledOnce();

    refresher.configurationChanged();
    firstAttempt.resolve({ kind: "connected", client });
    await flushMicrotasks(24);

    expect(connectForCatalog).toHaveBeenCalledTimes(2);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");
    expect(catalog.getRefreshInFlight(PACKAGE.id)).toBe(false);
    await refresher.dispose();
  });

  it("re-arms readiness instead of repeatedly polling a resolved promise", async () => {
    const { registry } = registryStub(
      [PACKAGE],
      async () => ({ kind: "connected", client: clientWithTools() }),
    );
    const catalog = new Catalog(registry);
    seedReady(catalog, PACKAGE.id);
    const refresher = new CatalogRefresher(catalog, registry);
    refresher.start();
    await refresher.whenCurrentGenerationReady();
    catalog.clearPackage(PACKAGE.id);
    const snapshotCheck = vi.spyOn(catalog, "isSnapshotComplete");

    const readiness = refresher.whenCurrentGenerationReady();
    try {
      await flushMicrotasks(4);
      expect(snapshotCheck.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      await refresher.dispose();
      await readiness;
    }
  });

  it("disposal drops queued refreshes and resolves their callers", async () => {
    const first = packageConfig("first");
    const second = packageConfig("second");
    const firstAttempt = deferred<ConnectOutcome>();
    const client = clientWithTools();
    const { registry, connectForCatalog } = registryStub(
      [first, second],
      async (packageId) => packageId === first.id
        ? firstAttempt.promise
        : { kind: "connected", client },
    );
    const catalog = new Catalog(registry);
    seedReady(catalog, first.id);
    seedReady(catalog, second.id);
    const refresher = new CatalogRefresher(catalog, registry, { concurrency: 1 });
    refresher.start();

    const firstRefresh = refresher.refreshNow(first.id, {
      forceReconnect: true,
      reason: "explicit",
    });
    const queuedRefresh = refresher.refreshNow(second.id, {
      forceReconnect: true,
      reason: "explicit",
    });
    await flushMicrotasks();
    expect(connectForCatalog).toHaveBeenCalledTimes(1);

    await refresher.dispose();
    firstAttempt.resolve({ kind: "connected", client });
    await Promise.all([firstRefresh, queuedRefresh]);
    await flushMicrotasks();

    expect(connectForCatalog).toHaveBeenCalledTimes(1);
  });
});
