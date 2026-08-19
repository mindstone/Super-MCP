import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { PackageRegistry } from "../src/registry.js";
import type {
  McpClient,
  PackageConfig,
  TransientConnectFailureClass,
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
  id: "calendar-account-a",
  name: "Calendar account A",
  transport: "http",
  base_url: "https://calendar.example.test/mcp",
  visibility: "default",
};

type Refresher = {
  start(): void;
  scheduleRefresh(packageId: string): void;
  notify(packageId: string, reason: "authentication" | "configuration"): void;
  dispose(): void | Promise<void>;
};

type RefresherModule = {
  CatalogRefresher: new (
    catalog: Catalog,
    registry: PackageRegistry,
    options?: {
      concurrency?: number;
      authProbeIntervalMs?: number;
      now?: () => number;
      random?: () => number;
    },
  ) => Refresher;
  TRANSIENT_CONNECT_FAILURE_CLASSES: readonly TransientConnectFailureClass[];
  calculateRetryDelayMs(input: {
    failureClass: TransientConnectFailureClass;
    consecutiveFailures: number;
    random: () => number;
  }): number;
};

async function loadRefresherModule(): Promise<RefresherModule> {
  const modulePath = "../src/catalogRefresher.js";
  return import(modulePath) as Promise<RefresherModule>;
}

function mcpClient(options: {
  health: "ok" | "needs_auth";
  tools?: unknown[];
}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(options.tools ?? []),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(options.health),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("CatalogRefresher auth recovery and backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.fails("R7: auth retries are half-open or event-driven and remain single-flight through registry healthCheck", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    const { CatalogRefresher } = await loadRefresherModule();
    const registry = new PackageRegistry({ packages: [PACKAGE] });
    const catalog = new Catalog(registry);
    const authClient = mcpClient({ health: "needs_auth" });
    const recoveredClient = mcpClient({
      health: "ok",
      tools: [{ name: "list_events", inputSchema: { type: "object" } }],
    });
    let recover = false;
    const getClient = vi.spyOn(registry, "getClient").mockImplementation(async () =>
      recover ? recoveredClient : authClient);
    (catalog as unknown as { cache: Map<string, unknown> }).cache.set(PACKAGE.id, {
      packageId: PACKAGE.id,
      tools: [],
      lastUpdated: Date.now(),
      etag: "auth",
      status: "auth_required",
    });

    const refresher = new CatalogRefresher(catalog, registry, {
      concurrency: 1,
      authProbeIntervalMs: 1_000,
      now: () => Date.now(),
      random: () => 0.5,
    });
    refresher.start();

    expect(refresher.scheduleRefresh(PACKAGE.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(999);
    await flushMicrotasks();
    expect(getClient).not.toHaveBeenCalled();

    recover = true;
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("ready");

    getClient.mockClear();
    recover = false;
    (catalog as unknown as { cache: Map<string, Record<string, unknown>> })
      .cache.get(PACKAGE.id)!.status = "auth_required";
    recover = true;
    refresher.notify(PACKAGE.id, "authentication");
    refresher.notify(PACKAGE.id, "authentication");
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(getClient).toHaveBeenCalledTimes(1);

    await refresher.dispose();
  });

  it.fails("R8a: every transient class has capped jittered backoff and becomes eligible within 36 minutes", async () => {
    const {
      TRANSIENT_CONNECT_FAILURE_CLASSES,
      calculateRetryDelayMs,
    } = await loadRefresherModule();

    expect(TRANSIENT_CONNECT_FAILURE_CLASSES.length).toBeGreaterThan(0);
    expect(TRANSIENT_CONNECT_FAILURE_CLASSES).not.toContain("auth_required");
    for (const failureClass of TRANSIENT_CONNECT_FAILURE_CLASSES) {
      const midpointDelays = [1, 2, 3, 4, 5, 8].map((consecutiveFailures) =>
        calculateRetryDelayMs({
          failureClass,
          consecutiveFailures,
          random: () => 0.5,
        }));
      expect(midpointDelays).toEqual([
        15_000,
        30_000,
        60_000,
        300_000,
        1_800_000,
        1_800_000,
      ]);

      const minimumJitter = calculateRetryDelayMs({
        failureClass,
        consecutiveFailures: 8,
        random: () => 0,
      });
      const maximumJitter = calculateRetryDelayMs({
        failureClass,
        consecutiveFailures: 8,
        random: () => 1,
      });
      expect(minimumJitter).toBe(1_440_000);
      expect(maximumJitter).toBe(2_160_000);
    }
  });
});
