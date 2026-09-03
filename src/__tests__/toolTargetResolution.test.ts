import { describe, expect, it, vi } from "vitest";
import type { CachedTool, Catalog, CatalogView } from "../catalog.js";
import type { PackageRegistry } from "../registry.js";
import {
  ERROR_CODES,
  type CatalogStatus,
  type PackageConfig,
} from "../types.js";
import { handleUseTool } from "../handlers/useTool.js";
import { resolveToolTarget } from "../toolTargetResolution.js";

const securityPolicy = {
  isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
  isAdminDisabled: vi.fn().mockReturnValue(false),
  isUserDisabled: vi.fn().mockReturnValue(false),
};

vi.mock("../security.js", () => ({
  getSecurityPolicy: () => securityPolicy,
}));

vi.mock("../logging.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeTool(packageId: string, name: string): CachedTool {
  return {
    packageId,
    tool: {
      name,
      inputSchema: { type: "object", properties: {} },
    },
    schemaHash: `sha256:${name}`,
  };
}

function makeRegistry(packageIds: readonly string[]): PackageRegistry {
  const packages = new Map<string, PackageConfig>(
    packageIds.map((id) => [
      id,
      { id, name: id, transport: "stdio", visibility: "default" },
    ]),
  );
  return {
    getPackage: vi.fn((packageId: string) => packages.get(packageId)),
  } as unknown as PackageRegistry;
}

function makeCatalog(
  status: CatalogStatus | "unknown",
  tools: readonly CachedTool[] = [],
  detail?: string,
): CatalogView {
  return {
    getPackageStatus: vi.fn().mockReturnValue(status),
    getPackageError: vi.fn().mockReturnValue(detail),
    getRetryHint: vi.fn().mockReturnValue({
      retryAt: null,
      retryInMs: null,
      schedule: "none",
    }),
    getTool: vi.fn((packageId: string, toolId: string) =>
      tools.find(
        (entry) => entry.packageId === packageId && entry.tool.name === toolId,
      ),
    ),
    getToolSchema: vi.fn(
      (packageId: string, toolId: string) =>
        tools.find(
          (entry) =>
            entry.packageId === packageId && entry.tool.name === toolId,
        )?.tool.inputSchema,
    ),
  } as unknown as CatalogView;
}

describe("resolveToolTarget", () => {
  it("returns identical present results for bare and exactly-prefixed ids", () => {
    const registry = makeRegistry(["P"]);
    const catalog = makeCatalog("ready", [makeTool("P", "search")]);

    const bare = resolveToolTarget({ catalog, registry }, "P", "search");
    const namespaced = resolveToolTarget(
      { catalog, registry },
      "P",
      "P__search",
    );

    expect(bare).toEqual({
      outcome: "present",
      packageId: "P",
      bareToolId: "search",
      namespacedToolId: "P__search",
      schemaHash: "sha256:search",
      tool: makeTool("P", "search"),
    });
    expect(namespaced).toEqual(bare);
  });

  it("keeps a legitimate double-underscore inside a bare tool name", () => {
    const registry = makeRegistry(["P"]);
    const catalog = makeCatalog("ready", [makeTool("P", "foo__bar")]);

    expect(
      resolveToolTarget({ catalog, registry }, "P", "foo__bar"),
    ).toMatchObject({
      outcome: "present",
      bareToolId: "foo__bar",
      namespacedToolId: "P__foo__bar",
    });
  });

  it("returns absent only for a missing tool on a ready, exact package", () => {
    const registry = makeRegistry(["P"]);
    const catalog = makeCatalog("ready", [makeTool("P", "search")]);

    expect(resolveToolTarget({ catalog, registry }, "P", "invented")).toEqual({
      outcome: "absent",
      packageId: "P",
      bareToolId: "invented",
      namespacedToolId: "P__invented",
    });
  });

  it.each([
    ["connecting", "connecting"],
    ["auth_required", "auth_required"],
    ["setup_incomplete", "setup_incomplete"],
    ["error", "error"],
  ] as const)(
    "returns unavailable/%s for a known package",
    (status, reason) => {
      const registry = makeRegistry(["P"]);
      const catalog = makeCatalog(status, [], `detail:${status}`);

      expect(resolveToolTarget({ catalog, registry }, "P", "search")).toEqual({
        outcome: "unavailable",
        packageId: "P",
        reason,
        detail: `detail:${status}`,
      });
    },
  );

  it("returns package_unknown before consulting catalog state", () => {
    const registry = makeRegistry([]);
    const catalog = makeCatalog("ready", [makeTool("P", "search")]);

    expect(resolveToolTarget({ catalog, registry }, "P", "search")).toEqual({
      outcome: "unavailable",
      packageId: "P",
      reason: "package_unknown",
    });
    expect(catalog.getPackageStatus).not.toHaveBeenCalled();
    expect(catalog.getTool).not.toHaveBeenCalled();
  });

  it("treats a raw package alias as package_unknown, never absent", () => {
    const registry = makeRegistry(["GoogleWorkspace-account"]);
    const catalog = makeCatalog("ready", [
      makeTool("GoogleWorkspace-account", "search_workspace_emails"),
    ]);

    expect(
      resolveToolTarget(
        { catalog, registry },
        "GoogleWorkspace",
        "search_workspace_emails",
      ),
    ).toEqual({
      outcome: "unavailable",
      packageId: "GoogleWorkspace",
      reason: "package_unknown",
    });
    expect(catalog.getTool).not.toHaveBeenCalled();
  });
});

describe("handleUseTool resolver integration", () => {
  it("preserves the byte-identical TOOL_NOT_FOUND contract", async () => {
    const registry = makeRegistry(["P"]);
    const catalog = {
      ...makeCatalog("ready"),
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    } as unknown as Catalog;

    await expect(
      handleUseTool(
        { package_id: "P", tool_id: "missing", args: {} },
        registry,
        catalog,
        { validate: vi.fn() },
      ),
    ).rejects.toEqual({
      code: ERROR_CODES.TOOL_NOT_FOUND,
      message: "Tool not found: missing in package P",
      data: { package_id: "P", tool_id: "missing" },
    });
  });

  it("keeps package-status errors ahead of the resolver", async () => {
    const registry = makeRegistry(["P"]);
    const catalog = {
      ...makeCatalog("auth_required"),
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    } as unknown as Catalog;

    await expect(
      handleUseTool(
        { package_id: "P", tool_id: "search", args: {} },
        registry,
        catalog,
        { validate: vi.fn() },
      ),
    ).rejects.toEqual({
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message:
        "Package 'P' requires authentication. Run 'authenticate(package_id: \"P\")'.",
      data: { package_id: "P", status: "auth_required" },
    });
    expect(catalog.getRetryHint).not.toHaveBeenCalled();
    expect(catalog.getTool).not.toHaveBeenCalled();
  });
});
