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

  function callUseTool(): Promise<unknown> {
    return handlers.get(CallToolRequestSchema)!(
      { params: { name: "use_tool", arguments: { package_id: "notebook", tool_id: "write_note", args: { text: "a note" } } } },
      { signal: new AbortController().signal, sendRequest: vi.fn() },
    );
  }

  it("on a cold, then errored, catalog", async () => {
    vi.spyOn(registry, "getClient").mockRejectedValue(pausedError);
    await startServer({ configPaths: [], transport: "stdio" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(callUseTool()).rejects.toEqual({
        code: ERROR_CODES.PACKAGE_UNAVAILABLE,
        message: `${paused}. Run 'health_check_all()' to diagnose the issue.`,
        data: { package_id: "notebook", status: "error", home_failure: "unreachable" },
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
      data: { tool_name: "use_tool", home_failure: "unreachable" },
    });
  });
});
