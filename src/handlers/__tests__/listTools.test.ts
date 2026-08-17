import { describe, expect, it, vi } from "vitest";
import { handleListTools } from "../listTools.js";
import { ERROR_CODES, type ToolInfo } from "../../types.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

// A1 contract: list_tools requires package_id. A missing/empty package_id must
// fail fast with a coded INVALID_PARAMS error naming the absent field — NOT a
// misleading "Package 'undefined' is unavailable" from ensurePackageLoaded.
// See docs/plans/260817_chunk9-supermcp-connector/PLAN.md Stage A1 (R4).

function createMocks(packageId: string) {
  const ensurePackageLoaded = vi.fn().mockResolvedValue(undefined);
  const catalog = {
    ensurePackageLoaded,
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    buildToolInfos: vi.fn().mockResolvedValue([
      { package_id: packageId, tool_id: `${packageId}__do_thing`, name: `${packageId}__do_thing` },
    ] as ToolInfo[]),
  } as unknown as Catalog;
  const registry = {
    getPackage: vi.fn().mockReturnValue(undefined),
  } as unknown as PackageRegistry;
  return { ensurePackageLoaded, catalog, registry };
}

describe("handleListTools — required-parameter pre-validation", () => {
  it("throws INVALID_PARAMS naming the absent field when package_id is missing", async () => {
    const { ensurePackageLoaded, catalog, registry } = createMocks("TestPackage");

    await expect(
      handleListTools({} as never, catalog, undefined, registry),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("package_id"),
      data: { field: "package_id" },
    });

    // Guard must run BEFORE package loading: the fail-fast contract replaces
    // the misleading "Package 'undefined' is unavailable" path entirely.
    expect(ensurePackageLoaded).not.toHaveBeenCalled();
  });

  it("throws INVALID_PARAMS for an empty-string package_id", async () => {
    const { ensurePackageLoaded, catalog, registry } = createMocks("TestPackage");

    await expect(
      handleListTools({ package_id: "", detail: "lite" }, catalog, undefined, registry),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("package_id"),
      data: { field: "package_id" },
    });

    expect(ensurePackageLoaded).not.toHaveBeenCalled();
  });

  it("throws INVALID_PARAMS for a whitespace-only package_id", async () => {
    const { ensurePackageLoaded, catalog, registry } = createMocks("TestPackage");

    await expect(
      handleListTools({ package_id: "   ", detail: "lite" }, catalog, undefined, registry),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("package_id"),
      data: { field: "package_id" },
    });

    expect(ensurePackageLoaded).not.toHaveBeenCalled();
  });

  it("still serves a well-formed package_id request (guard is additive)", async () => {
    const { ensurePackageLoaded, catalog, registry } = createMocks("TestPackage");

    const response = await handleListTools(
      { package_id: "TestPackage", detail: "lite", page_size: 10 },
      catalog,
      undefined,
      registry,
    );

    expect(ensurePackageLoaded).toHaveBeenCalledWith("TestPackage");
    expect(response.isError).toBe(false);
    const payload = JSON.parse(response.content[0].text) as { tools: ToolInfo[] };
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].tool_id).toBe("TestPackage__do_thing");
  });
});
