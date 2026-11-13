import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { Validator } from "../src/validator.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES } from "../src/types.js";
import type { PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// FOX-9819: a connector whose sign-in has run out answers HTTP 401 with an
// empty body. With no auth provider attached, the MCP SDK throws
// StreamableHTTPError(401, "Streamable HTTP error: Error POSTing to endpoint: "):
// the 401 is only in `.code`, never in the message.
const MCP_URL = "https://mcp.acme-notes.example/mcp";
const PROTOCOL_VERSION = "2025-11-25";

function httpPackage(id: string): PackageConfig {
  return { id, name: id, transport: "http", base_url: MCP_URL, oauth: true, visibility: "default" } as PackageConfig;
}

function urlOf(url: unknown): string {
  return typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
}

function bodyOf(init?: RequestInit): { method?: string; id?: unknown } | null {
  if (typeof init?.body !== "string") return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

/**
 * A server that answers every POST with an empty-body 401 once `expired` is set.
 * `callsAnswer` decides tools/call alone: "401" guards only calls (discovery still
 * works), "mcp-error" answers with the connector's own JSON-RPC error.
 */
function installServer(options: { expired: boolean; callsAnswer?: "401" | "mcp-error" }) {
  const state = { expired: options.expired };
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (urlOf(url) !== MCP_URL) return new Response(null, { status: 404 });
    if (method === "GET") return new Response(null, { status: 405 });
    const body = bodyOf(init);
    if (state.expired) {
      return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="acme"' } });
    }
    if (body?.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "acme", version: "1" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body?.method === "tools/call" && options.callsAnswer === "401") {
      return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="acme"' } });
    }
    if (body?.method === "tools/call" && options.callsAnswer === "mcp-error") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Upstream said 401" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (body?.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return state;
}

let originalFetch: typeof globalThis.fetch;
let tempDir: string;
let previousTokenDir: string | undefined;
const registries: PackageRegistry[] = [];

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-empty-401-"));
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
});

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.closeAll();
  globalThis.fetch = originalFetch;
  if (previousTokenDir === undefined) delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  else process.env.SUPER_MCP_OAUTH_TOKEN_DIR = previousTokenDir;
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("an empty-body 401 reads as sign-in needed", () => {
  it("connect throws the UnauthorizedError-named error, keeping the SDK error as its cause", async () => {
    installServer({ expired: true });
    const client = new HttpMcpClient("acme-notes", httpPackage("acme-notes"));
    const error = await client.connect().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("UnauthorizedError");
    expect((error as Error).message).toContain("Authentication required");
    expect((error as Error).cause).toBeInstanceOf(StreamableHTTPError);
    expect(((error as Error).cause as StreamableHTTPError).code).toBe(401);
  });

  it("healthCheck reports needs_auth when a connected client's sign-in runs out", async () => {
    const server = installServer({ expired: false });
    const client = new HttpMcpClient("acme-notes", httpPackage("acme-notes"));
    await client.connect();
    server.expired = true;
    expect(await client.healthCheck()).toBe("needs_auth");
    await expect(client.listTools()).rejects.toMatchObject({ name: "UnauthorizedError" });
    await expect(client.callTool("search", {})).rejects.toMatchObject({ name: "UnauthorizedError" });
  });

  it("the registry classifies the connect failure as auth_required, not transport_error", async () => {
    installServer({ expired: true });
    const registry = new PackageRegistry({ mcpServers: { "acme-notes": { url: MCP_URL, oauth: true, name: "Acme Notes" } } });
    registries.push(registry);
    expect(await registry.connectForCatalog("acme-notes")).toMatchObject({ kind: "auth_required" });
  });
});

describe("use_tool on a connected HTTP connector whose sign-in runs out", () => {
  // Discovery (initialize, tools/list) keeps working; only the call is refused,
  // so a reconnect would not reproduce the 401 (stage review F1).
  async function harness(callsAnswer: "401" | "mcp-error") {
    installServer({ expired: false, callsAnswer });
    const registry = new PackageRegistry({ mcpServers: { "acme-notes": { url: MCP_URL, oauth: true, name: "Acme Notes" } } });
    registries.push(registry);
    const client = new HttpMcpClient("acme-notes", httpPackage("acme-notes"));
    await client.connect();
    const callTool = vi.spyOn(client, "callTool");
    vi.spyOn(registry, "getClient").mockResolvedValue(client);
    const catalog = new Catalog(registry);
    catalog.commitReady("acme-notes", [{ name: "search", inputSchema: { type: "object", properties: {} } }], catalog.getConfigurationGeneration());
    const run = () => handleUseTool({ package_id: "acme-notes", tool_id: "search", args: {} }, registry, catalog, new Validator())
      .then(() => undefined, (e: unknown) => e as { code: number; data: Record<string, unknown> });
    return { run, callTool, catalog };
  }

  it("answers PACKAGE_UNAVAILABLE with status auth_required and records it, without replaying the call", async () => {
    const fixture = await harness("401");
    const error = await fixture.run();
    expect(error?.code).toBe(ERROR_CODES.PACKAGE_UNAVAILABLE);
    expect(error?.data).toMatchObject({ package_id: "acme-notes", status: "auth_required" });
    expect(fixture.catalog.getPackageStatus("acme-notes")).toBe("auth_required");
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
  });

  it("leaves a connector's own JSON-RPC error that mentions 401 as a downstream error", async () => {
    const fixture = await harness("mcp-error");
    const error = await fixture.run();
    expect(error?.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(fixture.catalog.getPackageStatus("acme-notes")).toBe("ready");
  });
});
