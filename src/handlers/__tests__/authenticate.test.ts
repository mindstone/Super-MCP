import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../utils/formatError.js", () => ({
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const PACKAGE_ID = "Slack-mindstone";

function createRegistry(client: { listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> }): PackageRegistry {
  return {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "stdio",
    }),
    getClient: vi.fn().mockResolvedValue(client),
  } as unknown as PackageRegistry;
}

function createCatalog(): Catalog {
  return {} as Catalog;
}

function expectLegacyResponse(result: any): void {
  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed).toEqual({
    package_id: PACKAGE_ID,
    status: "success",
    message: "stdio packages don't require authentication",
  });
}

describe("handleAuthenticate stdio delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to authenticate_* tool for stdio packages", async () => {
    const delegatedResult = {
      content: [{ type: "text", text: '{"status":"success","authUrl":"https://example.com"}' }],
      isError: false,
    };
    const client = {
      listTools: vi.fn().mockResolvedValue([
        { name: "list_tools" },
        { name: "authenticate_slack_workspace" },
      ]),
      callTool: vi.fn().mockResolvedValue(delegatedResult),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith("authenticate_slack_workspace", {});
    expect(mockLogger.info).toHaveBeenCalledWith("Delegating to stdio package's auth tool", {
      package_id: PACKAGE_ID,
      tool: "authenticate_slack_workspace",
    });
    expect(result).toBe(delegatedResult);
  });

  it("returns legacy success message when stdio package has no auth tool", async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: "list_channels" }]),
      callTool: vi.fn(),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.callTool).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expectLegacyResponse(result);
  });

  it("logs warn and falls back when listTools throws", async () => {
    const client = {
      listTools: vi.fn().mockRejectedValue(new Error("listTools boom")),
      callTool: vi.fn(),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.callTool).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to delegate to stdio auth tool, falling back to legacy response",
      expect.objectContaining({
        package_id: PACKAGE_ID,
        error: "listTools boom",
      })
    );
    expectLegacyResponse(result);
  });

  it("logs warn and falls back when delegated auth tool call fails", async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: "authenticate_slack_workspace" }]),
      callTool: vi.fn().mockRejectedValue(new Error("callTool boom")),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.callTool).toHaveBeenCalledWith("authenticate_slack_workspace", {});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to delegate to stdio auth tool, falling back to legacy response",
      expect.objectContaining({
        package_id: PACKAGE_ID,
        error: "callTool boom",
      })
    );
    expectLegacyResponse(result);
  });

  it("delegates when stdio package exposes exact authenticate tool name", async () => {
    const delegatedResult = {
      content: [{ type: "text", text: '{"status":"success"}' }],
      isError: false,
    };
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: "authenticate" }]),
      callTool: vi.fn().mockResolvedValue(delegatedResult),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.callTool).toHaveBeenCalledWith("authenticate", {});
    expect(mockLogger.info).toHaveBeenCalledWith("Delegating to stdio package's auth tool", {
      package_id: PACKAGE_ID,
      tool: "authenticate",
    });
    expect(result).toBe(delegatedResult);
  });
});
