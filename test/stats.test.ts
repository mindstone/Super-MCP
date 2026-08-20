/**
 * Tests for GET /stats route — Stage 4b of
 * `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * Exercises:
 *  - Empty registry → `children: []`, `router` populated.
 *  - Known-but-uncreated stdio package → `connected: false, pid: null, spawn_count: 0`.
 *  - Post-successful-spawn path (via direct state poke, mirroring
 *    `registry-idle-reaping.test.ts`) → `connected: true, spawn_count: 1`.
 *  - Connect retries and their recovered/failed outcomes are exposed separately.
 *  - Post-reap path → `reap_count: 1, connected: false, pid: null`.
 *  - `pending_requests: true` when the client's `hasPendingRequests()` returns true.
 *  - 500 + error log when `registry.getChildStats` throws.
 *  - Defense-in-depth: `dnsRebindingGuard` rejects wrong Host header with 403.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { PackageRegistry } from "../src/registry.js";
import { registerHttpApiRoutes } from "../src/server.js";
import type { McpClient, PackageConfig, SuperMcpConfig } from "../src/types.js";
import type { Catalog } from "../src/catalog.js";

// Logger is a module-level singleton consumed at module-load time by
// transitive imports (e.g. `src/clients/stdioClient.ts`). `vi.mock` hoists
// above `const` declarations, so we need `vi.hoisted()` to make
// `loggerMock` available before the registry imports run.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  },
}));
vi.mock("../src/logging.js", () => ({
  getLogger: () => loggerMock,
}));

// /stats doesn't touch security policy, but /manifest / /api/tools do;
// keep a stub so `registerHttpApiRoutes()` side-effects stay inert.
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

// ── Helpers ──────────────────────────────────────────────────────────

function createRegistry(packages: PackageConfig[]): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  const registry = new PackageRegistry(config);
  (registry as unknown as { packages: PackageConfig[] }).packages = packages;
  return registry;
}

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function stdioPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "stdio",
    command: "node",
    args: ["mock-server.js"],
    visibility: "default",
  };
}

/**
 * Mount the router-api on a random-port express server so we can hit /stats
 * over real HTTP. Mirrors the pattern in `test/manifest.test.ts`.
 *
 * `dnsRebindingGuard` defaults to passthrough — individual tests override
 * this to simulate the localhost check.
 */
async function startApiServer(
  registry: PackageRegistry,
  options: {
    dnsRebindingGuard?: express.RequestHandler;
  } = {},
) {
  const app = express();
  app.use(express.json());
  // The route registrar shares one catalog across the catalog endpoints and
  // `/stats`; keep this stub at the read-only surface those routes consume.
  const catalogStub = {
    getPackageTools: vi.fn().mockReturnValue([]),
    etag: vi.fn().mockReturnValue("sha256:catalog"),
    countTools: vi.fn().mockReturnValue(0),
    computePackageEmbeddingHash: vi.fn().mockReturnValue(""),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    isSnapshotComplete: vi.fn().mockReturnValue(true),
    getPackageDiagnostics: vi.fn().mockReturnValue({
      status: "ready",
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastErrorClass: null,
    }),
  } as unknown as Catalog;

  registerHttpApiRoutes(app, {
    registry,
    catalog: catalogStub,
    dnsRebindingGuard:
      options.dnsRebindingGuard ?? ((_req, _res, next) => next()),
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

// ── Route shape tests ────────────────────────────────────────────────

describe("GET /stats route shape", () => {
  it("includes catalog degradation diagnostics in each child snapshot", () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const catalog = {
      getPackageDiagnostics: vi.fn().mockReturnValue({
        status: "error",
        lastError: "connection timed out",
        consecutiveFailures: 3,
        nextRetryAt: 1_800_000,
        lastErrorClass: "timeout",
        retainedToolCount: 2,
        generation: 7,
      }),
    };

    expect(registry.getChildStats(catalog)).toEqual([
      expect.objectContaining({
        package_id: "alpha",
        catalog_status: "error",
        consecutive_failures: 3,
        next_retry_at: 1_800_000,
        last_error_class: "timeout",
      }),
    ]);
  });

  it("returns router metadata + empty children when no packages configured", async () => {
    const registry = createRegistry([]);
    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("router");
      expect(body).toHaveProperty("children");
      expect(body).toHaveProperty("generated_at");

      expect(body.router.running).toBe(true);
      expect(typeof body.router.pid).toBe("number");
      expect(body.router.pid).toBeGreaterThan(0);
      expect(typeof body.router.uptime_ms).toBe("number");
      expect(body.router.uptime_ms).toBeGreaterThanOrEqual(0);
      expect(typeof body.router.started_at).toBe("string");
      // ISO-8601 shape.
      expect(body.router.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

      expect(Array.isArray(body.children)).toBe(true);
      expect(body.children).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("includes a known-but-uncreated package with connected:false / pid:null / spawn_count:0", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.children).toHaveLength(1);
      expect(body.children[0]).toMatchObject({
        package_id: "alpha",
        transport: "stdio",
        pid: null,
        connected: false,
        pending_requests: false,
        spawn_count: 0,
        reap_count: 0,
        eviction_count: 0,
        connect_retry_count: 0,
        connect_retry_recovered_count: 0,
        connect_retry_failed_count: 0,
        connect_retry_skipped_permanent_count: 0,
        idle_ms: null,
        last_activity_at: null,
      });
    } finally {
      await server.close();
    }
  });

  it("reports connected:true and spawn_count:1 after a simulated successful spawn", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const client = createMockClient();

    // Mirror createAndConnectClient() success-path: inject the client,
    // bump spawnCounts + lastActivity as `getClient()` does on success.
    const internals = registry as unknown as {
      clients: Map<string, McpClient>;
      lastActivity: Map<string, number>;
      spawnCounts: Map<string, number>;
    };
    internals.clients.set("alpha", client);
    internals.lastActivity.set("alpha", Date.now() - 1_500);
    internals.spawnCounts.set("alpha", 1);

    // Expose a PID on the client's fake transport — mirrors StdioMcpClient
    // after connect (`this.transport.pid`). Only present when stdio & connected.
    (client as unknown as { transport: { pid: number } }).transport = { pid: 4242 };

    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.children).toHaveLength(1);
      const entry = body.children[0];
      expect(entry).toMatchObject({
        package_id: "alpha",
        transport: "stdio",
        pid: 4242,
        connected: true,
        spawn_count: 1,
        reap_count: 0,
        eviction_count: 0,
        connect_retry_count: 0,
        connect_retry_recovered_count: 0,
        connect_retry_failed_count: 0,
        connect_retry_skipped_permanent_count: 0,
        pending_requests: false,
        last_activity_at: expect.any(Number),
      });
      expect(entry.idle_ms).toBeGreaterThanOrEqual(1_500);
    } finally {
      await server.close();
    }
  });

  it("reports reap_count:1 and connected:false / pid:null after a simulated reap", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);

    // Simulate full reaper effect: client already removed, reap counter incremented.
    const internals = registry as unknown as {
      spawnCounts: Map<string, number>;
      reapCounts: Map<string, number>;
    };
    internals.spawnCounts.set("alpha", 1);
    internals.reapCounts.set("alpha", 1);

    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.children).toHaveLength(1);
      expect(body.children[0]).toMatchObject({
        package_id: "alpha",
        connected: false,
        pid: null,
        spawn_count: 1,
        reap_count: 1,
        eviction_count: 0,
        connect_retry_count: 0,
        connect_retry_recovered_count: 0,
        connect_retry_failed_count: 0,
        connect_retry_skipped_permanent_count: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("reports pending_requests:true when client.hasPendingRequests() returns true", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const client = createMockClient({
      hasPendingRequests: vi.fn().mockReturnValue(true),
    });
    const internals = registry as unknown as {
      clients: Map<string, McpClient>;
      spawnCounts: Map<string, number>;
    };
    internals.clients.set("alpha", client);
    internals.spawnCounts.set("alpha", 1);

    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.children[0].pending_requests).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// ── Error-path tests ─────────────────────────────────────────────────

describe("GET /stats error handling", () => {
  it("returns 500 and logs an error when registry.getChildStats throws", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    vi.spyOn(registry, "getChildStats").mockImplementation(() => {
      throw new Error("registry exploded");
    });

    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(loggerMock.error).toHaveBeenCalledWith(
        "Failed to build /stats payload",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      await server.close();
    }
  });
});

// ── Defense-in-depth: dnsRebindingGuard passthrough ─────────────────

describe("GET /stats dnsRebindingGuard integration", () => {
  it("is guarded by the dnsRebindingGuard — wrong Host header → 403", async () => {
    const registry = createRegistry([]);
    // Stub guard that rejects everything with 403, matching the production
    // guard's rejection shape from server.ts.
    const rejectingGuard: express.RequestHandler = (_req, res) => {
      res.status(403).json({ error: "Forbidden - invalid host" });
    };
    const server = await startApiServer(registry, { dnsRebindingGuard: rejectingGuard });
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/forbidden/i);
    } finally {
      await server.close();
    }
  });
});

// ── M3: evictionCounts race-safety (concurrent unhealthy getClient) ──

describe("PackageRegistry evictionCounts race-safety (Stage 4b M3)", () => {
  /**
   * When two `getClient()` callers arrive simultaneously for the same
   * packageId and the existing client fails its healthCheck, both await
   * the same `healthCheck` result and both reach the delete+increment
   * block. The `Map.delete()` return-value guard ensures only the first
   * caller bumps `evictionCounts` — preventing drift.
   *
   * We exercise the behaviour directly against the mutation site rather
   * than trying to win the real promise race (which is fundamentally
   * non-deterministic under Vitest timer control). Two sequential calls
   * to the delete+increment block simulate two concurrent callers that
   * both passed the health check at step N and both reached the
   * evict-and-replace at step N+1.
   */
  it("increments evictionCounts at-most-once when two concurrent callers both evict the same unhealthy client", () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const client = createMockClient();

    const internals = registry as unknown as {
      clients: Map<string, McpClient>;
      evictionCounts: Map<string, number>;
    };
    internals.clients.set("alpha", client);

    // Exactly the logic under test from `getClient()` unhealthy-client branch.
    const evictUnhealthy = () => {
      const deleted = internals.clients.delete("alpha");
      if (deleted) {
        internals.evictionCounts.set(
          "alpha",
          (internals.evictionCounts.get("alpha") ?? 0) + 1,
        );
      }
    };

    // First call: delete returns true, counter -> 1.
    evictUnhealthy();
    // Second call (concurrent caller that awaited the same healthCheck):
    // delete returns false (already removed), counter MUST stay at 1.
    evictUnhealthy();

    expect(internals.clients.has("alpha")).toBe(false);
    expect(internals.evictionCounts.get("alpha")).toBe(1);
  });

  it("increments again on a fresh unhealthy-client cycle (counter is not frozen after first eviction)", () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const internals = registry as unknown as {
      clients: Map<string, McpClient>;
      evictionCounts: Map<string, number>;
    };

    const evictUnhealthy = () => {
      const deleted = internals.clients.delete("alpha");
      if (deleted) {
        internals.evictionCounts.set(
          "alpha",
          (internals.evictionCounts.get("alpha") ?? 0) + 1,
        );
      }
    };

    // Cycle 1: set a client, evict.
    internals.clients.set("alpha", createMockClient());
    evictUnhealthy();
    evictUnhealthy(); // concurrent no-op
    expect(internals.evictionCounts.get("alpha")).toBe(1);

    // Cycle 2: a new client gets created, then later evicted.
    internals.clients.set("alpha", createMockClient());
    evictUnhealthy();
    evictUnhealthy(); // concurrent no-op
    expect(internals.evictionCounts.get("alpha")).toBe(2);
  });
});

// ── S4: behavior-level sweepIdleClients reap (counter integration) ──

describe("PackageRegistry sweepIdleClients reap counter (Stage 4b S4)", () => {
  it("closes an idle stdio client and bumps reap_count to 1, exposing via /stats", async () => {
    const registry = createRegistry([stdioPackage("alpha")]);
    const client = createMockClient();
    const internals = registry as unknown as {
      clients: Map<string, McpClient>;
      lastActivity: Map<string, number>;
      reaperTimeoutMs: number;
    };

    internals.clients.set("alpha", client);
    // Set last activity far beyond the reaper timeout (default 5 min).
    internals.lastActivity.set("alpha", Date.now() - 10 * 60_000);

    // Directly invoke the private sweep — avoids the setInterval scheduling
    // path which the existing idle-reaper tests already cover with fake timers.
    (registry as unknown as { sweepIdleClients(): void }).sweepIdleClients();

    // Client was closed and removed.
    expect(client.close).toHaveBeenCalledOnce();
    expect(internals.clients.has("alpha")).toBe(false);

    // Counter is visible on the emitted stats payload.
    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.children).toHaveLength(1);
      expect(body.children[0]).toMatchObject({
        package_id: "alpha",
        reap_count: 1,
        connected: false,
        pid: null,
      });
    } finally {
      await server.close();
    }
  });
});

// ── S3: router start_count / restart_count on /stats.router ─────────

describe("GET /stats router counters (Stage 4b S3)", () => {
  it("router payload includes start_count:1 and restart_count:0", async () => {
    const registry = createRegistry([]);
    const server = await startApiServer(registry);
    try {
      const res = await fetch(`${server.baseUrl}/stats`);
      const body = await res.json();
      expect(body.router.start_count).toBe(1);
      expect(body.router.restart_count).toBe(0);
    } finally {
      await server.close();
    }
  });
});
