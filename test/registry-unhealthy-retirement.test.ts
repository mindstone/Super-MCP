import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { PackageRegistry, RegistryClosedError } from "../src/registry.js";
import { StdioMcpClient } from "../src/clients/stdioClient.js";
import type { ConnectOutcome, McpClient, PackageConfig, SuperMcpConfig } from "../src/types.js";

// FOX-11595: a failed health check sets a leased client aside instead of closing it.

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/logging.js", () => ({ getLogger: () => loggerMock }));

type RegistryInternals = {
  clients: Map<string, McpClient>;
  retiringClients?: Map<McpClient, string>;
  activeCloseOperations: Map<McpClient, unknown>;
  activeLeases: Map<string, number>;
  activeLeaseClients: Map<string, Map<McpClient, number>>;
  terminalCleanupFailures: unknown[];
  createAndConnectClient: (
    packageId: string,
    config: PackageConfig,
    onClientCreated?: (client: McpClient) => void,
  ) => Promise<ConnectOutcome | McpClient>;
};

const packageId = "Notebook-acme";

function createRegistry(): { registry: PackageRegistry; internals: RegistryInternals } {
  const registry = new PackageRegistry({ mcpServers: {} } satisfies SuperMcpConfig);
  (registry as unknown as { packages: PackageConfig[] }).packages = [
    { id: packageId, name: packageId, transport: "stdio", command: "node", args: ["fictional.js"], visibility: "default" },
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

/** A client whose first health check passes and later ones fail, holding its first call until it is closed. */
function heldUnhealthyClient(closeError?: Error) {
  const held = deferred<unknown>();
  const client = createMockClient({
    healthCheck: vi.fn().mockResolvedValueOnce("ok").mockResolvedValue("error"),
    callTool: vi.fn().mockReturnValueOnce(held.promise),
    close: vi.fn().mockImplementation(async () => {
      held.reject(new McpError(ErrorCode.ConnectionClosed, "Connection closed"));
      if (closeError) throw closeError;
    }),
  });
  return { client, held };
}

const cleanup: Array<() => Promise<unknown>> = [];

describe("unhealthy acquisition sets a leased client aside (FOX-11595)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close().catch(() => undefined);
    vi.restoreAllMocks();
  });

  it("(C) stdio: a call queued behind a failing real health listing is sent and keeps its answer", async () => {
    const { registry, internals } = createRegistry();
    const config = registry.getPackage(packageId)!;
    const stdio = new StdioMcpClient(packageId, config);
    const queue = (stdio as unknown as { requestQueue: { size: number; once: (event: "add", listener: () => void) => void } }).requestQueue;

    const tool = { name: "slow", inputSchema: { type: "object" as const } };
    const firstListing = deferred();
    const failingListing = deferred();
    const toolEntered = deferred();
    const toolAnswer = deferred();
    const executions: string[] = [];
    let listings = 0;
    const server = new Server({ name: "fictional-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listings += 1;
      if (listings === 1) await firstListing.promise;
      if (listings === 2) {
        await failingListing.promise;
        throw new McpError(ErrorCode.InternalError, "listing hiccup");
      }
      return { tools: [tool] };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      executions.push(params.name);
      toolEntered.resolve();
      await toolAnswer.promise;
      return { content: [{ type: "text", text: "original answer" }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    cleanup.push(() => server.close());
    const sdk = new Client({ name: "fictional-host", version: "1.0.0" });
    await sdk.connect(clientSide);
    Object.assign(stdio as unknown as Record<string, unknown>, { client: sdk, transport: { pid: null } });
    vi.spyOn(stdio, "isTransportClosed").mockReturnValue(false);
    const closeSpy = vi.spyOn(stdio, "close");
    internals.clients.set(packageId, stdio);
    const replacement = createMockClient();
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);

    // The call's own health listing is held, so the next listing queues behind it.
    const call = registry.callTool(packageId, "slow", {}, { kind: "standalone" });
    const callOutcome = call.then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(listings).toBe(1), { timeout: 5000 });
    const healthListing = registry.getClient(packageId);
    expect(queue.size).toBe(1);
    const toolQueued = deferred();
    queue.once("add", () => toolQueued.resolve());
    firstListing.resolve();
    await toolQueued.promise;
    expect(queue.size).toBe(1);

    // The failing listing hands the queue to the tool call before the registry sees the failure.
    failingListing.resolve();
    await Promise.race([toolEntered.promise, callOutcome]);
    await expect(healthListing).resolves.toBe(replacement);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(internals.clients.get(packageId)).toBe(replacement);

    toolAnswer.resolve();
    await expect(call).resolves.toMatchObject({ content: [{ type: "text", text: "original answer" }] });
    expect(executions).toEqual(["slow"]);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(internals.activeLeases.size).toBe(0);
    expect(registry.getChildStats()[0]).toMatchObject({ eviction_count: 1 });
  });

  it("(D) a stale unhealthy result after replacement never removes or orphans the replacement", async () => {
    const { registry, internals } = createRegistry();
    const firstHealth = deferred<"ok" | "error">();
    const secondHealth = deferred<"ok" | "error">();
    const old = createMockClient({
      healthCheck: vi.fn().mockReturnValueOnce(firstHealth.promise).mockReturnValueOnce(secondHealth.promise),
    });
    const replacement = createMockClient();
    const extra = createMockClient();
    const create = vi.spyOn(internals, "createAndConnectClient")
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(extra);
    const events: string[] = [];
    registry.subscribeLifecycle((event) => events.push(event.type));
    internals.clients.set(packageId, old);

    const first = registry.getClient(packageId);
    const second = registry.getClient(packageId);
    expect(old.healthCheck).toHaveBeenCalledTimes(2);
    firstHealth.resolve("error");
    await expect(first).resolves.toBe(replacement);
    secondHealth.resolve("error");
    await expect(second).resolves.toBe(replacement);

    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(create).toHaveBeenCalledOnce();
    expect(old.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(events).toEqual(["client_evicted", "client_created"]);
    expect(registry.getChildStats()[0]).toMatchObject({ eviction_count: 1 });
  });

  it("(D) a replacement published during an awaited immediate close is kept, not overwritten", async () => {
    const { registry, internals } = createRegistry();
    const closing = deferred();
    const old = createMockClient({
      healthCheck: vi.fn().mockResolvedValue("error"),
      close: vi.fn().mockReturnValue(closing.promise),
    });
    const replacement = createMockClient();
    const extra = createMockClient();
    const create = vi.spyOn(internals, "createAndConnectClient")
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(extra);
    const events: string[] = [];
    registry.subscribeLifecycle((event) => events.push(event.type));
    internals.clients.set(packageId, old);

    const first = registry.getClient(packageId);
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce(), { timeout: 5000 });
    await expect(registry.getClient(packageId)).resolves.toBe(replacement);
    closing.resolve();
    await expect(first).resolves.toBe(replacement);

    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(create).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(events.filter((type) => type === "client_evicted")).toHaveLength(1);
    expect(registry.getChildStats()[0]).toMatchObject({ eviction_count: 1 });
  });

  it("(D) closes the old client when its last binding leaves, while a replacement call is still leased", async () => {
    const { registry, internals } = createRegistry();
    const oldAnswer = deferred<unknown>();
    const replacementAnswer = deferred<unknown>();
    const old = createMockClient({
      healthCheck: vi.fn().mockResolvedValueOnce("ok").mockResolvedValue("error"),
      callTool: vi.fn().mockReturnValueOnce(oldAnswer.promise),
      close: vi.fn().mockImplementation(async () => oldAnswer.reject(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))),
    });
    const replacement = createMockClient({
      callTool: vi.fn().mockReturnValueOnce(replacementAnswer.promise),
      close: vi.fn().mockImplementation(async () => replacementAnswer.reject(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))),
    });
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);
    const events: string[] = [];
    registry.subscribeLifecycle((event) => events.push(event.type));
    internals.clients.set(packageId, old);

    const running = registry.callTool(packageId, "running", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    const next = registry.callTool(packageId, "next", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(replacement.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });

    expect(old.close).not.toHaveBeenCalled();
    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(internals.retiringClients?.get(old)).toBe(packageId);
    expect(internals.activeLeaseClients.get(packageId)?.get(old)).toBe(1);
    expect(internals.activeLeaseClients.get(packageId)?.get(replacement)).toBe(1);
    // Counted while "next" still holds the old client too, before its lease moves on.
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Set aside an unhealthy MCP client until the calls holding it finish",
      { package_id: packageId, bound_leases: 2 },
    );

    oldAnswer.resolve({ content: [{ type: "text", text: "running" }] });
    expect(await running).toMatchObject({ content: [{ text: "running" }] });
    expect(old.close).toHaveBeenCalledOnce();
    expect(internals.retiringClients?.size).toBe(0);
    expect(internals.activeLeases.get(packageId)).toBe(1);
    expect(replacement.close).not.toHaveBeenCalled();

    replacementAnswer.resolve({ content: [{ type: "text", text: "next" }] });
    expect(await next).toMatchObject({ content: [{ text: "next" }] });
    expect(old.close).toHaveBeenCalledOnce();
    expect(internals.activeLeases.size).toBe(0);
    expect(internals.activeLeaseClients.size).toBe(0);
    expect(events).toEqual(["client_evicted", "client_created"]);
    expect(registry.getChildStats()[0]).toMatchObject({ eviction_count: 1 });
  });

  it("logs, and does not leak, a deferred close that fails", async () => {
    const { registry, internals } = createRegistry();
    const { client: old, held } = heldUnhealthyClient(new Error("close failed"));
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(createMockClient());
    internals.clients.set(packageId, old);

    const running = registry.callTool(packageId, "running", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    await registry.callTool(packageId, "next", {}, { kind: "standalone" });
    expect(old.close).not.toHaveBeenCalled();
    held.resolve({ content: [] });
    expect(await running).toEqual({ content: [] });
    await vi.waitFor(() => expect(loggerMock.warn).toHaveBeenCalledWith(
      "Failed to close an unhealthy MCP client after its last call",
      { package_id: packageId, error: "close failed" },
    ), { timeout: 5000 });
    expect(old.close).toHaveBeenCalledOnce();
    expect(internals.activeCloseOperations.size).toBe(0);
  });

  it("(E) shutdown force-closes a set-aside client, rejecting its held call", async () => {
    const { registry, internals } = createRegistry();
    const { client: old } = heldUnhealthyClient();
    const replacement = createMockClient();
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(replacement);
    internals.clients.set(packageId, old);

    const running = registry.callTool(packageId, "running", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    await registry.callTool(packageId, "next", {}, { kind: "standalone" });
    expect(internals.clients.get(packageId)).toBe(replacement);
    expect(internals.retiringClients?.get(old)).toBe(packageId);
    expect(old.close).not.toHaveBeenCalled();

    await expect(registry.closeAll()).resolves.toBeUndefined();
    expect(await running).toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(old.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(internals.retiringClients?.size).toBe(0);
    expect(internals.activeLeases.size).toBe(0);
    expect(internals.activeLeaseClients.size).toBe(0);
    expect(internals.activeCloseOperations.size).toBe(0);
    expect(internals.terminalCleanupFailures).toEqual([]);
  });

  it("(E) shutdown reports a set-aside client's failed close", async () => {
    const { registry, internals } = createRegistry();
    const closeError = new Error("retiring close failed");
    const { client: old } = heldUnhealthyClient(closeError);
    vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(createMockClient());
    internals.clients.set(packageId, old);

    const running = registry.callTool(packageId, "running", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    await registry.callTool(packageId, "next", {}, { kind: "standalone" });
    expect(internals.retiringClients?.get(old)).toBe(packageId);

    const shutdown = await registry.closeAll().catch((error: unknown) => error);
    expect(shutdown).toBeInstanceOf(AggregateError);
    expect((shutdown as AggregateError).errors).toEqual([closeError]);
    expect(loggerMock.error).toHaveBeenCalledWith("MCP client cleanup failed during registry shutdown", {
      package_id: packageId,
      phase: "shutdown_retiring",
      error: "retiring close failed",
    });
    expect(await running).toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(old.close).toHaveBeenCalledOnce();
    expect(internals.retiringClients?.size).toBe(0);
    expect(internals.activeLeases.size).toBe(0);
  });

  it("(E) a client_evicted listener that shuts the registry down synchronously still settles", async () => {
    const { registry, internals } = createRegistry();
    const { client: old } = heldUnhealthyClient();
    const create = vi.spyOn(internals, "createAndConnectClient").mockResolvedValue(createMockClient());
    let shutdown: Promise<void> | undefined;
    registry.subscribeLifecycle((event) => {
      if (event.type === "client_evicted") shutdown = registry.closeAll();
    });
    internals.clients.set(packageId, old);

    const running = registry.callTool(packageId, "running", {}, { kind: "standalone" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce(), { timeout: 5000 });
    await expect(registry.callTool(packageId, "next", {}, { kind: "standalone" })).rejects.toBeInstanceOf(RegistryClosedError);
    expect(shutdown).toBeDefined();
    await expect(shutdown).resolves.toBeUndefined();
    expect(await running).toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(old.close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(internals.retiringClients?.size).toBe(0);
    expect(internals.activeLeases.size).toBe(0);
    expect(internals.activeLeaseClients.size).toBe(0);
  });
});
