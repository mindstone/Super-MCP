import { afterEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PackageRegistry } from "../src/registry.js";
import { startServer } from "../src/server.js";
import type { McpClient, PackageConfig } from "../src/types.js";

const handlers = vi.hoisted(() => new Map<unknown, (...args: any[]) => Promise<any>>());

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ setLevel: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<any>) {
      handlers.set(schema, handler);
    }
    async connect() {}
    getClientCapabilities() { return {}; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../src/configWatcher.js", () => ({ ConfigWatcher: class { async start() {} } }));
vi.mock("../src/catalogRefresher.js", () => ({ CatalogRefresher: class { start() {} } }));

afterEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

describe("server caller-session metadata", () => {
  async function startWith(): Promise<{ handler: (...args: any[]) => Promise<any>; callTool: ReturnType<typeof vi.fn> }> {
    const config: PackageConfig = {
      id: "RebelInbox", name: "Actions", transport: "http",
      base_url: "https://mcp.example.com/mcp", visibility: "default",
    };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "created" }] });
    const client: McpClient = {
      connect: vi.fn(), close: vi.fn(), callTool,
      listTools: vi.fn().mockResolvedValue([{
        name: "rebel_inbox_add", inputSchema: { type: "object", properties: {
          title: { type: "string" }, source: { type: "object" }, references: { type: "array" },
        } },
      }]),
    };
    const registry = new PackageRegistry({ packages: [config] });
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);
    await startServer({ configPaths: [], transport: "stdio" });
    return { handler: handlers.get(CallToolRequestSchema)!, callTool };
  }

  it.each([
    ["host automation metadata", { automationId: "intro-drafts", automationName: "Intro drafts" }, true],
    ["malformed automation metadata", { automationId: 7 }, false],
  ])("links a workspace-sourced Action to the run from %s", async (_case, callerAutomation, linked) => {
    const { handler, callTool } = await startWith();
    const brief = { kind: "workspace", path: "Chief-of-Staff/intro.md" };
    const result = await handler({ params: {
      name: "use_tool",
      _meta: { "rebel/callerSessionId": "host-request-run", "rebel/callerAutomation": callerAutomation },
      arguments: { package_id: "RebelInbox", tool_id: "rebel_inbox_add", args: { title: "Review intro", source: brief } },
    } }, { signal: new AbortController().signal, sendRequest: vi.fn() });
    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledWith("rebel_inbox_add", linked ? {
      title: "Review intro", references: [brief], source: {
        kind: "automation", automationId: "intro-drafts", automationName: "Intro drafts", sessionId: "host-request-run",
      },
    } : { title: "Review intro", source: brief }, expect.anything());
  });

  it("passes request _meta through the use_tool handler to the final stamped connector call", async () => {
    const config: PackageConfig = {
      id: "RebelInbox", name: "Actions", transport: "http",
      base_url: "https://mcp.example.com/mcp", visibility: "default",
    };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "created" }] });
    const client: McpClient = {
      connect: vi.fn(), close: vi.fn(), callTool,
      listTools: vi.fn().mockResolvedValue([{
        name: "rebel_inbox_add", inputSchema: { type: "object", properties: {
          title: { type: "string" }, source: { type: "object" },
        } },
      }]),
    };
    const registry = new PackageRegistry({ packages: [config] });
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    vi.spyOn(registry, "startIdleReaper").mockImplementation(() => {});
    vi.spyOn(PackageRegistry, "fromConfigFiles").mockResolvedValue(registry);
    vi.spyOn(process, "on").mockReturnValue(process);

    await startServer({ configPaths: [], transport: "stdio" });
    const handler = handlers.get(CallToolRequestSchema)!;
    const result = await handler({ params: {
      name: "use_tool",
      _meta: { "rebel/callerSessionId": "host-request-run" },
      arguments: {
        package_id: config.id, tool_id: "rebel_inbox_add",
        _meta: { "rebel/callerSessionId": "model-meta-run" },
        args: { title: "Review brief", source: {
          kind: "automation", automationId: "daily", automationName: "Daily brief", sessionId: "model-run",
        } },
      },
    } }, { signal: new AbortController().signal, sendRequest: vi.fn() });

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("rebel_inbox_add", {
      title: "Review brief", source: {
        kind: "automation", automationId: "daily", automationName: "Daily brief", sessionId: "host-request-run",
      },
    }, expect.anything());
  });
});
