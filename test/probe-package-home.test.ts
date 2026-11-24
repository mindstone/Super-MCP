import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Catalog } from "../src/catalog.js";
import { CatalogRefresher, type CatalogRefresherOptions } from "../src/catalogRefresher.js";
import { handleProbePackageHome } from "../src/handlers/probePackageHome.js";
import { PackageRegistry } from "../src/registry.js";
import { startServer } from "../src/server.js";
import type { McpClient, PackageConfig } from "../src/types.js";

// FOX-11496: the app asks "is this connector reachable now?" every few seconds while it waits out a cloud restart.
// The answer must cost no call in flight anything, and must come from a real listing. Real SDK clients:
// probe-package-home.contract.test.ts.
const logger = vi.hoisted(() => ({ setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const handlers = vi.hoisted(() => new Map<unknown, (...args: any[]) => Promise<unknown>>());

vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<unknown>) { handlers.set(schema, handler); }
    async connect() {}
    getClientCapabilities() { return {}; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../src/configWatcher.js", () => ({ ConfigWatcher: class { async start() {} } }));

const ID = "Notes-work";
// One entry per answer shape the probe gives; Rebel Core's wait reads the same file (cloudConnectorWait.test.ts).
const probeAnswer = JSON.parse(readFileSync(new URL("./fixtures/probe-answer-v1.json", import.meta.url), "utf8")) as
  Record<string, Record<string, unknown>>;
const tool = { name: "read_item", description: "Read an item", inputSchema: { type: "object", properties: {} } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}


type MockClient = McpClient & { health: "ok" | "error" | "needs_auth" };

function mockClient(overrides: Partial<McpClient> = {}): MockClient {
  const client: MockClient = {
    health: "ok",
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTools: vi.fn(async () => [tool]),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "its own answer" }] })),
    healthCheck: vi.fn(async () => client.health),
    ...overrides,
  };
  return client;
}

/** A session 404 from the home: the client turns unhealthy, as `PackageHomeClient` does. */
function sessionLost(client: MockClient): () => Promise<never> {
  return async () => {
    client.health = "error";
    throw new StreamableHTTPError(404, "Session not found");
  };
}

const registries: PackageRegistry[] = [];
const refreshers: CatalogRefresher[] = [];

function setup(
  created: Array<McpClient | Error>,
  options: { homed?: boolean } & Pick<CatalogRefresherOptions, "refreshTimeoutMs" | "authProbeIntervalMs" | "now"> = {},
) {
  const homed = options.homed ?? true;
  const pkg: PackageConfig = homed
    ? { id: ID, name: "Fictional Notes", transport: "http", base_url: "https://notes.example.com/mcp", visibility: "default" }
    : { id: ID, name: "Fictional Notes", transport: "stdio", command: "notes-server", args: [], visibility: "default" };
  const registry = new PackageRegistry({ mcpServers: {}, ...(homed ? { packageHomes: { [ID]: { url: "http://127.0.0.1:9/unused" } } } : {}) } as never);
  (registry as unknown as { packages: PackageConfig[] }).packages = [pkg];
  const create = vi.spyOn(registry as unknown as { createAndConnectClient: () => Promise<McpClient> }, "createAndConnectClient");
  for (const next of created) {
    if (next instanceof Error) create.mockRejectedValueOnce(next);
    else create.mockResolvedValueOnce(next);
  }
  registries.push(registry);
  const catalog = new Catalog(registry);
  const { homed: _homed, ...timing } = options;
  const refresher = new CatalogRefresher(catalog, registry, { random: () => 0.5, ...timing });
  refreshers.push(refresher);
  const probe = async (packageId = ID, signal?: AbortSignal) => {
    const result = await handleProbePackageHome({ package_id: packageId }, registry, refresher, signal);
    return { isError: result.isError as boolean, answer: JSON.parse(result.content[0].text) };
  };
  return { registry, catalog, refresher, create, probe };
}

/** Starts a call whose connector holds it until released: its lease stays bound to the current client. */
async function holdCall(registry: PackageRegistry, client: MockClient) {
  const barrier = deferred<void>();
  const entered = deferred<void>();
  vi.mocked(client.callTool).mockImplementationOnce(async () => {
    entered.resolve();
    await barrier.promise;
    return { content: [{ type: "text", text: "its own answer" }] };
  });
  const call = registry.callTool(ID, tool.name, {}, { kind: "standalone" });
  await entered.promise;
  return { call, release: () => barrier.resolve() };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(refreshers.splice(0).map((refresher) => refresher.dispose()));
  await Promise.allSettled(registries.splice(0).map((registry) => registry.closeAll()));
  vi.restoreAllMocks();
  handlers.clear();
});

describe("probe_package_home", () => {
  it("an unhealthy client with no lease is replaced, and the probe answers ready from the new client", async () => {
    const client = mockClient();
    const fresh = mockClient();
    const { registry, probe, catalog } = setup([client, fresh]);
    await registry.getClient(ID);
    client.health = "error";

    expect((await probe()).answer).toEqual({ ...probeAnswer.ready, generation: catalog.getConfigurationGeneration() });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.listTools).not.toHaveBeenCalled();
    expect(fresh.listTools).toHaveBeenCalledTimes(1);
    await expect(registry.getClient(ID)).resolves.toBe(fresh);
  });

  it("a ready answer follows a real round trip", async () => {
    const client = mockClient();
    const { probe, catalog } = setup([client]);
    const commitReady = vi.spyOn(catalog, "commitReady");

    expect((await probe()).answer).toEqual({ status: "ready", generation: catalog.getConfigurationGeneration() });
    expect(catalog.getPackageStatus(ID)).toBe("ready");
    // Already ready: the next probe still lists, and commits what it saw.
    vi.mocked(client.listTools).mockResolvedValueOnce([tool, { ...tool, name: "write_item" }]);
    expect((await probe()).answer).toEqual({ status: "ready", generation: catalog.getConfigurationGeneration() });
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(commitReady).toHaveBeenCalledTimes(2);
    expect(catalog.countTools(ID)).toBe(2);
  });

  it("a session 404 on the listing replaces the idle client and lists once more", async () => {
    const client = mockClient();
    client.listTools = vi.fn(sessionLost(client));
    const fresh = mockClient();
    const { registry, probe, create } = setup([client, fresh]);
    await registry.getClient(ID);

    expect((await probe()).answer).toMatchObject({ status: "ready" });
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(fresh.listTools).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a session 404 on the second listing too is answered not_ready, never a third listing", async () => {
    const client = mockClient();
    client.listTools = vi.fn(sessionLost(client));
    const fresh = mockClient();
    fresh.listTools = vi.fn(sessionLost(fresh));
    const { registry, probe, create } = setup([client, fresh, mockClient()]);
    await registry.getClient(ID);

    expect((await probe()).answer).toEqual(probeAnswer.notReadyListFailed);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a session 404 on the listing of a client a call is using answers client_busy and closes nothing", async () => {
    const client = mockClient();
    const { registry, probe, create } = setup([client, mockClient()]);
    const { call, release } = await holdCall(registry, client);
    client.listTools = vi.fn(sessionLost(client));

    expect((await probe()).answer).toEqual(probeAnswer.notReadyClientBusy);
    expect(client.close).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    release();
    await expect(call).resolves.toEqual({ content: [{ type: "text", text: "its own answer" }] });
  });

  it("a permanent connect failure, committed through the real refresher, is answered failed", async () => {
    const missing = Object.assign(new Error("spawn notes-server ENOENT"), { code: "ENOENT" });
    const { probe, catalog } = setup([missing]);

    expect((await probe()).answer).toEqual(probeAnswer.failed);
    expect(catalog.getPackageDiagnostics(ID)).toMatchObject({ status: "error", lastErrorClass: "executable_not_found", nextRetryAt: null });
  });

  it("a transient connect failure is answered not_ready and writes nothing", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    const { probe, catalog } = setup([refused]);
    const before = catalog.getPackageDiagnostics(ID);

    expect((await probe()).answer).toEqual(probeAnswer.notReadyConnectFailed);
    // A failure that may pass is the ordinary refresh's to record, not the probe's. Only the start mark of a
    // never-loaded entry remains, as an ordinary refresh's start leaves it.
    expect(catalog.getPackageDiagnostics(ID)).toEqual({ ...before, status: "connecting" });
  });

  it("two probes at once make one listing", async () => {
    const listed = deferred<void>();
    const client = mockClient({ listTools: vi.fn(async () => { await listed.promise; return [tool]; }) });
    const { probe } = setup([client]);

    const first = probe();
    const second = probe();
    listed.resolve();

    expect((await first).answer).toMatchObject({ status: "ready" });
    expect((await second).answer).toMatchObject({ status: "ready" });
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  it("an aborted probe answers timed_out at once, and the listing it started still commits", async () => {
    const listed = deferred<void>();
    const entered = deferred<void>();
    const client = mockClient({ listTools: vi.fn(async () => { entered.resolve(); await listed.promise; return [tool]; }) });
    const { probe, catalog, refresher } = setup([client]);
    const controller = new AbortController();

    const answer = probe(ID, controller.signal);
    await entered.promise;
    controller.abort();
    expect((await answer).answer).toEqual(probeAnswer.notReadyTimedOut);

    const joined = refresher.probeNow(ID);
    listed.resolve();
    await expect(joined).resolves.toMatchObject({ status: "ready" });
    expect(catalog.getPackageStatus(ID)).toBe("ready");
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  it("a probe running when the refresher is disposed answers superseded", async () => {
    const entered = deferred<void>();
    const client = mockClient({ listTools: vi.fn(async () => { entered.resolve(); return new Promise<never>(() => {}); }) });
    const { probe, refresher } = setup([client]);

    const answer = probe();
    await entered.promise;
    await refresher.dispose();
    expect((await answer).answer).toEqual(probeAnswer.notReadySuperseded);
  });

  it("a pending eviction behind a running call answers client_busy at once", async () => {
    const client = mockClient();
    const { registry, probe } = setup([client]);
    const { call, release } = await holdCall(registry, client);
    const eviction = registry.evictClient(ID, "explicit");

    expect((await probe()).answer).toEqual({ status: "not_ready", reason: "client_busy" });
    expect(client.close).not.toHaveBeenCalled();
    release();
    await expect(call).resolves.toEqual({ content: [{ type: "text", text: "its own answer" }] });
    await eviction;
  });

  it("a listing that never returns answers timed_out at the refresh limit, frees the slot, evicts nothing and commits nothing late", async () => {
    vi.useFakeTimers();
    const late = deferred<unknown[]>();
    const entered = deferred<void>();
    const client = mockClient({ listTools: vi.fn(async () => { entered.resolve(); return late.promise; }) });
    const { registry, catalog, probe } = setup([client], { refreshTimeoutMs: 1_000 });
    const evict = vi.spyOn(registry, "evictClient");
    const commitReady = vi.spyOn(catalog, "commitReady");

    const answer = probe();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await answer).answer).toEqual({ status: "not_ready", reason: "timed_out" });
    expect(catalog.getRefreshInFlight(ID)).toBe(false);
    expect(evict).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();

    // The slot is free: the next probe makes its own listing, and the late one commits nothing after it.
    vi.mocked(client.listTools).mockResolvedValueOnce([tool]);
    expect((await probe()).answer).toMatchObject({ status: "ready" });
    late.resolve([{ ...tool, name: "late_item" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(commitReady).toHaveBeenCalledTimes(1);
    expect(catalog.getPackageTools(ID).map((entry) => entry.tool.name)).toEqual(["read_item"]);
  });

  it("failed probes write nothing: the retry schedule stays the ordinary refresh's, and a ready entry does not make a failed listing ready", async () => {
    const client = mockClient();
    const now = 1_000_000;
    const { catalog, refresher, probe } = setup([client], { now: () => now });
    const failing = () => vi.mocked(client.listTools).mockRejectedValueOnce(new Error("Temporary listing failure"));
    failing();
    refresher.start();
    await refresher.refreshNow(ID);
    const schedule = () => ({ failures: catalog.getConsecutiveFailures(ID), retry: catalog.getRetryHint(ID, now) });
    const before = schedule();
    expect(before.retry.retryAt).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      failing();
      expect((await probe()).answer).toEqual({ status: "not_ready", reason: "list_failed" });
    }
    expect(schedule()).toEqual(before);

    expect((await probe()).answer).toMatchObject({ status: "ready" });
    failing();
    expect((await probe()).answer).toEqual({ status: "not_ready", reason: "list_failed" });
    expect(catalog.getPackageStatus(ID)).toBe("ready");
  });

  it("a probe that finds sign-in needed leaves the sign-in check scheduled, as an ordinary refresh does", async () => {
    vi.useFakeTimers();
    const client = mockClient();
    const { registry, catalog, refresher, probe } = setup([client, mockClient()], { authProbeIntervalMs: 60_000 });
    refresher.start();
    await refresher.refreshNow(ID);
    expect(catalog.getPackageStatus(ID)).toBe("ready");
    client.health = "needs_auth";

    expect((await probe()).answer).toEqual(probeAnswer.authRequired);
    expect(catalog.getPackageStatus(ID)).toBe("auth_required");
    const connect = vi.spyOn(registry, "connectForCatalog");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledWith(ID, { forceReconnect: true });
  });

  it("a local connector is refused, and nothing is constructed", async () => {
    const { probe, create } = setup([mockClient()], { homed: false });
    const result = await probe();
    expect(result.isError).toBe(true);
    expect(result.answer).toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("a registry event while a probe holds the slot", () => {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
  const evicted = (registry: PackageRegistry) =>
    (registry as unknown as { emitLifecycle(event: unknown): void }).emitLifecycle({ type: "client_evicted", packageId: ID, reason: "unhealthy" });
  /** Counts refreshes the refresher queues; `enqueue` is synchronous, so the count is exact once the probe has answered. */
  const queued = (refresher: CatalogRefresher) =>
    vi.spyOn(refresher as unknown as { enqueue: (...args: unknown[]) => void }, "enqueue");

  async function readyAndStarted(created: Array<McpClient | Error>, now = 1_000_000) {
    const ctx = setup(created, { now: () => now });
    ctx.refresher.start();
    await ctx.refresher.refreshNow(ID);
    expect(ctx.catalog.getPackageStatus(ID)).toBe("ready");
    return ctx;
  }

  it("a probe's own eviction with a failed replacement starts an ordinary refresh", async () => {
    const now = 1_000_000;
    const client = mockClient();
    const { catalog, refresher, probe } = await readyAndStarted([client, refused(), refused()], now);
    const enqueue = queued(refresher);
    client.health = "error";

    expect((await probe()).answer).toEqual({ status: "not_ready", reason: "connect_failed" });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(ID, { forceReconnect: false, reason: "registry" });
    await refresher.refreshNow(ID);
    expect(catalog.getPackageStatus(ID)).not.toBe("ready");
    const diagnostics = catalog.getPackageDiagnostics(ID);
    expect(diagnostics.consecutiveFailures).toBe(1);
    expect(diagnostics.nextRetryAt).not.toBeNull();
    expect(diagnostics.nextRetryAt!).toBeGreaterThan(now);
  });

  it("an eviction by a call during a probe is handed over after the probe", async () => {
    const client = mockClient();
    const { registry, catalog, refresher, probe } = await readyAndStarted([client, refused()]);
    const enqueue = queued(refresher);
    const listed = deferred<void>();
    const entered = deferred<void>();
    vi.mocked(client.listTools).mockImplementationOnce(async () => {
      entered.resolve();
      await listed.promise;
      throw new Error("Temporary listing failure");
    });

    const answer = probe();
    await entered.promise;
    evicted(registry);
    expect(enqueue).not.toHaveBeenCalled();
    listed.resolve();
    expect((await answer).answer).toEqual({ status: "not_ready", reason: "list_failed" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    await refresher.refreshNow(ID);
    expect(catalog.getPackageStatus(ID)).toBe("ready");
  });

  it("a probe that answers ready hands nothing over", async () => {
    const client = mockClient();
    const { registry, refresher, probe } = await readyAndStarted([client]);
    const enqueue = queued(refresher);
    const listed = deferred<void>();
    const entered = deferred<void>();
    vi.mocked(client.listTools).mockImplementationOnce(async () => {
      entered.resolve();
      await listed.promise;
      return [tool];
    });

    const answer = probe();
    await entered.promise;
    evicted(registry);
    listed.resolve();
    expect((await answer).answer).toMatchObject({ status: "ready" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("an event under an ordinary refresh is still dropped", async () => {
    const listed = deferred<void>();
    const entered = deferred<void>();
    const client = mockClient({ listTools: vi.fn(async () => { entered.resolve(); await listed.promise; return [tool]; }) });
    const { registry, catalog, refresher } = setup([client]);
    const enqueue = queued(refresher);
    // The startup refresh is the ordinary refresh in the slot.
    refresher.start();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await entered.promise;
    evicted(registry);
    listed.resolve();
    await refresher.refreshNow(ID);
    expect(catalog.getPackageStatus(ID)).toBe("ready");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("five failed probes in a row start no refresh", async () => {
    const now = 1_000_000;
    const { catalog, refresher, probe } = setup(
      [refused(), refused(), refused(), refused(), refused(), refused()],
      { now: () => now },
    );
    refresher.start();
    await refresher.refreshNow(ID);
    const before = catalog.getPackageDiagnostics(ID);
    expect(before.nextRetryAt!).toBeGreaterThan(now);
    const enqueue = queued(refresher);

    for (let i = 0; i < 5; i++) {
      expect((await probe()).answer).toEqual({ status: "not_ready", reason: "connect_failed" });
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(catalog.getPackageDiagnostics(ID)).toEqual(before);
  });

  it("an unstarted refresher hands nothing over", async () => {
    const client = mockClient();
    const { refresher, probe } = setup([client, refused()]);
    expect((await probe()).answer).toMatchObject({ status: "ready" });
    const enqueue = queued(refresher);
    client.health = "error";

    expect((await probe()).answer).toEqual({ status: "not_ready", reason: "connect_failed" });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the router's own dispatch", () => {
  async function start() {
    const client = mockClient();
    const { registry } = setup([client, mockClient()]);
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);
    const started: CatalogRefresher[] = [];
    const startRefresher = CatalogRefresher.prototype.start;
    vi.spyOn(CatalogRefresher.prototype, "start").mockImplementation(function (this: CatalogRefresher) {
      started.push(this);
      refreshers.push(this);
      return startRefresher.call(this);
    });
    await startServer({ configPaths: [], transport: "stdio" });
    // The server's startup refresh holds the package's slot until it ends; a probe asked during it answers refresh_in_progress.
    await Promise.all(started.map((refresher) => refresher.refreshNow(ID)));
    return client;
  }

  it("probe_package_home is answered through the router's tool call", async () => {
    const client = await start();
    const result = await handlers.get(CallToolRequestSchema)!(
      { params: { name: "probe_package_home", arguments: { package_id: ID } } },
      { signal: new AbortController().signal, sendRequest: vi.fn() },
    ) as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "ready" });
    expect(client.close).not.toHaveBeenCalled();
  });
});
