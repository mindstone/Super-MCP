import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDispatchLabel, NeverSentError } from "../src/dispatchErrors.js";
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

// FOX-11496: a call admitted just BEFORE a restart holds the client the restart
// then closes. The SDK rejects it with `Error('Not connected')` before writing
// anything, so it was never sent. (A call arriving DURING a restart is held and
// run on the new client: registry-restart-admission.test.ts.)

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

const answer = { content: [{ type: "text", text: "fresh" }] };

/**
 * Leases and binds a call on the old client, holds it in getClient's health
 * probe, restarts the package (and starts the forced refresh's eviction, which
 * waits for active leases), then lets the call dispatch on the closed client.
 */
async function raceWithRestart(newClient: McpClient) {
  const probeHeld = deferred<"ok">();
  const oldClient = createMockClient({
    healthCheck: vi.fn(() => probeHeld.promise),
    callTool: vi.fn().mockRejectedValue(new Error("Not connected")),
  });
  const registry = createRegistry(oldClient, newClient);
  await registry.getClient(PACKAGE_ID);

  const call = registry.callTool(PACKAGE_ID, "read", {}, { kind: "standalone" });
  const callSettled = call.then(() => undefined, () => undefined);
  await tick();
  expect(oldClient.healthCheck).toHaveBeenCalledTimes(1);

  await expect(registry.restartPackage(PACKAGE_ID)).resolves.toMatchObject({ success: true });
  expect(oldClient.close).toHaveBeenCalledTimes(1);
  // As `refreshNow` with `forceReconnect` does after a restart: a nested lease would wait on this forever.
  const eviction = registry.evictClient(PACKAGE_ID, "restart");
  probeHeld.resolve("ok");
  await callSettled;
  await eviction;
  return { call, oldClient };
}

afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((registry) => registry.closeAll()));
  vi.restoreAllMocks();
});

describe("a call leased just before a restart", () => {
  it("a call leased before a restart is replayed once on the new client, whatever the tool", async () => {
    const newClient = createMockClient({ callTool: vi.fn().mockResolvedValue(answer) });
    const { call, oldClient } = await raceWithRestart(newClient);

    await expect(call).resolves.toEqual(answer);
    expect((oldClient.callTool as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
    expect(newClient.callTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a plain error", () => new Error("boom")],
    ["a connector's own error", () => Object.assign(new Error("Request failed"), { code: -32000 })],
  ])("any other first failure is thrown unchanged and not replayed: %s", async (_name, makeError) => {
    const thrown = makeError();
    const current = createMockClient({ callTool: vi.fn().mockRejectedValue(thrown) });
    const spare = createMockClient({ callTool: vi.fn().mockResolvedValue(answer) });
    const registry = createRegistry(current, spare);

    const error = await registry.callTool(PACKAGE_ID, "send", {}, { kind: "standalone" }).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
    expect(error).not.toBeInstanceOf(NeverSentError);
    expect(current.callTool).toHaveBeenCalledTimes(1);
    expect(spare.callTool).not.toHaveBeenCalled();
  });

  it("Not connected from the client that is still current is thrown unchanged", async () => {
    const current = createMockClient({ callTool: vi.fn().mockRejectedValue(new Error("Not connected")) });
    const spare = createMockClient({ callTool: vi.fn().mockResolvedValue(answer) });
    const registry = createRegistry(current, spare);

    const error = await registry
      .callTool(PACKAGE_ID, "read", {}, { kind: "standalone" })
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(NeverSentError);
    expect(error).toEqual(new Error("Not connected"));
    expect(current.callTool).toHaveBeenCalledTimes(1);
    expect(spare.callTool).not.toHaveBeenCalled();
  });

  it("a replay that fails throws that failure", async () => {
    const newClient = createMockClient({ callTool: vi.fn().mockRejectedValue(new Error("boom")) });
    const { call, oldClient } = await raceWithRestart(newClient);

    await expect(call).rejects.toThrow("boom");
    expect(oldClient.callTool).toHaveBeenCalledTimes(1);
    expect(newClient.callTool).toHaveBeenCalledTimes(1);
  });

  it("a second never-sent on the replay is thrown, with no third attempt", async () => {
    const replayProbeHeld = deferred<"ok">();
    const newClient = createMockClient({ callTool: vi.fn().mockRejectedValue(new Error("Not connected")) });
    const newestClient = createMockClient({ callTool: vi.fn().mockResolvedValue(answer) });
    const probeHeld = deferred<"ok">();
    const oldClient = createMockClient({
      healthCheck: vi.fn(() => probeHeld.promise),
      callTool: vi.fn().mockRejectedValue(new Error("Not connected")),
    });
    const registry = createRegistry(oldClient, newClient);
    vi.mocked((registry as unknown as { createAndConnectClient: () => Promise<McpClient> }).createAndConnectClient)
      .mockResolvedValueOnce(newestClient);
    await registry.getClient(PACKAGE_ID);

    const call = registry.callTool(PACKAGE_ID, "read", {}, { kind: "standalone" });
    const callSettled = call.then(() => undefined, () => undefined);
    await tick();
    await registry.restartPackage(PACKAGE_ID);
    // Connect the new client now, so the replay is held in its health probe while a second restart takes it out.
    (newClient.healthCheck as ReturnType<typeof vi.fn>).mockImplementation(() => replayProbeHeld.promise);
    await registry.getClient(PACKAGE_ID);
    probeHeld.resolve("ok");
    await vi.waitFor(() => expect(newClient.healthCheck).toHaveBeenCalledTimes(1));
    await registry.restartPackage(PACKAGE_ID);
    replayProbeHeld.resolve("ok");
    await callSettled;

    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NeverSentError);
    expect(buildDispatchLabel(PACKAGE_ID, false, error)).toMatchObject({ verdict: "never_sent" });
    expect(oldClient.callTool).toHaveBeenCalledTimes(1);
    expect(newClient.callTool).toHaveBeenCalledTimes(1);
    expect(newestClient.callTool).not.toHaveBeenCalled();
  });
});
