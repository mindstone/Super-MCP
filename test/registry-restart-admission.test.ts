import { afterEach, describe, expect, it, vi } from "vitest";

import { PackageRegistry } from "../src/registry.js";
import type { McpClient, PackageConfig, SuperMcpConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// FOX-9654 / REBEL-688: a connector restart (Core's own recovery, a credential
// change, a home change) must not hand its retiring client to calls that are
// arriving. Calls already running on it keep their existing contract (settled,
// never replayed: registry-connect-retry and package-homes tests).

const PACKAGE_ID = "Acme";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

const registries: PackageRegistry[] = [];

function createRegistry(oldClient: McpClient, newClient: McpClient): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  const registry = new PackageRegistry(config);
  (registry as unknown as { packages: PackageConfig[] }).packages = [stdioPackage(PACKAGE_ID)];
  vi.spyOn(registry as unknown as { createAndConnectClient: () => Promise<McpClient> }, "createAndConnectClient")
    .mockResolvedValueOnce(oldClient)
    .mockResolvedValueOnce(newClient);
  registries.push(registry);
  return registry;
}

afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((registry) => registry.closeAll()));
  vi.restoreAllMocks();
});

describe("restartPackage call admission", () => {
  it("holds a call that arrives during the restart and runs it once on the new client", async () => {
    const closeHeld = deferred<void>();
    const oldClient = createMockClient({
      close: vi.fn(() => closeHeld.promise),
      callTool: vi.fn().mockRejectedValue(new Error("Connection closed")),
    });
    const newClient = createMockClient({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "fresh" }] }),
    });
    const registry = createRegistry(oldClient, newClient);
    await registry.getClient(PACKAGE_ID);

    const restart = registry.restartPackage(PACKAGE_ID);
    await tick();
    const arriving = registry.callTool(PACKAGE_ID, "read", {}, { kind: "standalone" });
    const arrivingSettled = arriving.then(() => undefined, () => undefined);
    try {
      await tick();
      // Held until the restart settles: neither the old nor the new client has it yet.
      expect(oldClient.callTool).not.toHaveBeenCalled();
      expect(newClient.callTool).not.toHaveBeenCalled();
    } finally {
      closeHeld.resolve();
    }

    await expect(restart).resolves.toMatchObject({ success: true });
    await expect(arriving).resolves.toEqual({ content: [{ type: "text", text: "fresh" }] });
    await arrivingSettled;
    expect(oldClient.callTool).not.toHaveBeenCalled();
    expect(newClient.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not hand the retiring client to a getClient() that arrives while a connection is pending", async () => {
    // Forwarded-file calls and passive catalog discovery acquire a client with
    // getClient() before any lease; a restart that waits for a pending
    // connection and then closes it must not give them that client.
    const connectHeld = deferred<McpClient>();
    const closeHeld = deferred<void>();
    const oldClient = createMockClient({ close: vi.fn(() => closeHeld.promise) });
    const newClient = createMockClient();
    const config: SuperMcpConfig = { mcpServers: {} };
    const registry = new PackageRegistry(config);
    registries.push(registry);
    (registry as unknown as { packages: PackageConfig[] }).packages = [stdioPackage(PACKAGE_ID)];
    vi.spyOn(registry as unknown as { createAndConnectClient: () => Promise<McpClient> }, "createAndConnectClient")
      .mockReturnValueOnce(connectHeld.promise)
      .mockResolvedValueOnce(newClient);

    const pending = registry.getClient(PACKAGE_ID);
    await tick();
    const restart = registry.restartPackage(PACKAGE_ID);
    await tick();
    const arriving = registry.getClient(PACKAGE_ID);
    const catalogArriving = registry.connectForCatalog(PACKAGE_ID);
    try {
      connectHeld.resolve(oldClient);
      await tick();
    } finally {
      closeHeld.resolve();
    }

    await expect(restart).resolves.toMatchObject({ success: true });
    await expect(pending).resolves.toBe(oldClient);
    await expect(arriving).resolves.toBe(newClient);
    await expect(catalogArriving).resolves.toMatchObject({ kind: "connected", client: newClient });
    expect(oldClient.close).toHaveBeenCalledTimes(1);
  });
});
