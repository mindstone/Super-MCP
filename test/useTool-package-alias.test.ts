// R2 regression: super-mcp resolves bare package aliases (e.g. "GoogleWorkspace")
// to the unique active instance ("GoogleWorkspace-greg-work-com") and emits a
// telemetry breadcrumb. Ambiguous aliases throw a structured ACCOUNT_SELECTION
// error so the agent can re-prompt the user.
//
// See docs/plans/260517_mcp_sprint1_p0.md § Stage D.

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import type { PackageConfig } from "../src/types.js";
import { ValidationResult } from "../src/validator.js";

function makePackageConfig(id: string, name = id): PackageConfig {
  return {
    id,
    name,
    transport: "stdio",
    visibility: "default",
  };
}

function createMocks(opts: { packages: PackageConfig[] }) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };

  const packagesById = new Map(opts.packages.map(p => [p.id, p]));

  const mockRegistry = {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn((alias: string) => {
      const aliasLower = alias.toLowerCase();
      const exact = opts.packages.find(p => p.id.toLowerCase() === aliasLower);
      if (exact) return [exact];
      const prefix = `${aliasLower}-`;
      return opts.packages.filter(p => p.id.toLowerCase().startsWith(prefix));
    }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const getTool = (packageId: string, toolId: string) =>
    packagesById.has(packageId) && toolId === "list_workspace_accounts"
      ? { packageId, tool: { name: toolId, inputSchema: { type: "object" } }, schemaHash: "" }
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
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

describe("useTool R2 — bare package alias resolver", () => {
  it("resolves a bare base name to a single active instance and emits a breadcrumb", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("GoogleWorkspace-greg-work-com")],
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace",
        tool_id: "list_workspace_accounts",
        args: {},
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
    expect(superMcp?.packageResolution).toEqual({
      from: "GoogleWorkspace",
      to: "GoogleWorkspace-greg-work-com",
    });
  });

  it("leaves a resolved package_id unchanged", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("GoogleWorkspace-greg-work-com")],
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-greg-work-com",
        tool_id: "list_workspace_accounts",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp).not.toHaveProperty("packageResolution");
  });

  it("throws ACCOUNT_SELECTION-style error on ambiguous alias", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [
        makePackageConfig("GoogleWorkspace-greg-work-com"),
        makePackageConfig("GoogleWorkspace-greg-personal-com"),
      ],
    });

    await expect(handleUseTool(
      {
        package_id: "GoogleWorkspace",
        tool_id: "list_workspace_accounts",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    )).rejects.toMatchObject({
      message: expect.stringContaining("matches 2 active accounts"),
      data: expect.objectContaining({
        ambiguous: true,
        candidates: expect.arrayContaining([
          expect.objectContaining({ package_id: "GoogleWorkspace-greg-work-com" }),
          expect.objectContaining({ package_id: "GoogleWorkspace-greg-personal-com" }),
        ]),
      }),
    });
  });

  it("falls through to PACKAGE_NOT_FOUND when alias matches nothing", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      packages: [makePackageConfig("Slack-mindstone")],
    });

    await expect(handleUseTool(
      {
        package_id: "GoogleWorkspace",
        tool_id: "list_workspace_accounts",
        args: {},
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    )).rejects.toMatchObject({
      message: expect.stringContaining("Package not found: GoogleWorkspace"),
    });
  });
});
