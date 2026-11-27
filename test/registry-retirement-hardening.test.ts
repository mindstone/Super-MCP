import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PackageRegistry } from "../src/registry.js";
import { StdioMcpClient } from "../src/clients/stdioClient.js";
import type { ConnectOutcome, McpClient, PackageConfig, SuperMcpConfig } from "../src/types.js";

// FOX-11595 Stage 3: the retiring count in stats, and compare-and-remove for the client map.

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/logging.js", () => ({ getLogger: () => loggerMock }));

type RegistryInternals = {
  clients: Map<string, McpClient>;
  createAndConnectClient: (
    packageId: string,
    config: PackageConfig,
    onClientCreated?: (client: McpClient) => void,
  ) => Promise<ConnectOutcome | McpClient>;
};

const packageId = "Notebook-acme";
const otherPackageId = "Ledger-acme";
const cleanup: Array<() => Promise<unknown>> = [];

function createRegistry(): { registry: PackageRegistry; internals: RegistryInternals } {
  const registry = new PackageRegistry({ mcpServers: {} } satisfies SuperMcpConfig);
  (registry as unknown as { packages: PackageConfig[] }).packages = [
    { id: packageId, name: packageId, transport: "stdio", command: "node", args: ["fictional.js"], visibility: "default" },
    { id: otherPackageId, name: otherPackageId, transport: "stdio", command: "node", args: ["fictional.js"], visibility: "default" },
  ];
  cleanup.push(() => registry.closeAll());
  return { registry, internals: registry as unknown as RegistryInternals };
}

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A client that holds its first call until it is answered or closed; its health checks follow `health`. */
function heldClient(health: Array<"ok" | "error">) {
  const held = deferred<unknown>();
  const healthCheck = vi.fn();
  for (const result of health) healthCheck.mockResolvedValueOnce(result);
  healthCheck.mockResolvedValue("error");
  const client = createMockClient({
    healthCheck,
    callTool: vi.fn().mockReturnValueOnce(held.promise),
    close: vi.fn().mockImplementation(async () => {
      held.reject(new McpError(ErrorCode.ConnectionClosed, "Connection closed"));
    }),
  });
  return { client, held };
}

function retiringCount(registry: PackageRegistry, id: string): number | undefined {
  return registry.getChildStats().find((entry) => entry.package_id === id)?.retiring_count;
}

describe("registry retirement hardening (FOX-11595)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close().catch(() => undefined);
    vi.restoreAllMocks();
  });

  it("stats count each set-aside generation until its last call leaves, and none after shutdown", async () => {
    const { registry, internals } = createRegistry();
    // First generation: healthy for its own call, unhealthy for the next.
    const first = heldClient(["ok"]);
    // Second generation: holds the call that moved to it, then fails the following check.
    const second = heldClient([]);
    const third = createMockClient();
    vi.spyOn(internals, "createAndConnectClient")
      .mockResolvedValueOnce(second.client)
      .mockResolvedValueOnce(third);
    internals.clients.set(packageId, first.client);
    expect(retiringCount(registry, packageId)).toBe(0);

    const onFirst = registry.callTool(packageId, "a", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.client.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    const onSecond = registry.callTool(packageId, "b", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(second.client.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(retiringCount(registry, packageId)).toBe(1);

    await registry.callTool(packageId, "c", {}, { kind: "standalone" });
    expect(internals.clients.get(packageId)).toBe(third);
    expect(retiringCount(registry, packageId)).toBe(2);
    expect(retiringCount(registry, otherPackageId)).toBe(0);
    expect(first.client.close).not.toHaveBeenCalled();
    expect(second.client.close).not.toHaveBeenCalled();

    first.held.resolve({ content: [{ type: "text", text: "a" }] });
    expect(await onFirst).toMatchObject({ content: [{ text: "a" }] });
    expect(first.client.close).toHaveBeenCalledOnce();
    expect(retiringCount(registry, packageId)).toBe(1);

    await expect(registry.closeAll()).resolves.toBeUndefined();
    expect(await onSecond).toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(second.client.close).toHaveBeenCalledOnce();
    expect(retiringCount(registry, packageId)).toBe(0);
  });

  it("a stale pre-send caller that meets a published replacement leaves it in place", async () => {
    const { registry, internals } = createRegistry();
    const stale = new StdioMcpClient(packageId, registry.getPackage(packageId)!);
    vi.spyOn(stale, "isTransportClosed").mockReturnValue(true);
    const staleClose = vi.spyOn(stale, "close").mockResolvedValue(undefined);
    const replacement = createMockClient({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "on replacement" }] }),
    });
    const create = vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(createMockClient());
    const realGetClient = registry.getClient.bind(registry);
    // The caller is handed the dead client, and another caller publishes a replacement
    // before it resumes to re-establish.
    vi.spyOn(registry, "getClient")
      .mockImplementationOnce(async () => {
        internals.clients.set(packageId, replacement);
        return stale;
      })
      .mockImplementation(realGetClient);

    await expect(registry.callTool(packageId, "tool", {}, { kind: "standalone" }))
      .resolves.toMatchObject({ content: [{ text: "on replacement" }] });

    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(replacement.callTool).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(registry.getChildStats().find((entry) => entry.package_id === packageId))
      .toMatchObject({ reestablish_count: 0 });
  });
});
