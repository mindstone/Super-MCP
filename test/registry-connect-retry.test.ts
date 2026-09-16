import { readFile } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageRegistry, RegistryClosedError } from "../src/registry.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { StdioMcpClient } from "../src/clients/stdioClient.js";
import type {
  ConnectOutcome,
  McpClient,
  PackageConfig,
  SuperMcpConfig,
} from "../src/types.js";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => loggerMock,
}));

type RegistryInternals = {
  clients: Map<string, McpClient>;
  clientPromises: Map<string, Promise<McpClient>>;
  constructedClients: Map<McpClient, string>;
  activeCloseOperations: Map<McpClient, { promise: Promise<void> }>;
  evictionPromises: Map<string, Promise<void>>;
  activeLeases: Map<string, number>;
  activeLeaseClients?: Map<string, Map<McpClient, number>>;
  terminalCloseSettledClients?: Set<McpClient>;
  terminalCleanupFailures: Array<unknown>;
  leaseDrainWaiters: Map<string, Array<() => void>>;
  lastActivity: Map<string, number>;
  authRequiredPackages: Set<string>;
  terminal: boolean;
  reconcileNonDrainableTerminalLeases: () => void;
  unbindLeaseFromClient: (packageId: string, client: McpClient) => void;
  releaseLease: (packageId: string) => void;
  sweepIdleClients: () => void;
  createAndConnectClient: (
    packageId: string,
    config: PackageConfig,
    onClientCreated?: (client: McpClient) => void,
  ) => Promise<ConnectOutcome | McpClient>;
};

function createRegistry(packageId = "GoogleWorkspace-acme"): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  const registry = new PackageRegistry(config);
  (registry as unknown as { packages: PackageConfig[] }).packages = [
    {
      id: packageId,
      name: packageId,
      transport: "stdio",
      command: "node",
      args: ["mock-server.js"],
      visibility: "default",
    },
  ];
  return registry;
}

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PackageRegistry connect retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(["stdio", "http"] as const)(
    "bounds %s connects, closes the timed-out client, and ignores late completion",
    async (transport) => {
      vi.useFakeTimers();
      vi.stubEnv("SUPER_MCP_CONNECT_TIMEOUT_MS", "10");
      const packageId = `timeout-${transport}`;
      const config: PackageConfig = transport === "stdio"
        ? {
            id: packageId,
            name: packageId,
            transport,
            command: "node",
            args: ["server.js"],
            visibility: "default",
          }
        : {
            id: packageId,
            name: packageId,
            transport,
            base_url: "https://timeout.example.test/mcp",
            visibility: "default",
          };
      const registry = new PackageRegistry({ packages: [config] });
      const connectAttempt = deferred<void>();
      const prototype = transport === "stdio"
        ? StdioMcpClient.prototype
        : HttpMcpClient.prototype;
      vi.spyOn(prototype, "connect").mockReturnValue(connectAttempt.promise);
      const close = vi.spyOn(prototype, "close").mockResolvedValue(undefined);
      const internals = registry as unknown as RegistryInternals;

      const outcomePromise = internals.createAndConnectClient(packageId, config);
      await vi.advanceTimersByTimeAsync(10);
      await expect(outcomePromise).resolves.toMatchObject({
        kind: "transient_failure",
        failureClass: "timeout",
      });
      expect(close).toHaveBeenCalled();

      connectAttempt.resolve(undefined);
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
      expect((registry as unknown as { clients: Map<string, McpClient> }).clients.has(packageId))
        .toBe(false);
    },
  );

  it("retries one failed connect and cleans the per-package single-flight", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const connectedClient = createMockClient();
    const firstError = new Error("Request timed out (-32001)");
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        throw firstError;
      })
      .mockResolvedValueOnce(connectedClient);

    await expect(registry.getClient(packageId)).resolves.toBe(connectedClient);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(internals.clientPromises.has(packageId)).toBe(false);
    expect(registry.getChildStats()[0]).toMatchObject({
      connect_retry_count: 1,
      connect_retry_recovered_count: 1,
      connect_retry_failed_count: 0,
      connect_retry_skipped_permanent_count: 0,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "MCP client connect failed; retrying once",
      expect.objectContaining({
        package_id: packageId,
        attempt: 1,
        error: firstError.message,
      }),
    );
  });

  it("skips retry for a causal ENOENT failure and rethrows the first error", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const spawnError = Object.assign(new Error("spawn fictional-mcp ENOENT"), {
      code: "ENOENT",
    });
    const firstError = Object.assign(
      new Error(`Failed to connect to MCP server '${packageId}'.`),
      { originalError: { cause: spawnError } },
    );
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy.mockImplementationOnce(async (_id, _config, onClientCreated) => {
      onClientCreated?.(firstClient);
      throw firstError;
    });

    await expect(registry.getClient(packageId)).rejects.toBe(firstError);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(internals.clientPromises.has(packageId)).toBe(false);
    expect(registry.getChildStats()[0]).toMatchObject({
      connect_retry_count: 0,
      connect_retry_recovered_count: 0,
      connect_retry_failed_count: 0,
      connect_retry_skipped_permanent_count: 1,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "MCP client connect retry skipped for permanent failure",
      expect.objectContaining({
        package_id: packageId,
        attempt: 1,
        error: firstError.message,
      }),
    );
  });

  it("still retries an unrelated not-found message", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const connectedClient = createMockClient();
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        throw new Error("HTTP resource not found");
      })
      .mockResolvedValueOnce(connectedClient);

    await expect(registry.getClient(packageId)).resolves.toBe(connectedClient);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(registry.getChildStats()[0]).toMatchObject({
      connect_retry_count: 1,
      connect_retry_recovered_count: 1,
      connect_retry_failed_count: 0,
      connect_retry_skipped_permanent_count: 0,
    });
  });

  it("shares one retry across concurrent callers", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const connectedClient = createMockClient();
    const firstAttempt = deferred<McpClient>();
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        return firstAttempt.promise;
      })
      .mockResolvedValueOnce(connectedClient);

    const firstCaller = registry.getClient(packageId);
    const secondCaller = registry.getClient(packageId);
    firstAttempt.reject(new Error("Request timed out (-32001)"));

    await expect(Promise.all([firstCaller, secondCaller])).resolves.toEqual([
      connectedClient,
      connectedClient,
    ]);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(internals.clientPromises.has(packageId)).toBe(false);
  });

  it("propagates the enhanced second error with originalError attached", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient({
      close: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    });
    const firstError = new Error("Request timed out (-32001)");
    const secondError = new Error("Connection refused");
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        throw firstError;
      })
      .mockRejectedValueOnce(secondError);

    let thrown: unknown;
    try {
      await registry.getClient(packageId);
    } catch (error) {
      thrown = error;
    }

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      `Failed to connect to MCP package '${packageId}'`,
    );
    expect((thrown as Error & { originalError?: unknown }).originalError).toBe(
      secondError,
    );
    expect(internals.clientPromises.has(packageId)).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Failed to close MCP client after failed connect",
      expect.objectContaining({
        package_id: packageId,
        attempt: 1,
        error: "cleanup failed",
      }),
    );
  });

  it("preserves both attempts' structured diagnostics when both connects fail", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const firstAttemptDiagnostics = {
      packageId,
      stderrTail: "first attempt stderr",
      spawnObservedThisCall: true,
      spawnError: "first spawn error",
      childCloseObserved: false,
      childExitCode: null,
    };
    const secondAttemptDiagnostics = {
      packageId,
      stderrTail: "second attempt stderr",
      spawnObservedThisCall: false,
      spawnError: null,
      childCloseObserved: true,
      childExitCode: null,
    };
    const firstError = Object.assign(
      new Error(`Failed to connect to MCP server '${packageId}'.`),
      { data: firstAttemptDiagnostics },
    );
    const secondError = Object.assign(
      new Error(`Failed to connect to MCP server '${packageId}'.`),
      { data: secondAttemptDiagnostics },
    );
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        throw firstError;
      })
      .mockRejectedValueOnce(secondError);

    let thrown: unknown;
    try {
      await registry.getClient(packageId);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(secondError);
    expect(secondError.data).toEqual({
      ...secondAttemptDiagnostics,
      firstAttempt: firstAttemptDiagnostics,
    });
    expect(registry.getChildStats()[0]).toMatchObject({
      connect_retry_count: 1,
      connect_retry_recovered_count: 0,
      connect_retry_failed_count: 1,
      connect_retry_skipped_permanent_count: 0,
    });
  });

  it("never masks the second connect error when diagnostics cannot be enriched", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const firstClient = createMockClient();
    const firstError = Object.assign(
      new Error(`Failed to connect to MCP server '${packageId}'.`),
      { data: { stderrTail: "first attempt stderr" } },
    );
    const secondError = Object.assign(
      new Error(`Failed to connect to MCP server '${packageId}'.`),
      { data: Object.freeze({ stderrTail: "second attempt stderr" }) },
    );
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        onClientCreated?.(firstClient);
        throw firstError;
      })
      .mockRejectedValueOnce(secondError);

    await expect(registry.getClient(packageId)).rejects.toBe(secondError);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Failed to preserve first-attempt MCP connect diagnostics",
      expect.objectContaining({ package_id: packageId }),
    );
  });

  it("closes the failed first client before starting attempt two", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const order: string[] = [];
    const firstClient = createMockClient({
      close: vi.fn().mockImplementation(async () => {
        order.push("close-first");
      }),
    });
    const connectedClient = createMockClient();
    const createSpy = vi.spyOn(internals, "createAndConnectClient");

    createSpy
      .mockImplementationOnce(async (_id, _config, onClientCreated) => {
        order.push("attempt-one");
        onClientCreated?.(firstClient);
        throw new Error("Request timed out (-32001)");
      })
      .mockImplementationOnce(async () => {
        order.push("attempt-two");
        return connectedClient;
      });

    await expect(registry.getClient(packageId)).resolves.toBe(connectedClient);

    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["attempt-one", "close-first", "attempt-two"]);
  });

  it("preserves open-registry forced reconnect lifecycle behavior", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const oldClient = createMockClient();
    const replacement = createMockClient();
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    internals.clients.set(packageId, oldClient);
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);

    await expect(registry.connectForCatalog(packageId, { forceReconnect: true }))
      .resolves.toMatchObject({ kind: "connected", client: replacement });

    expect(oldClient.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(lifecycleEvents).toEqual(["client_evicted", "client_created"]);
  });

  it("preserves ordinary unhealthy eviction and replacement", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const unhealthyClient = createMockClient({
      healthCheck: vi.fn().mockResolvedValue("error"),
    });
    const replacement = createMockClient();
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    internals.clients.set(packageId, unhealthyClient);
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);

    await expect(registry.getClient(packageId)).resolves.toBe(replacement);

    expect(unhealthyClient.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(lifecycleEvents).toEqual(["client_evicted", "client_created"]);
    expect(registry.getChildStats()[0]).toMatchObject({ eviction_count: 1 });
  });

  it("moves an open-registry lease from an unhealthy cached client to its replacement", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const unhealthyClient = createMockClient({
      healthCheck: vi.fn().mockResolvedValue("error"),
    });
    const replacement = createMockClient({
      callTool: vi.fn().mockImplementation(async () => {
        expect(internals.activeLeases.get(packageId)).toBe(1);
        expect(internals.activeLeaseClients?.get(packageId)?.get(unhealthyClient) ?? 0)
          .toBe(0);
        expect(internals.activeLeaseClients?.get(packageId)?.get(replacement)).toBe(1);
        return { content: [] };
      }),
    });
    internals.clients.set(packageId, unhealthyClient);
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);

    await expect(registry.callTool(packageId, "replacement", {})).resolves.toEqual({
      content: [],
    });

    expect(unhealthyClient.close).toHaveBeenCalledOnce();
    expect(replacement.callTool).toHaveBeenCalledOnce();
    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(internals.activeLeases.size).toBe(0);
    expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
  });

  it("unwinds cached-client lease ownership when an open-registry health probe rejects", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const healthError = new Error("health probe failed");
    const client = createMockClient({
      healthCheck: vi.fn().mockRejectedValue(healthError),
    });
    internals.clients.set(packageId, client);

    await expect(registry.callTool(packageId, "probe-rejection", {})).rejects.toBe(healthError);

    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(internals.clients.get(packageId)).toBe(client);
    expect(internals.activeLeases.size).toBe(0);
    expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
  });

  it("structurally owns both concrete constructors and both retry attempts", async () => {
    const source = await readFile(new URL("../src/registry.ts", import.meta.url), "utf8");
    const retryStart = source.indexOf("  private async createAndConnectClientWithOneRetry(");
    const createStart = source.indexOf("  private async createAndConnectClient(", retryStart + 1);
    const createEnd = source.indexOf("  /**\n   * Normalize a single server entry", createStart);
    const retrySource = source.slice(retryStart, createStart);
    const createSource = source.slice(createStart, createEnd);

    expect(retryStart).toBeGreaterThan(-1);
    expect(createStart).toBeGreaterThan(retryStart);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(retrySource.match(/this\.createAndConnectClient\(/g)).toHaveLength(2);
    expect(retrySource.match(/this\.ownConstructedClient\(packageId, client\);/g))
      .toHaveLength(2);
    expect(createSource.match(/new (?:Stdio|Http)McpClient\(/g)).toHaveLength(2);
    expect(createSource).toContain("this.ownConstructedClient(packageId, client);");
  });

  it("owns and closes the real retry client when shutdown crosses attempt two", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const secondAttemptStarted = deferred<void>();
    const secondConnect = deferred<void>();
    const constructed: StdioMcpClient[] = [];
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));

    vi.spyOn(StdioMcpClient.prototype, "connect").mockImplementation(function () {
      constructed.push(this);
      if (constructed.length === 1) {
        return Promise.reject(new Error("first transport failed"));
      }
      secondAttemptStarted.resolve(undefined);
      return secondConnect.promise;
    });
    const close = vi.spyOn(StdioMcpClient.prototype, "close").mockResolvedValue(undefined);

    const clientOutcome = registry.getClient(packageId).then(
      () => ({ status: "fulfilled" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await secondAttemptStarted.promise;
    const shutdown = registry.closeAll();
    secondConnect.resolve(undefined);

    const outcome = await clientOutcome;
    await expect(shutdown).resolves.toBeUndefined();
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(RegistryClosedError);
    expect(constructed).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(new Set(close.mock.instances)).toEqual(new Set(constructed));
    expect(lifecycleEvents).toEqual([]);
    expect(registry.getChildStats()[0]).toMatchObject({
      connect_retry_count: 1,
      connect_retry_recovered_count: 0,
      connect_retry_failed_count: 0,
    });
  });

  it("treats ordinary drained connection rejection as successful shutdown", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const connectCompletion = deferred<never>();
    const constructedClient = createMockClient();

    vi.spyOn(internals, "createAndConnectClient").mockImplementation(
      async (_id, _config, onClientCreated) => {
        onClientCreated?.(constructedClient);
        return connectCompletion.promise;
      },
    );

    const clientOutcome = registry.getClient(packageId).then(
      () => ({ status: "fulfilled" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const shutdown = registry.closeAll();
    connectCompletion.reject(new Error("ordinary connection failure while draining"));

    await expect(shutdown).resolves.toBeUndefined();
    const outcome = await clientOutcome;
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(RegistryClosedError);
    expect(constructedClient.close).toHaveBeenCalledOnce();
    expect(internals.constructedClients.size).toBe(0);
    expect(internals.activeCloseOperations.size).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "MCP client connect failed; retry suppressed during registry shutdown",
      expect.objectContaining({
        package_id: packageId,
        attempt: 1,
        error: "ordinary connection failure while draining",
      }),
    );
  });

  it.each(["ok", "needs_auth", "error"] as const)(
    "blocks post-latch health-check %s resumption without lifecycle mutation",
    async (health) => {
      const packageId = "GoogleWorkspace-acme";
      const registry = createRegistry(packageId);
      const internals = registry as unknown as RegistryInternals;
      const healthStarted = deferred<void>();
      const healthResult = deferred<"ok" | "needs_auth" | "error">();
      const client = createMockClient({
        healthCheck: vi.fn().mockImplementation(() => {
          healthStarted.resolve(undefined);
          return healthResult.promise;
        }),
      });
      const lifecycleEvents: string[] = [];
      registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
      internals.clients.set(packageId, client);

      const clientOutcome = registry.getClient(packageId).then(
        () => ({ status: "fulfilled" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await healthStarted.promise;
      const shutdown = registry.closeAll();
      healthResult.resolve(health);

      const outcome = await clientOutcome;
      await expect(shutdown).resolves.toBeUndefined();
      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBeInstanceOf(RegistryClosedError);
      expect(client.close).toHaveBeenCalledOnce();
      expect(lifecycleEvents).toEqual([]);
      expect(registry.getChildStats()[0]).toMatchObject({
        spawn_count: 0,
        eviction_count: 0,
      });
      expect(internals.clients.size).toBe(0);
      expect(internals.lastActivity.size).toBe(0);
    },
  );

  it("drains an idle-reaper close through the shared exactly-once closer", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const closeStarted = deferred<void>();
    const closeCompletion = deferred<void>();
    const client = createMockClient({
      hasPendingRequests: vi.fn().mockReturnValue(false),
      close: vi.fn().mockImplementation(() => {
        closeStarted.resolve(undefined);
        return closeCompletion.promise;
      }),
    });
    internals.clients.set(packageId, client);
    internals.lastActivity.set(packageId, 0);

    internals.sweepIdleClients();
    await closeStarted.promise;
    let shutdownSettled = false;
    const shutdown = registry.closeAll().finally(() => {
      shutdownSettled = true;
    });
    try {
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      closeCompletion.resolve(undefined);
      await expect(shutdown).resolves.toBeUndefined();
      expect(client.close).toHaveBeenCalledOnce();
      expect(internals.activeCloseOperations.size).toBe(0);
    } finally {
      closeCompletion.resolve(undefined);
      await Promise.allSettled([shutdown]);
    }
  });

  it("retains a delete-before-close forced eviction until terminal settlement", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const closeStarted = deferred<void>();
    const closeCompletion = deferred<void>();
    const client = createMockClient({
      close: vi.fn().mockImplementation(() => {
        closeStarted.resolve(undefined);
        return closeCompletion.promise;
      }),
    });
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    internals.clients.set(packageId, client);

    const reconnect = registry.connectForCatalog(packageId, { forceReconnect: true });
    await closeStarted.promise;
    expect(internals.clients.has(packageId)).toBe(false);
    expect(internals.evictionPromises.has(packageId)).toBe(true);

    let shutdownSettled = false;
    const shutdown = registry.closeAll().finally(() => {
      shutdownSettled = true;
    });
    try {
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      expect(client.close).toHaveBeenCalledOnce();

      closeCompletion.resolve(undefined);
      await expect(reconnect).resolves.toMatchObject({
        kind: "transient_failure",
        error: expect.any(RegistryClosedError),
      });
      await expect(shutdown).resolves.toBeUndefined();
      expect(client.close).toHaveBeenCalledOnce();
      expect(lifecycleEvents).toEqual([]);
      expect(internals.evictionPromises.size).toBe(0);
      expect(internals.activeCloseOperations.size).toBe(0);
    } finally {
      closeCompletion.resolve(undefined);
      await Promise.allSettled([reconnect, shutdown]);
    }
  });

  it("closes connected clients before held-lease eviction drainage", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const closeStarted = deferred<void>();
    const closeCompletion = deferred<void>();
    const client = createMockClient({
      hasPendingRequests: vi.fn().mockReturnValue(true),
      close: vi.fn().mockImplementation(() => {
        closeStarted.resolve(undefined);
        return closeCompletion.promise;
      }),
    });
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    internals.clients.set(packageId, client);
    internals.activeLeases.set(packageId, 1);

    const reconnect = registry.connectForCatalog(packageId, { forceReconnect: true });
    await Promise.resolve();
    expect(internals.evictionPromises.has(packageId)).toBe(true);

    let shutdownSettled = false;
    const shutdown = registry.closeAll().finally(() => {
      shutdownSettled = true;
    });
    try {
      await closeStarted.promise;
      expect(client.close).toHaveBeenCalledOnce();
      expect(internals.activeLeases.get(packageId)).toBe(1);
      expect(shutdownSettled).toBe(false);

      internals.releaseLease(packageId);
      closeCompletion.resolve(undefined);
      const reconnectOutcome = await reconnect;
      await expect(shutdown).resolves.toBeUndefined();
      expect(reconnectOutcome).toMatchObject({
        kind: "transient_failure",
        error: expect.any(RegistryClosedError),
      });
      expect(lifecycleEvents).toEqual([]);
      expect(internals.evictionPromises.size).toBe(0);
      expect(internals.activeLeases.size).toBe(0);
      expect(loggerMock.error).not.toHaveBeenCalledWith(
        "MCP client cleanup failed during registry shutdown",
        expect.objectContaining({ phase: "lease_accounting" }),
      );
    } finally {
      if ((internals.activeLeases.get(packageId) ?? 0) > 0) {
        internals.releaseLease(packageId);
      }
      closeCompletion.resolve(undefined);
      await Promise.allSettled([reconnect, shutdown]);
    }
  });

  it("rejects terminal drainage when close discards a queued call lease", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const runningRequest = deferred<never>();
    const discardedQueuedRequest = deferred<never>();
    const runningStarted = deferred<void>();
    const queuedStarted = deferred<void>();
    const closeSettled = deferred<void>();
    const transportClosedError = new Error("transport closed");
    const cleanupRelease = new Error("failure-safe queued-call release");
    let pendingRequests = true;
    let queuedCallStatus: "pending" | "settled" = "pending";
    let reentrantShutdown: Promise<void> | undefined;
    const client = createMockClient({
      hasPendingRequests: vi.fn(() => pendingRequests),
      callTool: vi
        .fn()
        .mockImplementationOnce(() => {
          runningStarted.resolve(undefined);
          return runningRequest.promise;
        })
        .mockImplementationOnce(() => {
          queuedStarted.resolve(undefined);
          return discardedQueuedRequest.promise;
        }),
      close: vi.fn().mockImplementation(() => {
        pendingRequests = false;
        runningRequest.reject(transportClosedError);
        reentrantShutdown = registry.closeAll();
        closeSettled.resolve(undefined);
        return Promise.resolve();
      }),
    });
    internals.clients.set(packageId, client);

    const runningOutcome = registry.callTool(packageId, "running", {}).catch(
      (error: unknown) => error,
    );
    await runningStarted.promise;
    const queuedOutcome = registry.callTool(packageId, "queued", {}).then(
      () => {
        queuedCallStatus = "settled";
      },
      () => {
        queuedCallStatus = "settled";
      },
    );
    await queuedStarted.promise;
    expect(internals.activeLeases.get(packageId)).toBe(2);

    let shutdownStatus: "pending" | "fulfilled" | "rejected" = "pending";
    let firstShutdownError: unknown;
    let secondShutdownError: unknown;
    const firstShutdown = registry.closeAll();
    const secondShutdown = registry.closeAll();
    expect(secondShutdown).toBe(firstShutdown);
    expect(reentrantShutdown).toBe(firstShutdown);
    const firstShutdownOutcome = firstShutdown.then(
      () => {
        shutdownStatus = "fulfilled";
      },
      (error: unknown) => {
        shutdownStatus = "rejected";
        firstShutdownError = error;
      },
    );
    const secondShutdownOutcome = secondShutdown.catch((error: unknown) => {
      secondShutdownError = error;
    });
    let reentrantShutdownError: unknown;
    const reentrantShutdownOutcome = reentrantShutdown?.catch((error: unknown) => {
      reentrantShutdownError = error;
    });

    try {
      await closeSettled.promise;
      const closeOperations = Array.from(internals.activeCloseOperations.values());
      await Promise.allSettled(closeOperations.map(({ promise }) => promise));
      await runningOutcome;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect({
        clientPendingRequests: client.hasPendingRequests?.(),
        queuedCallStatus,
        shutdownStatus,
        activeLeases: internals.activeLeases.size,
        leaseDrainWaiters: internals.leaseDrainWaiters.size,
      }).toEqual({
        clientPendingRequests: false,
        queuedCallStatus: "pending",
        shutdownStatus: "rejected",
        activeLeases: 0,
        leaseDrainWaiters: 0,
      });
      expect(firstShutdownError).toBeInstanceOf(AggregateError);
      expect(secondShutdownError).toBe(firstShutdownError);
      expect(reentrantShutdownError).toBe(firstShutdownError);
      expect((firstShutdownError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
        }),
      ]);
      expect(loggerMock.error).toHaveBeenCalledWith(
        "MCP client cleanup failed during registry shutdown",
        expect.objectContaining({
          package_id: packageId,
          phase: "lease_accounting",
          error: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
        }),
      );
      expect(client.close).toHaveBeenCalledOnce();
      expect(internals.clients.size).toBe(0);
      expect(internals.clientPromises.size).toBe(0);
      expect(internals.constructedClients.size).toBe(0);
      expect(internals.evictionPromises.size).toBe(0);
      expect(internals.activeCloseOperations.size).toBe(0);
      expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
      expect(internals.terminalCloseSettledClients?.size ?? 0).toBe(0);
      expect(internals.terminalCleanupFailures).toEqual([]);
      expect(internals.lastActivity.size).toBe(0);
      expect(internals.authRequiredPackages.size).toBe(0);
    } finally {
      discardedQueuedRequest.reject(cleanupRelease);
      await Promise.allSettled([
        queuedOutcome,
        firstShutdownOutcome,
        secondShutdownOutcome,
        reentrantShutdownOutcome,
      ]);
    }
  });

  it("rejects terminal drainage when close discards a pre-bind health probe lease", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const runningRequest = deferred<never>();
    const discardedHealthProbe = deferred<"ok">();
    const runningStarted = deferred<void>();
    const healthProbeStarted = deferred<void>();
    const closeSettled = deferred<void>();
    const transportClosedError = new Error("transport closed");
    let pendingRequests = true;
    let healthCheckCount = 0;
    let healthProbeStatus: "pending" | "settled" = "pending";
    let preBindCallerStatus: "pending" | "settled" = "pending";
    let reentrantShutdown: Promise<void> | undefined;
    const healthProbeOutcome = discardedHealthProbe.promise.then(
      () => {
        healthProbeStatus = "settled";
      },
      () => {
        healthProbeStatus = "settled";
      },
    );
    const client = createMockClient({
      healthCheck: vi.fn().mockImplementation(() => {
        healthCheckCount += 1;
        if (healthCheckCount === 1) return Promise.resolve("ok");
        healthProbeStarted.resolve(undefined);
        return discardedHealthProbe.promise;
      }),
      hasPendingRequests: vi.fn(() => pendingRequests),
      callTool: vi.fn().mockImplementation(() => {
        runningStarted.resolve(undefined);
        return runningRequest.promise;
      }),
      close: vi.fn().mockImplementation(() => {
        pendingRequests = false;
        runningRequest.reject(transportClosedError);
        reentrantShutdown = registry.closeAll();
        closeSettled.resolve(undefined);
        return Promise.resolve();
      }),
    });
    internals.clients.set(packageId, client);

    const runningOutcome = registry.callTool(packageId, "running", {}).catch(
      (error: unknown) => error,
    );
    await runningStarted.promise;
    const preBindOutcome = registry.callTool(packageId, "pre-bind", {}).then(
      () => {
        preBindCallerStatus = "settled";
      },
      () => {
        preBindCallerStatus = "settled";
      },
    );
    await healthProbeStarted.promise;
    const boundLeasesBeforeShutdown = Array.from(
      internals.activeLeaseClients?.get(packageId)?.values() ?? [],
    ).reduce((total, count) => total + count, 0);

    let shutdownStatus: "pending" | "fulfilled" | "rejected" = "pending";
    let firstShutdownError: unknown;
    let secondShutdownError: unknown;
    const firstShutdown = registry.closeAll();
    const secondShutdown = registry.closeAll();
    expect(secondShutdown).toBe(firstShutdown);
    expect(reentrantShutdown).toBe(firstShutdown);
    const firstShutdownOutcome = firstShutdown.then(
      () => {
        shutdownStatus = "fulfilled";
      },
      (error: unknown) => {
        shutdownStatus = "rejected";
        firstShutdownError = error;
      },
    );
    const secondShutdownOutcome = secondShutdown.catch((error: unknown) => {
      secondShutdownError = error;
    });
    let reentrantShutdownError: unknown;
    const reentrantShutdownOutcome = reentrantShutdown?.catch((error: unknown) => {
      reentrantShutdownError = error;
    });

    try {
      await closeSettled.promise;
      const closeOperations = Array.from(internals.activeCloseOperations.values());
      await Promise.allSettled(closeOperations.map(({ promise }) => promise));
      await runningOutcome;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect({
        activeLeasesBeforeShutdown: 2,
        boundLeasesBeforeShutdown,
        clientPendingRequests: client.hasPendingRequests?.(),
        healthProbeStatus,
        preBindCallerStatus,
        shutdownStatus,
        activeLeases: internals.activeLeases.size,
        leaseDrainWaiters: internals.leaseDrainWaiters.size,
      }).toEqual({
        activeLeasesBeforeShutdown: 2,
        boundLeasesBeforeShutdown: 2,
        clientPendingRequests: false,
        healthProbeStatus: "pending",
        preBindCallerStatus: "pending",
        shutdownStatus: "rejected",
        activeLeases: 0,
        leaseDrainWaiters: 0,
      });
      expect(firstShutdownError).toBeInstanceOf(AggregateError);
      expect(secondShutdownError).toBe(firstShutdownError);
      expect(reentrantShutdownError).toBe(firstShutdownError);
      expect((firstShutdownError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
        }),
      ]);
      expect(loggerMock.error).toHaveBeenCalledWith(
        "MCP client cleanup failed during registry shutdown",
        expect.objectContaining({
          package_id: packageId,
          phase: "lease_accounting",
          error: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
        }),
      );
      expect(client.close).toHaveBeenCalledOnce();
      expect(internals.clients.size).toBe(0);
      expect(internals.clientPromises.size).toBe(0);
      expect(internals.constructedClients.size).toBe(0);
      expect(internals.evictionPromises.size).toBe(0);
      expect(internals.activeCloseOperations.size).toBe(0);
      expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
      expect(internals.terminalCloseSettledClients?.size ?? 0).toBe(0);
      expect(internals.terminalCleanupFailures).toEqual([]);
      expect(internals.lastActivity.size).toBe(0);
      expect(internals.authRequiredPackages.size).toBe(0);
    } finally {
      discardedHealthProbe.resolve("ok");
      await Promise.allSettled([
        healthProbeOutcome,
        preBindOutcome,
        firstShutdownOutcome,
        secondShutdownOutcome,
        reentrantShutdownOutcome,
      ]);
    }
  });

  it.each(["true", "missing", "throwing"] as const)(
    "keeps terminal shutdown pending for a live pre-bind health probe with a %s pending signal",
    async (pendingSignal) => {
      const packageId = "GoogleWorkspace-acme";
      const registry = createRegistry(packageId);
      const internals = registry as unknown as RegistryInternals;
      const healthResult = deferred<"ok">();
      const healthStarted = deferred<void>();
      let pendingRequests = true;
      const hasPendingRequests = pendingSignal === "missing"
        ? undefined
        : pendingSignal === "throwing"
          ? vi.fn(() => {
              throw new Error("pending signal unavailable");
            })
          : vi.fn(() => pendingRequests);
      const client = createMockClient({
        healthCheck: vi.fn().mockImplementation(async () => {
          healthStarted.resolve(undefined);
          const result = await healthResult.promise;
          pendingRequests = false;
          return result;
        }),
        ...(hasPendingRequests ? { hasPendingRequests } : {}),
      });
      internals.clients.set(packageId, client);

      const callerOutcome = registry.callTool(packageId, "live-health", {}).catch(
        (error: unknown) => error,
      );
      await healthStarted.promise;
      let shutdownStatus: "pending" | "fulfilled" | "rejected" = "pending";
      const shutdown = registry.closeAll().then(
        () => {
          shutdownStatus = "fulfilled";
        },
        () => {
          shutdownStatus = "rejected";
        },
      );

      try {
        const closeOperations = Array.from(internals.activeCloseOperations.values());
        await Promise.allSettled(closeOperations.map(({ promise }) => promise));
        await Promise.resolve();
        await Promise.resolve();

        expect(shutdownStatus).toBe("pending");
        expect(internals.activeLeases.get(packageId)).toBe(1);
        expect(internals.activeLeaseClients?.get(packageId)?.get(client)).toBe(1);
        if (pendingSignal === "true") {
          expect(client.hasPendingRequests?.()).toBe(true);
        } else if (pendingSignal === "missing") {
          expect(client.hasPendingRequests).toBeUndefined();
        } else {
          expect(() => client.hasPendingRequests?.()).toThrow("pending signal unavailable");
        }
        expect(loggerMock.error).not.toHaveBeenCalledWith(
          "MCP client cleanup failed during registry shutdown",
          expect.objectContaining({ phase: "lease_accounting" }),
        );

        healthResult.resolve("ok");
        await expect(callerOutcome).resolves.toBeInstanceOf(RegistryClosedError);
        await expect(shutdown).resolves.toBeUndefined();
        expect(shutdownStatus).toBe("fulfilled");
        expect(client.close).toHaveBeenCalledOnce();
        expect(internals.activeLeases.size).toBe(0);
        expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
        expect(internals.leaseDrainWaiters.size).toBe(0);
      } finally {
        healthResult.resolve("ok");
        await Promise.allSettled([callerOutcome, shutdown]);
      }
    },
  );

  it.each(["unhealthy eviction", "restart"] as const)(
    "rejects terminal drainage after a pre-latch %s discards a queued stdio lease",
    async (closeRoute) => {
      const packageId = "GoogleWorkspace-acme";
      const registry = createRegistry(packageId);
      const internals = registry as unknown as RegistryInternals;
      const config = registry.getPackage(packageId);
      if (!config) throw new Error(`Missing package config for ${packageId}`);

      const runningRequest = deferred<never>();
      const runningStarted = deferred<void>();
      const secondHealthChecked = deferred<void>();
      const transportClosedError = new Error("transport closed by pre-latch close");
      let healthCheckCount = 0;
      let queuedCallStatus: "pending" | "fulfilled" | "rejected" = "pending";
      let reentrantShutdown: Promise<void> | undefined;
      let reconciliationCount = 0;
      const reconciliationReached = deferred<void>();

      const client = new StdioMcpClient(packageId, config);
      const stdioInternals = client as unknown as {
        client: {
          callTool: (...args: unknown[]) => Promise<unknown>;
          close: () => Promise<void>;
        };
        transport: { pid: number | null };
        requestQueue: { pending: number; size: number };
      };
      const sdkCallTool = vi.fn().mockImplementation(() => {
        runningStarted.resolve(undefined);
        return runningRequest.promise;
      });
      stdioInternals.client = {
        callTool: sdkCallTool,
        close: vi.fn().mockImplementation(() => {
          runningRequest.reject(transportClosedError);
          return Promise.resolve();
        }),
      };
      stdioInternals.transport = { pid: null };
      vi.spyOn(client, "isTransportClosed").mockReturnValue(false);
      vi.spyOn(client, "healthCheck").mockImplementation(() => {
        healthCheckCount += 1;
        if (healthCheckCount === 2) secondHealthChecked.resolve(undefined);
        return Promise.resolve(
          closeRoute === "unhealthy eviction" && healthCheckCount === 3
            ? "error"
            : "ok",
        );
      });
      const closeSpy = vi.spyOn(client, "close");
      internals.clients.set(packageId, client);

      const replacement = createMockClient();
      const createSpy = vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);
      const originalReconcile = internals.reconcileNonDrainableTerminalLeases.bind(registry);
      vi.spyOn(internals, "reconcileNonDrainableTerminalLeases").mockImplementation(() => {
        originalReconcile();
        reconciliationCount += 1;
        reconciliationReached.resolve(undefined);
      });

      const runningOutcome = registry.callTool(packageId, "running", {}).catch(
        (error: unknown) => error,
      );
      await runningStarted.promise;
      const queuedOutcome = registry.callTool(packageId, "queued", {}).then(
        () => {
          queuedCallStatus = "fulfilled";
        },
        () => {
          queuedCallStatus = "rejected";
        },
      );
      await secondHealthChecked.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(stdioInternals.requestQueue).toMatchObject({ pending: 1, size: 1 });
      expect(internals.activeLeases.get(packageId)).toBe(2);
      expect(internals.activeLeaseClients?.get(packageId)?.get(client)).toBe(2);

      let firstShutdown: Promise<void> | undefined;
      let secondShutdown: Promise<void> | undefined;
      let firstShutdownError: unknown;
      let secondShutdownError: unknown;
      let reentrantShutdownError: unknown;
      let shutdownStatus: "pending" | "fulfilled" | "rejected" = "pending";
      let firstShutdownOutcome: Promise<void> | undefined;
      let secondShutdownOutcome: Promise<void> | undefined;
      let reentrantShutdownOutcome: Promise<void> | undefined;

      try {
        if (closeRoute === "unhealthy eviction") {
          await expect(registry.getClient(packageId)).resolves.toBe(replacement);
        } else {
          await expect(registry.restartPackage(packageId)).resolves.toEqual({
            success: true,
            message: `Package '${packageId}' restarted. Next tool call will reconnect with fresh configuration.`,
          });
        }
        await runningOutcome;
        await Promise.resolve();
        await Promise.resolve();

        expect(internals.terminal).toBe(false);
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(client.hasPendingRequests()).toBe(false);
        expect(stdioInternals.requestQueue).toMatchObject({ pending: 0, size: 0 });
        expect(queuedCallStatus).toBe("pending");
        expect(internals.activeLeases.get(packageId)).toBe(1);
        expect(internals.activeLeaseClients?.get(packageId)?.get(client)).toBe(1);
        if (closeRoute === "unhealthy eviction") {
          expect(internals.clients.get(packageId)).toBe(replacement);
          expect(createSpy).toHaveBeenCalledOnce();
        } else {
          expect(internals.clients.has(packageId)).toBe(false);
          expect(createSpy).not.toHaveBeenCalled();
        }

        const reentrantClient = createMockClient({
          close: vi.fn().mockImplementation(() => {
            reentrantShutdown = registry.closeAll();
            return Promise.resolve();
          }),
        });
        internals.clients.set("shutdown-sentinel", reentrantClient);

        firstShutdown = registry.closeAll();
        secondShutdown = registry.closeAll();
        expect(secondShutdown).toBe(firstShutdown);
        expect(reentrantShutdown).toBe(firstShutdown);
        firstShutdownOutcome = firstShutdown.then(
          () => {
            shutdownStatus = "fulfilled";
          },
          (error: unknown) => {
            shutdownStatus = "rejected";
            firstShutdownError = error;
          },
        );
        secondShutdownOutcome = secondShutdown.catch((error: unknown) => {
          secondShutdownError = error;
        });
        reentrantShutdownOutcome = reentrantShutdown?.catch((error: unknown) => {
          reentrantShutdownError = error;
        });

        await reconciliationReached.promise;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect({
          reconciliationCount,
          clientPendingRequests: client.hasPendingRequests(),
          queuedCallStatus,
          shutdownStatus,
          activeLeases: internals.activeLeases.size,
          leaseDrainWaiters: internals.leaseDrainWaiters.size,
        }).toEqual({
          reconciliationCount: 1,
          clientPendingRequests: false,
          queuedCallStatus: "pending",
          shutdownStatus: "rejected",
          activeLeases: 0,
          leaseDrainWaiters: 0,
        });
        expect(firstShutdownError).toBeInstanceOf(AggregateError);
        expect(secondShutdownError).toBe(firstShutdownError);
        expect(reentrantShutdownError).toBe(firstShutdownError);
        expect((firstShutdownError as AggregateError).errors).toEqual([
          expect.objectContaining({
            message: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
          }),
        ]);
        expect(loggerMock.error).toHaveBeenCalledWith(
          "MCP client cleanup failed during registry shutdown",
          expect.objectContaining({
            package_id: packageId,
            phase: "lease_accounting",
            error: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
          }),
        );
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(reentrantClient.close).toHaveBeenCalledOnce();
        expect(internals.clients.size).toBe(0);
        expect(internals.clientPromises.size).toBe(0);
        expect(internals.constructedClients.size).toBe(0);
        expect(internals.evictionPromises.size).toBe(0);
        expect(internals.activeCloseOperations.size).toBe(0);
        expect(internals.activeLeases.size).toBe(0);
        expect(internals.activeLeaseClients?.size ?? 0).toBe(0);
        expect(internals.terminalCloseSettledClients?.size ?? 0).toBe(0);
        expect(internals.leaseDrainWaiters.size).toBe(0);
        expect(internals.terminalCleanupFailures).toEqual([]);
        expect(internals.lastActivity.size).toBe(0);
        expect(internals.authRequiredPackages.size).toBe(0);
      } finally {
        if ((internals.activeLeases.get(packageId) ?? 0) > 0) {
          internals.activeLeaseClients?.delete(packageId);
          while ((internals.activeLeases.get(packageId) ?? 0) > 0) {
            internals.releaseLease(packageId);
          }
        }
        if (closeSpy.mock.calls.length === 0) {
          await client.close();
        }
        await Promise.allSettled([
          runningOutcome,
          firstShutdownOutcome,
          secondShutdownOutcome,
          reentrantShutdownOutcome,
        ]);
        void queuedOutcome;
      }
    },
  );

  it("re-evaluates terminal orphan proof after a partial lease release", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    let pendingRequests = true;
    let reconciliationCount = 0;
    const firstReconciliationReached = deferred<void>();
    const client = createMockClient({
      hasPendingRequests: vi.fn(() => pendingRequests),
    });
    internals.clients.set(packageId, client);
    internals.activeLeases.set(packageId, 2);
    internals.activeLeaseClients?.set(packageId, new Map([[client, 2]]));
    const originalReconcile = internals.reconcileNonDrainableTerminalLeases.bind(registry);
    vi.spyOn(internals, "reconcileNonDrainableTerminalLeases").mockImplementation(() => {
      originalReconcile();
      reconciliationCount += 1;
      firstReconciliationReached.resolve(undefined);
    });

    let shutdownStatus: "pending" | "fulfilled" | "rejected" = "pending";
    let shutdownError: unknown;
    const shutdown = registry.closeAll();
    const shutdownOutcome = shutdown.then(
      () => {
        shutdownStatus = "fulfilled";
      },
      (error: unknown) => {
        shutdownStatus = "rejected";
        shutdownError = error;
      },
    );

    try {
      await firstReconciliationReached.promise;
      expect(reconciliationCount).toBe(1);
      expect(internals.leaseDrainWaiters.get(packageId)).toHaveLength(1);
      expect(shutdownStatus).toBe("pending");

      pendingRequests = false;
      internals.unbindLeaseFromClient(packageId, client);
      internals.releaseLease(packageId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect({
        reconciliationCount,
        shutdownStatus,
        activeLeases: internals.activeLeases.size,
        activeLeaseClients: internals.activeLeaseClients?.size ?? 0,
        leaseDrainWaiters: internals.leaseDrainWaiters.size,
      }).toEqual({
        reconciliationCount: 2,
        shutdownStatus: "rejected",
        activeLeases: 0,
        activeLeaseClients: 0,
        leaseDrainWaiters: 0,
      });
      expect(shutdownError).toBeInstanceOf(AggregateError);
      expect((shutdownError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: `Terminal close discarded ${packageId} work with 1 active lease(s)`,
        }),
      ]);
      expect(client.close).toHaveBeenCalledOnce();
      expect(internals.clients.size).toBe(0);
      expect(internals.clientPromises.size).toBe(0);
      expect(internals.constructedClients.size).toBe(0);
      expect(internals.evictionPromises.size).toBe(0);
      expect(internals.activeCloseOperations.size).toBe(0);
      expect(internals.terminalCleanupFailures).toEqual([]);
    } finally {
      if ((internals.activeLeases.get(packageId) ?? 0) > 0) {
        internals.activeLeaseClients?.delete(packageId);
        while ((internals.activeLeases.get(packageId) ?? 0) > 0) {
          internals.releaseLease(packageId);
        }
      }
      await Promise.allSettled([shutdownOutcome]);
    }
  });

  it("gates wholly post-latch entry points with deterministic terminal results", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const createSpy = vi.spyOn(internals, "createAndConnectClient");
    await registry.closeAll();
    const sentinelClient = createMockClient();
    internals.clients.set(packageId, sentinelClient);

    try {
      await expect(registry.getClient(packageId)).rejects.toMatchObject({
        name: "RegistryClosedError",
        code: "ERR_REGISTRY_CLOSED",
      });
      await expect(registry.evictClient(packageId, "explicit")).resolves.toBeUndefined();
      await expect(registry.restartPackage(packageId)).resolves.toEqual({
        success: false,
        message: `Package '${packageId}' cannot be restarted because the registry is shutting down`,
      });
      await expect(registry.connectForCatalog(packageId, { forceReconnect: true }))
        .resolves.toMatchObject({
          kind: "transient_failure",
          error: expect.any(RegistryClosedError),
        });
      expect(internals.clients.get(packageId)).toBe(sentinelClient);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      internals.clients.delete(packageId);
      await sentinelClient.close();
    }
  });

  it("publishes the shared barrier before a client close can re-enter shutdown", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    let reentrantShutdown: Promise<void> | undefined;
    const client = createMockClient({
      close: vi.fn().mockImplementation(() => {
        reentrantShutdown = registry.closeAll();
        return Promise.resolve();
      }),
    });
    internals.clients.set(packageId, client);

    const shutdown = registry.closeAll();
    expect(reentrantShutdown).toBe(shutdown);
    await expect(shutdown).resolves.toBeUndefined();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("best-effort drains every client then rejects one shared barrier on close failure", async () => {
    const registry = createRegistry("GoogleWorkspace-acme");
    const internals = registry as unknown as RegistryInternals;
    const cleanupError = new Error("close exploded");
    const failingClient = createMockClient({
      close: vi.fn().mockRejectedValue(cleanupError),
    });
    const healthyClient = createMockClient();
    internals.clients.set("GoogleWorkspace-acme", failingClient);
    internals.clients.set("Slack-acme", healthyClient);

    const firstShutdown = registry.closeAll();
    const secondShutdown = registry.closeAll();
    expect(secondShutdown).toBe(firstShutdown);
    await expect(firstShutdown).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to close 1 MCP client(s) during registry shutdown",
    });

    expect(failingClient.close).toHaveBeenCalledOnce();
    expect(healthyClient.close).toHaveBeenCalledOnce();
    expect(internals.clients.size).toBe(0);
    expect(internals.constructedClients.size).toBe(0);
    expect(internals.activeCloseOperations.size).toBe(0);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "MCP client cleanup failed during registry shutdown",
      expect.objectContaining({
        package_id: "GoogleWorkspace-acme",
        phase: "shutdown",
        error: cleanupError.message,
      }),
    );
  });

  it("returns a terminal restart result when shutdown crosses a pending connection", async () => {
    const packageId = "GoogleWorkspace-acme";
    const registry = createRegistry(packageId);
    const internals = registry as unknown as RegistryInternals;
    const connectCompletion = deferred<void>();
    const client = createMockClient();
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    vi.spyOn(internals, "createAndConnectClient").mockImplementation(
      async (_id, _config, onClientCreated) => {
        onClientCreated?.(client);
        await connectCompletion.promise;
        return client;
      },
    );

    const pendingGet = registry.getClient(packageId).catch((error: unknown) => error);
    const restart = registry.restartPackage(packageId);
    const shutdown = registry.closeAll();
    try {
      connectCompletion.resolve(undefined);
      await expect(restart).resolves.toEqual({
        success: false,
        message: `Package '${packageId}' cannot be restarted because the registry is shutting down`,
      });
      await expect(pendingGet).resolves.toBeInstanceOf(RegistryClosedError);
      await expect(shutdown).resolves.toBeUndefined();
      expect(client.close).toHaveBeenCalledOnce();
      expect(lifecycleEvents).toEqual([]);
      expect(internals.clients.size).toBe(0);
      expect(internals.clientPromises.size).toBe(0);
    } finally {
      connectCompletion.resolve(undefined);
      await Promise.allSettled([restart, pendingGet, shutdown]);
    }
  });

  it("keeps shutdown pending until a constructed client is terminally owned", async () => {
    const connectingPackageId = "GoogleWorkspace-acme";
    const connectedPackageId = "Slack-acme";
    const registry = createRegistry(connectingPackageId);
    const internals = registry as unknown as RegistryInternals;
    const connectedClose = deferred<void>();
    const connectCompletion = deferred<void>();
    const connectedClient = createMockClient({
      close: vi.fn().mockReturnValue(connectedClose.promise),
    });
    const connectingClient = createMockClient();
    const lifecycleEvents: string[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event.type));
    internals.clients.set(connectedPackageId, connectedClient);

    vi.spyOn(internals, "createAndConnectClient").mockImplementation(
      async (_id, _config, onClientCreated) => {
        onClientCreated?.(connectingClient);
        await connectCompletion.promise;
        return connectingClient;
      },
    );

    const firstCaller = registry.getClient(connectingPackageId);
    const joiningCaller = registry.getClient(connectingPackageId);
    const firstOutcome = firstCaller.then(
      () => ({ status: "fulfilled" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const joiningOutcome = joiningCaller.then(
      () => ({ status: "fulfilled" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let firstCloseSettled = false;
    let secondCloseSettled = false;
    const firstClose = registry.closeAll().then(
      () => {
        firstCloseSettled = true;
        return "fulfilled" as const;
      },
      () => {
        firstCloseSettled = true;
        return "rejected" as const;
      },
    );
    const secondClose = registry.closeAll().then(
      () => {
        secondCloseSettled = true;
        return "fulfilled" as const;
      },
      () => {
        secondCloseSettled = true;
        return "rejected" as const;
      },
    );

    try {
      connectedClose.resolve(undefined);
      await connectedClose.promise;
      await Promise.resolve();
      await Promise.resolve();
      const closeSettledBeforeConstruction = firstCloseSettled && secondCloseSettled;

      connectCompletion.resolve(undefined);
      const [firstCallerResult, joiningCallerResult, firstCloseResult, secondCloseResult] =
        await Promise.all([firstOutcome, joiningOutcome, firstClose, secondClose]);

      expect({
        closeSettledBeforeConstruction,
        firstCallerResult: firstCallerResult.status,
        joiningCallerResult: joiningCallerResult.status,
        firstCloseResult,
        secondCloseResult,
        connectedCloseCalls: vi.mocked(connectedClient.close).mock.calls.length,
        connectingCloseCalls: vi.mocked(connectingClient.close).mock.calls.length,
        emittedClientCreated: lifecycleEvents.includes("client_created"),
        connectedOwnership: internals.clients.size,
        connectingOwnership: internals.clientPromises.size,
        constructedOwnership: internals.constructedClients.size,
        closeOwnership: internals.activeCloseOperations.size,
      }).toEqual({
        closeSettledBeforeConstruction: false,
        firstCallerResult: "rejected",
        joiningCallerResult: "rejected",
        firstCloseResult: "fulfilled",
        secondCloseResult: "fulfilled",
        connectedCloseCalls: 1,
        connectingCloseCalls: 1,
        emittedClientCreated: false,
        connectedOwnership: 0,
        connectingOwnership: 0,
        constructedOwnership: 0,
        closeOwnership: 0,
      });
      expect(firstCallerResult.error).toBeInstanceOf(RegistryClosedError);
      expect(joiningCallerResult.error).toBeInstanceOf(RegistryClosedError);
      expect(firstCallerResult.error).toMatchObject({ code: "ERR_REGISTRY_CLOSED" });
      expect(joiningCallerResult.error).toMatchObject({ code: "ERR_REGISTRY_CLOSED" });
    } finally {
      connectedClose.resolve(undefined);
      connectCompletion.resolve(undefined);
      await Promise.allSettled([
        firstCaller,
        joiningCaller,
        firstClose,
        secondClose,
      ]);
      if (vi.mocked(connectingClient.close).mock.calls.length === 0) {
        await connectingClient.close();
      }
    }
  });
});
