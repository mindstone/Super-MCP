// R5 regression: super-mcp resolves bare tool names (e.g. "search_workspace_emails")
// across loaded packages when neither package_id nor a `Package__` prefix is supplied.
// Unique match wins (breadcrumb); ambiguous match surfaces a structured error.
//
// See docs/plans/260517_mcp_sprint1_p0.md § Stage E.

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import type { PackageConfig } from "../src/types.js";
import { ValidationResult } from "../src/validator.js";

function makePackageConfig(id: string, name = id): PackageConfig {
  return { id, name, transport: "stdio", visibility: "default" };
}

function createMocks(opts: {
  packages: PackageConfig[];
  toolMatches: Array<{ packageId: string; toolId: string }>;
}) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };

  const packagesById = new Map(opts.packages.map(p => [p.id, p]));

  const mockRegistry = {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn().mockReturnValue([]),
    getClient: vi.fn().mockResolvedValue(mockClient),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue({ type: "object" }),
    findToolByName: vi.fn().mockReturnValue(opts.toolMatches),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator };
}

describe("useTool R5 — bare tool-name resolver", () => {
  it("resolves a bare tool to its single owning package and emits a breadcrumb", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("GoogleWorkspace-greg-work-com")],
      toolMatches: [{ packageId: "GoogleWorkspace-greg-work-com", toolId: "search_workspace_emails" }],
    });

    const response = await handleUseTool(
      {
        package_id: "",
        tool_id: "search_workspace_emails",
        args: { query: "from:me" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.packageId).toBe("GoogleWorkspace-greg-work-com");
    expect(superMcp?.toolResolution).toEqual({
      from: "search_workspace_emails",
      to: "search_workspace_emails",
      packageId: "GoogleWorkspace-greg-work-com",
    });
  });

  it("ignores R5 when tool_id contains a `Package__` prefix", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("GoogleWorkspace-greg-work-com")],
      toolMatches: [],
    });

    const response = await handleUseTool(
      {
        package_id: "",
        tool_id: "GoogleWorkspace-greg-work-com__search_workspace_emails",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    // Namespacing path extracted the package, R5 was skipped (no breadcrumb).
    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.packageId).toBe("GoogleWorkspace-greg-work-com");
    expect(superMcp).not.toHaveProperty("toolResolution");
  });

  it("throws AMBIGUOUS_TOOL when multiple packages register the same bare name", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [
        makePackageConfig("OpenAIImageGeneration"),
        makePackageConfig("Runway"),
      ],
      toolMatches: [
        { packageId: "OpenAIImageGeneration", toolId: "generate_image" },
        { packageId: "Runway", toolId: "generate_image" },
      ],
    });

    await expect(handleUseTool(
      {
        package_id: "",
        tool_id: "generate_image",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    )).rejects.toMatchObject({
      message: expect.stringContaining("matches 2 loaded packages"),
      data: expect.objectContaining({
        ambiguous: true,
        candidates: expect.arrayContaining([
          expect.objectContaining({ package_id: "OpenAIImageGeneration" }),
          expect.objectContaining({ package_id: "Runway" }),
        ]),
      }),
    });
  });

  it("falls through to PACKAGE_NOT_FOUND when bare tool matches no loaded packages", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("Slack-mindstone")],
      toolMatches: [],
    });

    await expect(handleUseTool(
      {
        package_id: "",
        tool_id: "search_workspace_emails",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    )).rejects.toMatchObject({
      message: expect.stringContaining("Package not found:"),
    });
  });
});
