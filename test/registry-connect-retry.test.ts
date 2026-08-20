import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageRegistry } from "../src/registry.js";
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
  clientPromises: Map<string, Promise<McpClient>>;
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
});
