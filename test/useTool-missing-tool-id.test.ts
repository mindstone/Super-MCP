// REBEL-62D: the MCP SDK does not enforce a tool's `required` inputSchema, so a
// use_tool call can arrive with tool_id missing/empty (model slip, or an
// upstream stringified-args bug). The namespaced-id `.includes()` checks then
// threw a raw TypeError that surfaced as a generic -32603 INTERNAL_ERROR the
// model could not recover from. handleUseTool must instead fail with a coded,
// actionable ARG_VALIDATION_FAILED.

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES } from "../src/types.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

function createMocks() {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "google_workspace_demo" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const getTool = (packageId: string, toolId: string) =>
    packageId === "google_workspace_demo" && toolId === "list_workspace_accounts"
      ? {
          packageId,
          tool: {
            name: toolId,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          schemaHash: "",
        }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
  } as unknown as Catalog;
  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };
  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

describe("useTool — missing tool_id (REBEL-62D)", () => {
  it("rejects with a coded ARG_VALIDATION_FAILED (not a raw TypeError) when tool_id is undefined", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();
    await expect(
      handleUseTool(
        { package_id: "google_workspace_demo", tool_id: undefined as unknown as string, args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
  });

  it("rejects with the coded error for an empty-string tool_id too", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();
    await expect(
      handleUseTool(
        { package_id: "x", tool_id: "", args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
  });

  it("does NOT throw the coded error when a valid tool_id is provided (regression guard)", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();
    const response = await handleUseTool(
      { package_id: "google_workspace_demo", tool_id: "list_workspace_accounts", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );
    expect(response.isError).toBe(false);
  });
});
