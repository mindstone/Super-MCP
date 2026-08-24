import { randomUUID } from "node:crypto";
import http, {
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PackageRegistry,
  type RegistryLifecycleEvent,
} from "../src/registry.js";
import type { PackageConfig, SuperMcpConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface ToolCallObservation {
  toolName: string;
  sessionId: string;
}

interface SessionBoundMcpServer {
  url: string;
  armOneShotListToolsFailure(): void;
  assignedSessionIds(): readonly string[];
  observedSessionIds(): readonly string[];
  toolCallSession(toolName: string): string | undefined;
  close(): Promise<void>;
}

interface SessionContinuityScenario {
  registry: PackageRegistry;
  server: SessionBoundMcpServer;
  packageId: string;
  close(): Promise<void>;
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const activeScenarios: SessionContinuityScenario[] = [];

afterEach(async () => {
  await Promise.all(
    activeScenarios.splice(0).map((scenario) => scenario.close()),
  );
});

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isJsonRpcMethod(body: unknown, method: string): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "method" in body &&
    body.method === method
  );
}

function toolNameFromBody(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("method" in body) ||
    body.method !== "tools/call" ||
    !("params" in body) ||
    typeof body.params !== "object" ||
    body.params === null ||
    !("name" in body.params) ||
    typeof body.params.name !== "string"
  ) {
    return undefined;
  }

  return body.params.name;
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function registerSessionTools(
  server: McpServer,
  currentSessionId: () => string,
  handleSessions: Map<string, string>,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "mint_handle",
        description: "Mint a handle bound to the current MCP session.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "use_handle",
        description: "Use a handle minted in the current MCP session.",
        inputSchema: {
          type: "object",
          properties: { handle: { type: "string" } },
          required: ["handle"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const sessionId = currentSessionId();

    if (request.params.name === "mint_handle") {
      const handle = `handle-${handleSessions.size + 1}`;
      handleSessions.set(handle, sessionId);
      return {
        content: [{ type: "text", text: handle }],
        isError: false,
      };
    }

    if (request.params.name === "use_handle") {
      const handle = request.params.arguments?.handle;
      const valid =
        typeof handle === "string" && handleSessions.get(handle) === sessionId;
      return {
        content: [
          {
            type: "text",
            text: valid ? "Handle accepted" : "Invalid handle",
          },
        ],
        isError: !valid,
      };
    }

    return {
      content: [{ type: "text", text: "Unknown tool" }],
      isError: true,
    };
  });
}

async function startSessionBoundMcpServer(): Promise<SessionBoundMcpServer> {
  const sessions = new Map<string, SessionEntry>();
  const handleSessions = new Map<string, string>();
  const assignedSessionIds: string[] = [];
  const observedSessionIds: string[] = [];
  const toolCalls: ToolCallObservation[] = [];
  let failNextListTools = false;

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url !== "/mcp") {
      response.writeHead(404);
      response.end();
      return;
    }

    const body =
      request.method === "POST" ? await readJsonBody(request) : undefined;
    const presentedSessionId = request.headers["mcp-session-id"];
    const sessionId =
      typeof presentedSessionId === "string" ? presentedSessionId : undefined;

    if (sessionId !== undefined) {
      observedSessionIds.push(sessionId);
      const toolName = toolNameFromBody(body);
      if (toolName !== undefined) {
        toolCalls.push({ toolName, sessionId });
      }
    }

    if (isJsonRpcMethod(body, "initialize")) {
      let initializedSessionId: string | undefined;
      const mcpServer = new McpServer(
        { name: "session-continuity-test-server", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (newSessionId) => {
          initializedSessionId = newSessionId;
          assignedSessionIds.push(newSessionId);
          sessions.set(newSessionId, { server: mcpServer, transport });
        },
        onsessionclosed: (closedSessionId) => {
          sessions.delete(closedSessionId);
        },
      });
      registerSessionTools(
        mcpServer,
        () => {
          if (initializedSessionId === undefined) {
            throw new Error(
              "MCP session was not initialized before tool dispatch",
            );
          }
          return initializedSessionId;
        },
        handleSessions,
      );
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }

    if (sessionId === undefined) {
      writeJson(response, 400, {
        error: "Bad Request: Mcp-Session-Id header is required",
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (session === undefined) {
      writeJson(response, 404, { error: "Session not found" });
      return;
    }

    if (failNextListTools && isJsonRpcMethod(body, "tools/list")) {
      failNextListTools = false;
      writeJson(response, 500, {
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Transient tools/list failure" },
      });
      return;
    }

    await session.transport.handleRequest(request, response, body);
  };

  const httpServer: NodeHttpServer = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind local MCP server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    armOneShotListToolsFailure: () => {
      failNextListTools = true;
    },
    assignedSessionIds: () => assignedSessionIds,
    observedSessionIds: () => observedSessionIds,
    toolCallSession: (toolName) =>
      toolCalls.find((observation) => observation.toolName === toolName)
        ?.sessionId,
    close: async () => {
      await Promise.allSettled(
        [...sessions.values()].map((entry) => entry.server.close()),
      );
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function createScenario(
  packageId: string,
): Promise<SessionContinuityScenario> {
  const server = await startSessionBoundMcpServer();
  const packageConfig: PackageConfig = {
    id: packageId,
    name: packageId,
    transport: "http",
    transportType: "http",
    base_url: server.url,
    visibility: "default",
  };
  const config: SuperMcpConfig = { packages: [packageConfig] };
  const registry = new PackageRegistry(config);
  const scenario: SessionContinuityScenario = {
    registry,
    server,
    packageId,
    close: async () => {
      await registry.closeAll();
      await server.close();
    },
  };
  activeScenarios.push(scenario);
  return scenario;
}

function asToolResult(result: unknown): ToolResult {
  if (typeof result !== "object" || result === null) {
    throw new Error("Expected an MCP tool result object");
  }
  return result as ToolResult;
}

function firstText(result: ToolResult): string | undefined {
  return result.content?.find((block) => block.type === "text")?.text;
}

function evictionCount(registry: PackageRegistry, packageId: string): number {
  const stats = registry
    .getChildStats()
    .find((entry) => entry.package_id === packageId);
  if (stats === undefined) {
    throw new Error(`Missing child stats for ${packageId}`);
  }
  return stats.eviction_count;
}

async function mintHandle(
  scenario: SessionContinuityScenario,
): Promise<string> {
  const result = asToolResult(
    await scenario.registry.callTool(scenario.packageId, "mint_handle", {}),
  );
  expect(result.isError).toBe(false);
  const handle = firstText(result);
  if (handle === undefined) {
    throw new Error("mint_handle did not return a text handle");
  }
  return handle;
}

describe("remote HTTP MCP session continuity", () => {
  it("preserves a session-bound handle after a transient health-probe failure", async () => {
    const scenario = await createScenario("session-continuity");
    const lifecycleEvents: RegistryLifecycleEvent[] = [];
    scenario.registry.subscribeLifecycle((event) =>
      lifecycleEvents.push(event),
    );

    const handle = await mintHandle(scenario);
    const mintSession = scenario.server.toolCallSession("mint_handle");
    if (mintSession === undefined) {
      throw new Error("Server did not observe the mint_handle session");
    }
    const evictionsBefore = evictionCount(
      scenario.registry,
      scenario.packageId,
    );

    scenario.server.armOneShotListToolsFailure();
    const useResult = asToolResult(
      await scenario.registry.callTool(scenario.packageId, "use_handle", {
        handle,
      }),
    );

    const useSession = scenario.server.toolCallSession("use_handle");
    const unhealthyEvictions = lifecycleEvents.filter(
      (event) =>
        event.type === "client_evicted" && event.reason === "unhealthy",
    );
    const evictionDelta =
      evictionCount(scenario.registry, scenario.packageId) - evictionsBefore;

    // RED on current code: the failed tools/list probe evicts the live client,
    // creates a new session, and turns this desired successful use into
    // "Invalid handle". The soft assertions expose every link in that chain.
    expect.soft(useResult.isError).toBe(false);
    expect.soft(firstText(useResult)).toBe("Handle accepted");
    expect.soft(useSession).toBe(mintSession);
    expect.soft(unhealthyEvictions).toEqual([]);
    expect.soft(evictionDelta).toBe(0);

    expect.soft(scenario.server.assignedSessionIds()).toHaveLength(1);
    expect
      .soft(new Set(scenario.server.observedSessionIds()))
      .toEqual(new Set([mintSession]));
  });

  it("preserves session-bound handles for a generic remote HTTP MCP package", async () => {
    // This is the artifact proving the failure class belongs to the generic
    // remote HTTP MCP lifecycle, rather than to any connector implementation.
    const scenario = await createScenario("generic-remote-service");
    const handle = await mintHandle(scenario);
    const mintSession = scenario.server.toolCallSession("mint_handle");
    if (mintSession === undefined) {
      throw new Error("Server did not observe the mint_handle session");
    }

    scenario.server.armOneShotListToolsFailure();
    const useResult = asToolResult(
      await scenario.registry.callTool(scenario.packageId, "use_handle", {
        handle,
      }),
    );
    const useSession = scenario.server.toolCallSession("use_handle");

    // Desired green behavior: a transient probe failure must not invalidate
    // state that the remote server explicitly bound to the live MCP session.
    expect.soft(useResult.isError).toBe(false);
    expect.soft(firstText(useResult)).toBe("Handle accepted");
    expect.soft(useSession).toBe(mintSession);
  });
});
