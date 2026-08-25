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
  armPersistent401OnListTools(): void;
  listTools401Count(): number;
  assignedSessionIds(): readonly string[];
  observedSessionIds(): readonly string[];
  toolCallSession(toolName: string): string | undefined;
  close(): Promise<void>;
}

interface HttpScenario {
  registry: PackageRegistry;
  server: SessionBoundMcpServer;
  packageId: string;
  close(): Promise<void>;
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const activeHttpScenarios: HttpScenario[] = [];

afterEach(async () => {
  await Promise.all(
    activeHttpScenarios.splice(0).map((scenario) => scenario.close()),
  );
  vi.restoreAllMocks();
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
  let failAllListTools401 = false;
  let listTools401Count = 0;

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
        { name: "registry-lifecycle-regression-server", version: "1.0.0" },
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

    if (failAllListTools401 && isJsonRpcMethod(body, "tools/list")) {
      listTools401Count += 1;
      writeJson(response, 401, {
        error: "Unauthorized",
        message: "Unauthorized",
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
    armPersistent401OnListTools: () => {
      failAllListTools401 = true;
    },
    listTools401Count: () => listTools401Count,
    assignedSessionIds: () => assignedSessionIds,
    observedSessionIds: () => observedSessionIds,
    toolCallSession: (toolName) =>
      [...toolCalls]
        .reverse()
        .find((observation) => observation.toolName === toolName)?.sessionId,
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

function createRegistry(packages: PackageConfig[]): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  const registry = new PackageRegistry(config);
  (registry as unknown as { packages: PackageConfig[] }).packages = packages;
  return registry;
}

function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
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

function httpPackage(id: string, baseUrl: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    transportType: "http",
    base_url: baseUrl,
    visibility: "default",
  };
}

function childStats(registry: PackageRegistry, packageId: string) {
  const stats = registry
    .getChildStats()
    .find((entry) => entry.package_id === packageId);
  if (stats === undefined) {
    throw new Error(`Missing child stats for ${packageId}`);
  }
  return stats;
}

function spawnCount(registry: PackageRegistry, packageId: string): number {
  return childStats(registry, packageId).spawn_count;
}

function evictionCount(registry: PackageRegistry, packageId: string): number {
  return childStats(registry, packageId).eviction_count;
}

async function createHttpScenario(packageId: string): Promise<HttpScenario> {
  const server = await startSessionBoundMcpServer();
  const packageConfig = httpPackage(packageId, server.url);
  const registry = new PackageRegistry({ packages: [packageConfig] });
  const scenario: HttpScenario = {
    registry,
    server,
    packageId,
    close: async () => {
      await registry.closeAll();
      await server.close();
    },
  };
  activeHttpScenarios.push(scenario);
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

async function mintHandle(scenario: HttpScenario): Promise<string> {
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

describe("registry client-lifecycle regression net", () => {
  describe("stdio transport", () => {
    it("reuses a healthy stdio client across repeated getClient and callTool calls", async () => {
      const packageId = "healthy-stdio";
      const registry = createRegistry([stdioPackage(packageId)]);
      const createSpy = vi
        .spyOn(registry as unknown as { createAndConnectClient: Function }, "createAndConnectClient")
        .mockImplementation(async () =>
          createMockClient({
            healthCheck: vi.fn().mockResolvedValue("ok"),
            callTool: vi
              .fn()
              .mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
          }),
        );

      await registry.getClient(packageId);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(spawnCount(registry, packageId)).toBe(1);

      for (let index = 0; index < 5; index += 1) {
        await registry.getClient(packageId);
      }
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(spawnCount(registry, packageId)).toBe(1);

      for (let index = 0; index < 3; index += 1) {
        const result = asToolResult(
          await registry.callTool(packageId, "ping", {}),
        );
        expect(firstText(result)).toBe("pong");
      }
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(spawnCount(registry, packageId)).toBe(1);
    });
  });

  describe("HTTP transport", () => {
    it("never evicts on persistent needs_auth (401) and preserves session-bound state", async () => {
      const scenario = await createHttpScenario("needs-auth-http");
      const handle = await mintHandle(scenario);
      const mintSession = scenario.server.toolCallSession("mint_handle");
      if (mintSession === undefined) {
        throw new Error("Server did not observe the mint_handle session");
      }

      const clientBefore = await scenario.registry.getClient(scenario.packageId);
      scenario.server.armPersistent401OnListTools();

      const clientAfterProbe = await scenario.registry.getClient(
        scenario.packageId,
      );
      expect(clientAfterProbe).toBe(clientBefore);
      expect(evictionCount(scenario.registry, scenario.packageId)).toBe(0);

      const health = await clientAfterProbe.healthCheck?.();
      expect(health).toBe("needs_auth");

      for (let index = 0; index < 3; index += 1) {
        const sameClient = await scenario.registry.getClient(scenario.packageId);
        expect(sameClient).toBe(clientBefore);
        expect(await sameClient.healthCheck?.()).toBe("needs_auth");
      }
      expect(scenario.server.listTools401Count()).toBeGreaterThanOrEqual(3);
      expect(evictionCount(scenario.registry, scenario.packageId)).toBe(0);

      const useResult = asToolResult(
        await scenario.registry.callTool(scenario.packageId, "use_handle", {
          handle,
        }),
      );
      expect(useResult.isError).toBe(false);
      expect(firstText(useResult)).toBe("Handle accepted");
      expect(scenario.server.toolCallSession("use_handle")).toBe(mintSession);
      expect(evictionCount(scenario.registry, scenario.packageId)).toBe(0);
      expect(scenario.server.assignedSessionIds()).toHaveLength(1);
    });
  });
});
