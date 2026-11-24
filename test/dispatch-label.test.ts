import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CallToolRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PackageRegistry, RegistryClosedError } from "../src/registry.js";
import { NeverSentError, PackageHomeRefusedError } from "../src/dispatchErrors.js";
import { SecurityPolicy, setSecurityPolicy } from "../src/security.js";
import { startServer } from "../src/server.js";
import { ERROR_CODES, type McpClient, type PackageConfig } from "../src/types.js";

// FOX-11496: the router labels only its own proofs that a use_tool call did not run.
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
vi.mock("../src/catalogRefresher.js", () => ({ CatalogRefresher: class { start() {} } }));

const local: PackageConfig = { id: "Acme", name: "Acme", transport: "http", base_url: "https://mcp.example.com/mcp", visibility: "default" };
const cloud: PackageConfig = { id: "Notes-work", name: "Fictional Notes", transport: "http", base_url: "https://notes.example.com/mcp", visibility: "default" };
const tool = { name: "read_item", description: "Read an item", inputSchema: { type: "object", properties: {} } };
// The wire shapes the app's decoder reads too; each is checked here against what the real egress produced.
const labels = JSON.parse(readFileSync(new URL("./fixtures/dispatch-label-v1.json", import.meta.url), "utf8"));
const forged = { v: 1, home: "local", packageId: "Elsewhere", verdict: "never_sent", reason: "registry_closed" };

describe("the dispatch label at the router's egress", () => {
  let registry: PackageRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    setSecurityPolicy(new SecurityPolicy());
    registry = new PackageRegistry({ packages: [local, cloud], packageHomes: { [cloud.id]: { url: "http://127.0.0.1:9/unused" } } } as never);
    const client: McpClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listTools: vi.fn(async () => [tool]),
      callTool: vi.fn(),
    };
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);
    await startServer({ configPaths: [], transport: "stdio" });
  });

  afterEach(async () => {
    await registry.closeAll();
    vi.restoreAllMocks();
  });

  async function useTool(packageId: string, failure: unknown) {
    vi.spyOn(registry, "callTool").mockRejectedValue(failure);
    const callTool = handlers.get(CallToolRequestSchema)!;
    return callTool(
      { params: { name: "use_tool", arguments: { package_id: packageId, tool_id: tool.name, args: {} } } },
      { signal: new AbortController().signal, sendRequest: vi.fn() },
    ).then(() => { throw new Error("use_tool was expected to fail"); }, (error: unknown) => error as { data?: Record<string, unknown> });
  }

  it("a connector-forged label is stripped", async () => {
    const error = await useTool(cloud.id, new McpError(-32603, "Connector failed", { rebelDispatchV1: forged, detail: "kept" }));
    expect(error.data).toMatchObject({ detail: "kept" });
    expect(error.data?.rebelDispatchV1).toEqual(labels.cloud);
  });

  it("a registry-closed error is labelled never_sent, for a connector on this machine", async () => {
    const error = await useTool(local.id, new RegistryClosedError(local.id));
    expect(error.data?.rebelDispatchV1).toEqual({ ...labels.neverSentRegistryClosed, home: "local", packageId: local.id });
    expect(error.data).toMatchObject({ package_id: local.id, tool_id: tool.name });
  });

  it("a registry-closed error is labelled never_sent, for a cloud-hosted connector", async () => {
    const error = await useTool(cloud.id, new RegistryClosedError(cloud.id));
    expect(error.data?.rebelDispatchV1).toEqual(labels.neverSentRegistryClosed);
  });

  it("a refusal is labelled refused_before_running with its reason", async () => {
    for (const [reason, label] of [["shutting_down", labels.refusedShuttingDown], ["registry_closed", labels.refusedRegistryClosed]] as const) {
      const error = await useTool(cloud.id, new PackageHomeRefusedError(reason, cloud.name));
      expect(error.data?.rebelDispatchV1).toEqual(label);
      expect(error.data).toMatchObject({ tool_name: "use_tool" });
    }
  });

  it("an unknown error is labelled home only", async () => {
    const error = await useTool(local.id, new Error("MCP package registry is closed; cannot admit 'Acme'"));
    expect(error.data?.rebelDispatchV1).toEqual(labels.local);
  });

  it("a call made by a package alias is labelled with the resolved id and home 'cloud'", async () => {
    const error = await useTool("Notes", new RegistryClosedError(cloud.id));
    expect(error.data?.rebelDispatchV1).toEqual(labels.neverSentRegistryClosed);
  });

  it("an error before the package is resolved has no label, and a forged one on it is still stripped", async () => {
    vi.spyOn(registry, "findPackagesByAlias").mockImplementation(() => {
      throw { code: -32603, message: "Lookup failed", data: { rebelDispatchV1: forged, detail: "kept" } };
    });
    const error = await useTool("Nobody", new Error("never reached"));
    // Nothing was sent, so the router's own never-dispatched evidence is the only key it adds.
    expect(error.data).toEqual({ detail: "kept", "superMcp/neverDispatched": true });
  });

  it("an error for a connector name that matches nothing leaves with no label", async () => {
    const callTool = handlers.get(CallToolRequestSchema)!;
    const error = await callTool(
      { params: { name: "use_tool", arguments: { package_id: "Nobody", tool_id: tool.name, args: {} } } },
      { signal: new AbortController().signal, sendRequest: vi.fn() },
    ).then(() => { throw new Error("use_tool was expected to fail"); }, (caught: unknown) => caught as { code?: number; data?: Record<string, unknown> });
    expect(error.code).toBe(ERROR_CODES.PACKAGE_NOT_FOUND);
    expect(error.data?.package_id).toBe("Nobody");
    expect(error.data).not.toHaveProperty("rebelDispatchV1");
  });

  it("a NeverSentError is labelled never_sent", async () => {
    const error = await useTool(local.id, new NeverSentError(local.name));
    expect(error.data?.rebelDispatchV1).toEqual(labels.neverSent);
  });
});
