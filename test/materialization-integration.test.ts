import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

describe("Materialization Integration (I1-I4)", () => {
  let tempWorkspace: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rebel-mcp-integration-"));
    originalEnv = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    process.env.REBEL_WORKSPACE_PATH = originalEnv;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Mock dependencies for handleUseTool
  const createMocks = (toolResult: unknown) => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue(toolResult),
    };
    
    const mockRegistry = {
      getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
      getClient: vi.fn().mockResolvedValue(mockClient),
      // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
      // delegate to the same mocked client so existing callTool assertions hold.
      callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
      notifyActivity: vi.fn(),
    } as unknown as PackageRegistry;

    const toolSchema = { type: "object" };
    const getTool = (packageId: string, toolId: string) =>
      packageId === "pkg1" && toolId === "tool1"
        ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
        : undefined;
    const mockCatalog = {
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      getPackageStatus: vi.fn().mockReturnValue("ready"),
      getRefreshInFlight: vi.fn().mockReturnValue(false),
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
  };

  it("I1 & I2 & I3: Output >100K -> file appears, content matches, relative path returned", async () => {
    const text = "A".repeat(150_000);
    const mockToolResult = {
      content: [{ type: "text", text }]
    };

    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    
    // I3: Response includes correct relative file path
    const filePath = responseData.result.file_path;
    expect(filePath).toBeTruthy();
    expect(filePath).toMatch(/^\.rebel\/tool-outputs\//);

    // I1: File appears in temp workspace
    const absolutePath = path.join(tempWorkspace, filePath);
    const stat = await fs.stat(absolutePath);
    expect(stat.isFile()).toBe(true);

    // I2: File content matches original tool output exactly
    const fileContent = await fs.readFile(absolutePath, "utf8");
    expect(fileContent).toContain(text);
  });

  it("I4: Continuation still works when workspace unavailable", async () => {
    // Make workspace unavailable
    delete process.env.REBEL_WORKSPACE_PATH;

    const text = "A".repeat(150_000);
    const mockToolResult = {
      content: [{ type: "text", text }]
    };

    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator
    );

    expect(result.isError).toBe(false);
    const responseText = result.content[0].text;
    
    // Should fallback to truncation + continuation
    expect(responseText).toContain("[Result truncated to");
    expect(responseText).toContain("To retrieve the full untruncated result");
    
    const responseData = JSON.parse(responseText.split("\n\n")[0]); // Ignore the appended continuation string
    expect(responseData.result.status).not.toBe("materialized");
    expect(responseData.telemetry.output_truncated).toBe(true);
    expect(responseData.telemetry.result_id).toBeTruthy();
  });
});
