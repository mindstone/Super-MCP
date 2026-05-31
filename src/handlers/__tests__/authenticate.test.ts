import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAuthenticate,
  isEligibleForZeroArgAuthDelegation,
} from "../authenticate.js";
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
    message: "Package does not expose an authentication tool — no action needed.",
  });
}

describe("handleAuthenticate stdio delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("isEligibleForZeroArgAuthDelegation", () => {
    it("rejects authenticate tools with required arguments", () => {
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_workspace_account",
        inputSchema: {
          type: "object",
          required: ["workspace_id"],
        },
      })).toBe(false);
    });

    it("accepts authenticate tools with no required arguments", () => {
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_slack_workspace",
        inputSchema: {
          type: "object",
          properties: {
            force: { type: "boolean" },
          },
        },
      })).toBe(true);

      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate",
        input_schema: {
          type: "object",
          required: [],
        },
      })).toBe(true);
    });

    it("rejects non-authentication tools", () => {
      expect(isEligibleForZeroArgAuthDelegation({
        name: "list_slack_channels",
        inputSchema: {
          type: "object",
          required: [],
        },
      })).toBe(false);
    });

    // C40 review F1: `{}` can be invalid WITHOUT a top-level `required` — these
    // schema shapes must also be ineligible (eligibility = "does `{}` validate?").
    it("rejects schemas where {} is invalid without a top-level required", () => {
      // minProperties: 1
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_a",
        inputSchema: { type: "object", minProperties: 1 },
      })).toBe(false);
      // anyOf branch requires an arg
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_b",
        inputSchema: { type: "object", anyOf: [{ required: ["workspace_id"] }] },
      })).toBe(false);
      // allOf branch requires an arg
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_c",
        inputSchema: { type: "object", allOf: [{ required: ["account"] }] },
      })).toBe(false);
      // $ref to a definition with a required arg
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_d",
        inputSchema: {
          $ref: "#/$defs/in",
          $defs: { in: { type: "object", required: ["token"] } },
        },
      })).toBe(false);
      // snake_case input_schema with a required arg
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_e",
        input_schema: { type: "object", required: ["org_id"] },
      })).toBe(false);
    });

    it("treats a malformed/uncompilable schema as ineligible (fail closed)", () => {
      expect(isEligibleForZeroArgAuthDelegation({
        name: "authenticate_f",
        inputSchema: { type: "object", required: "not-an-array" },
      })).toBe(false);
    });
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

  it("returns error response when delegated auth tool call fails", async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: "authenticate_slack_workspace" }]),
      callTool: vi.fn().mockRejectedValue(new Error("callTool boom")),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.callTool).toHaveBeenCalledWith("authenticate_slack_workspace", {});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to delegate to stdio auth tool",
      expect.objectContaining({
        package_id: PACKAGE_ID,
        tool: "authenticate_slack_workspace",
        error: "callTool boom",
      })
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      package_id: PACKAGE_ID,
      status: "error",
      error: "Authentication delegation failed: callTool boom",
      delegated_tool: "authenticate_slack_workspace",
    });
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

  it("refuses zero-arg generic delegation when authenticate_* tool requires input args", async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: "authenticate_workspace_account",
          inputSchema: {
            type: "object",
            required: ["email"],
          },
        },
      ]),
      callTool: vi.fn(),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.callTool).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Stdio auth tools require arguments; refusing zero-arg generic delegation",
      expect.objectContaining({
        package_id: PACKAGE_ID,
        tools: [{
          tool: "authenticate_workspace_account",
          required: ["email"],
        }],
      }),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      package_id: PACKAGE_ID,
      status: "error",
      error:
        "This connector's authentication tool needs additional information, so Rebel cannot start it automatically. Please reconnect this connector from Settings.",
      ineligible_auth_tools: [{
        tool: "authenticate_workspace_account",
        required: ["email"],
      }],
    });
  });

  it("selects an eligible zero-arg authenticate_* tool over an ineligible required-arg candidate", async () => {
    const delegatedResult = {
      content: [{ type: "text", text: '{"status":"success"}' }],
      isError: false,
    };
    const client = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: "authenticate_workspace_account",
          inputSchema: {
            type: "object",
            required: ["workspace_id"],
          },
        },
        {
          name: "authenticate_slack_workspace",
          inputSchema: {
            type: "object",
            properties: {
              force: { type: "boolean" },
            },
          },
        },
      ]),
      callTool: vi.fn().mockResolvedValue(delegatedResult),
    };
    const registry = createRegistry(client);

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith("authenticate_slack_workspace", {});
    expect(result).toBe(delegatedResult);
  });

  it("returns error response when delegated auth tool call times out", async () => {
    vi.useFakeTimers();

    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: "authenticate_slack_workspace" }]),
      callTool: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const registry = createRegistry(client);

    const resultPromise = handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await resultPromise;

    expect(client.callTool).toHaveBeenCalledWith("authenticate_slack_workspace", {});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Delegated stdio auth tool timed out",
      expect.objectContaining({
        package_id: PACKAGE_ID,
        tool: "authenticate_slack_workspace",
      }),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      package_id: PACKAGE_ID,
      status: "error",
      error: "Authentication delegation failed: Delegated stdio auth tool timed out after 60000ms",
      delegated_tool: "authenticate_slack_workspace",
    });
  });
});
