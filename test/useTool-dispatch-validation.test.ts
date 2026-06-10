import { describe, expect, it, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES, type PackageConfig } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import type { ValidationResult } from "../src/validator.js";

function makePackageConfig(id: string, name = id): PackageConfig {
  return { id, name, transport: "stdio", visibility: "default" };
}

function createMocks(opts: {
  packages?: PackageConfig[];
  toolMatches?: Array<{ packageId: string; toolId: string }>;
} = {}) {
  const packages = opts.packages ?? [makePackageConfig("pkg1")];
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn().mockReturnValue([]),
    getClient: vi.fn().mockResolvedValue(mockClient),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
    findToolByName: vi.fn().mockReturnValue(opts.toolMatches ?? []),
  } as unknown as Catalog;
  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

async function expectDispatchArgValidation(promise: Promise<unknown>) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    code: ERROR_CODES.ARG_VALIDATION_FAILED,
    message: expect.stringContaining("search_tools"),
  });
  expect(caught).toMatchObject({
    message: expect.stringContaining("list_tools"),
  });
  expect(caught).toMatchObject({
    message: expect.stringContaining("get_tool_details"),
  });
}

describe("useTool dispatch-level validation", () => {
  it("rejects a non-object use_tool input with coded recovery guidance", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        undefined as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("rejects missing tool_id with coded recovery guidance before package lookup", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        { package_id: "pkg1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("rejects empty tool_id with coded recovery guidance", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        { package_id: "pkg1", tool_id: "  ", args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
  });

  it("rejects non-object non-JSON args at dispatch before package lookup", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({ packages: [] });

    await expectDispatchArgValidation(
      handleUseTool(
        {
          package_id: "missing",
          tool_id: "tool1",
          args: "not-json",
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("accepts namespaced tool_id without package_id", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      packages: [makePackageConfig("pkg1")],
    });

    const response = await handleUseTool(
      { tool_id: "pkg1__tool1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
    expect(mockCatalog.findToolByName).not.toHaveBeenCalled();
  });

  it("accepts a unique bare tool_id without package_id and reaches the resolver", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      packages: [makePackageConfig("pkg1")],
      toolMatches: [{ packageId: "pkg1", toolId: "tool1" }],
    });

    const response = await handleUseTool(
      { tool_id: "tool1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockCatalog.findToolByName).toHaveBeenCalledWith("tool1");
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
  });

  it("coerces omitted and null args to empty objects", async () => {
    for (const input of [
      { package_id: "pkg1", tool_id: "tool1" },
      { package_id: "pkg1", tool_id: "tool1", args: null },
    ]) {
      const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

      const response = await handleUseTool(
        input as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      );

      expect(response.isError).toBe(false);
      expect(mockValidator.validate).toHaveBeenCalledWith(
        expect.anything(),
        {},
        expect.objectContaining({ package_id: "pkg1", tool_id: "tool1" }),
      );
      expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
    }
  });

  it("accepts stringified JSON object args and forwards the parsed object", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "tool1",
        args: "{\"query\":\"budget\"}",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      { query: "budget" },
      expect.objectContaining({ package_id: "pkg1", tool_id: "tool1" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", { query: "budget" });
  });

  it("treats result_id calls as continuation calls and ignores package/tool/args shape", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        result_id: "missing-cache-entry",
        output_offset: 0,
        args: "not-json",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Cached result expired or not found"),
    });
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
    expect(mockValidator.validate).not.toHaveBeenCalled();
  });

  it("preserves the existing missing output_offset continuation response", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        result_id: "missing-cache-entry",
        args: "not-json",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("output_offset is required"),
    });
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
    expect(mockValidator.validate).not.toHaveBeenCalled();
  });
});
