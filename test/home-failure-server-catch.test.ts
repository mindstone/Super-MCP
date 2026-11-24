// FOX-11451: the tools/call handler `startServer` registers forwards a paused package
// home's marker as `data.home_failure`, for a cold or errored catalog (PACKAGE_UNAVAILABLE)
// and for a ready one whose call fails (INTERNAL_ERROR). The code and message stay the same.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PackageRegistry } from "../src/registry.js";
import { PackageHomeClient } from "../src/clients/packageHomeClient.js";
import { startServer } from "../src/server.js";
import { ERROR_CODES, type McpClient } from "../src/types.js";

const logger = vi.hoisted(() => ({
  setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
const handlers = vi.hoisted(() => new Map<unknown, (...args: any[]) => Promise<unknown>>());

vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<unknown>) {
      handlers.set(schema, handler);
    }
    async connect() {}
    getClientCapabilities() { return {}; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../src/configWatcher.js", () => ({ ConfigWatcher: class { async start() {} } }));
vi.mock("../src/catalogRefresher.js", () => ({ CatalogRefresher: class { start() {} } }));

const paused = "Your cloud isn't reachable, so Fictional Notes is paused for now. An action that was in progress may already have happened; check its outcome before trying again.";
const home = { url: "https://cloud.example.test/mcp/packages/notebook", headers: { Authorization: "Bearer test-key-1" } };
const tool = { name: "write_note", inputSchema: { type: "object", properties: { text: { type: "string" } } } };

describe("the registered tools/call catch forwards a paused home's marker", () => {
  let registry: PackageRegistry;
  let pausedError: Error;

  beforeEach(async () => {
    handlers.clear();
    registry = new PackageRegistry({
      mcpServers: { notebook: { command: "/must-never-run", name: "Fictional Notes" } },
      packageHomes: { notebook: home },
    } as ConstructorParameters<typeof PackageRegistry>[0]);
    pausedError = new PackageHomeClient(registry.getPackage("notebook")!, home).unreachableError(new Error("503"));
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);
  });

  afterEach(async () => {
    await registry.closeAll();
    vi.restoreAllMocks();
  });

  function callUseTool(signal = new AbortController().signal): Promise<unknown> {
    return handlers.get(CallToolRequestSchema)!(
      { params: { name: "use_tool", arguments: { package_id: "notebook", tool_id: "write_note", args: { text: "a note" } } } },
      { signal, sendRequest: vi.fn() },
    );
  }

  it("on a cold, then errored, catalog", async () => {
    vi.spyOn(registry, "getClient").mockRejectedValue(pausedError);
    await startServer({ configPaths: [], transport: "stdio" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(callUseTool()).rejects.toEqual({
        code: ERROR_CODES.PACKAGE_UNAVAILABLE,
        message: `${paused}. Run 'health_check_all()' to diagnose the issue.`,
        data: { package_id: "notebook", status: "error", home_failure: "unreachable", "superMcp/neverDispatched": true,
          rebelDispatchV1: { v: 1, home: "cloud", packageId: "notebook" } },
      });
    }
  });

  it("on a ready catalog whose call fails", async () => {
    const client = { listTools: vi.fn(async () => [tool]) } as unknown as McpClient;
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    vi.spyOn(registry, "callTool").mockRejectedValue(pausedError);
    await startServer({ configPaths: [], transport: "stdio" });
    await expect(callUseTool()).rejects.toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining(paused),
      data: { tool_name: "use_tool", home_failure: "unreachable", "superMcp/neverDispatched": true,
        rebelDispatchV1: { v: 1, home: "cloud", packageId: "notebook" } },
    });
  });

  it("preserves a DOMException abort before send through wire formatting and logging", async () => {
    const client = { listTools: vi.fn(async () => [tool]), callTool: vi.fn() } as unknown as McpClient;
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    await startServer({ configPaths: [], transport: "stdio" });
    const controller = new AbortController();
    const reason = new DOMException("Router request cancelled", "AbortError");
    controller.abort(reason);
    logger.error.mockClear();

    await expect(callUseTool(controller.signal)).rejects.toMatchObject({
      message: reason.message,
      data: { "superMcp/neverDispatched": true },
    });
    expect(client.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Tool execution failed", {
      tool_name: "use_tool", error: reason.message,
    });
    expect(controller.signal.reason).toBe(reason);
    expect(reason.message).toBe("Router request cancelled");
    expect(String(reason)).toBe("AbortError: Router request cancelled");
  });
});
