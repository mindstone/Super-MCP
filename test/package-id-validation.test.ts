// Residue-chunk9 item 3 (origin 260811_degenerate-output-handling#R4 /
// diagnosis-B F3): when the model calls a package-scoped meta-tool with a
// missing/empty/"undefined" package_id, the handlers used to emit opaque
// errors like "Package 'undefined' is unavailable: …" or
// "Package not found: undefined" that taught the caller nothing. Each of the
// four handlers must now fail fast with an actionable error that names the
// discovery tool (list_tool_packages), via the shared helpers in
// src/utils/normalizeInput.ts (requirePackageId / isMissingPackageId /
// packageIdRequiredMessage / PACKAGE_DISCOVERY_HINT).
//
// These tests were written against the pre-fix behavior (red): a missing
// package_id fell through to PACKAGE_UNAVAILABLE / PACKAGE_NOT_FOUND /
// catalog-status errors with no discovery guidance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleListTools } from "../src/handlers/listTools.js";
import { handleGetToolDetails } from "../src/handlers/getToolDetails.js";
import { handleBulkExport } from "../src/handlers/bulkExport.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import type { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";
import type { PackageConfig } from "../src/types.js";
import { ERROR_CODES } from "../src/types.js";
import type { ValidationResult } from "../src/validator.js";

const { mockLogger, mockToolNotesStore } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  },
  mockToolNotesStore: {
    readSnapshot: vi.fn(),
    compactSnapshotEntries: vi.fn(),
  },
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../src/toolNotes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/toolNotes.js")>();
  return {
    ...actual,
    getToolNotesStore: () => mockToolNotesStore,
  };
});

// Shared mock security policy (same shape as the sibling handler tests).
const mockSecurityPolicy = {
  isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
  isUserDisabled: vi.fn().mockReturnValue(false),
  isAdminDisabled: vi.fn().mockReturnValue(false),
};

vi.mock("../src/security.js", () => ({
  getSecurityPolicy: () => mockSecurityPolicy,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Catalog that mimics production for an absent/unknown package id: loading
 * fails and the package lands in status "error" with the registry's not-found
 * reason — the pre-fix source of "Package 'undefined' is unavailable: …".
 */
function createErrorStatusCatalog(): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("error"),
    getPackageError: vi.fn().mockImplementation(
      (pkgId: string) =>
        `Package '${pkgId}' not found in configuration. Available packages: filesystem, github`,
    ),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null }),
    buildToolInfos: vi.fn(),
    getTool: vi.fn(),
    getToolSchema: vi.fn(),
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
}

function makePackageConfig(id: string): PackageConfig {
  return { id, name: id, transport: "stdio", visibility: "default" };
}

/** Registry that only knows the given package ids (production-like misses). */
function createRegistry(knownIds: string[] = []): PackageRegistry {
  const packagesById = new Map(knownIds.map((id) => [id, makePackageConfig(id)]));
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  return {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn().mockReturnValue([]),
    getClient: vi.fn().mockResolvedValue(mockClient),
    callTool: vi.fn(
      async (_pkg: string, toolId: string, toolArgs: unknown) =>
        mockClient.callTool(toolId, toolArgs),
    ),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
}

function createUseToolMocks(opts: { knownIds?: string[] } = {}) {
  const mockRegistry = createRegistry(opts.knownIds ?? []);
  const toolSchema = { type: "object" };
  const getTool = (packageId: string, toolId: string) =>
    packageId === "filesystem" && toolId === "read_file"
      ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
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
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
  const mockValidator = {
    validate: vi.fn().mockReturnValue({
      valid: true,
      errors: [],
      strippedArgs: [],
    } as unknown as ValidationResult),
  };
  return { mockRegistry, mockCatalog, mockValidator };
}

/** The degenerate package_id shapes the shared validation must reject. */
const MISSING_PACKAGE_ID_CASES: Array<{ label: string; value: unknown }> = [
  { label: "undefined (key present)", value: undefined },
  { label: "empty string", value: "" },
  { label: "whitespace-only string", value: "   " },
  { label: 'stringified "undefined"', value: "undefined" },
  { label: 'stringified "null"', value: "null" },
];

// ---------------------------------------------------------------------------
// list_tools
// ---------------------------------------------------------------------------

describe("list_tools — package_id input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(MISSING_PACKAGE_ID_CASES)(
    "rejects package_id = $label with actionable INVALID_PARAMS before touching the catalog",
    async ({ value }) => {
      const catalog = createErrorStatusCatalog();
      let thrown: any;
      await handleListTools(
        { package_id: value } as any,
        catalog,
        null,
        createRegistry(),
      ).catch((error: any) => {
        thrown = error;
      });

      expect(thrown).toBeTruthy();
      expect(thrown.code).toBe(ERROR_CODES.INVALID_PARAMS);
      expect(thrown.message).toMatch(/"package_id" is required for list_tools/);
      expect(thrown.message).toContain("list_tool_packages");
      // Validation must fire before the package is loaded — the opaque
      // "Package 'undefined' is unavailable" path is unreachable now.
      expect(catalog.ensurePackageLoaded).not.toHaveBeenCalled();
    },
  );

  it("still lists tools for a well-formed package_id (regression guard)", async () => {
    const catalog = {
      getPackageStatus: vi.fn().mockReturnValue("ready"),
      getPackageError: vi.fn().mockReturnValue(undefined),
      getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null }),
      getPackageTools: vi.fn().mockReturnValue([]),
    } as unknown as Catalog;

    const result = await handleListTools(
      { package_id: "filesystem" },
      catalog,
      null,
      createRegistry(["filesystem"]),
    );

    expect(result.isError).toBe(false);
    expect(catalog.getPackageTools).toHaveBeenCalledWith("filesystem");
  });
});

// ---------------------------------------------------------------------------
// use_tool
// ---------------------------------------------------------------------------

describe("use_tool — package_id input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing package_id once no fallback could materialize one", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks();
    await expect(
      handleUseTool({ tool_id: "send_email", args: {} } as any, mockRegistry, mockCatalog, mockValidator),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("list_tool_packages"),
    });
  });

  it.each(MISSING_PACKAGE_ID_CASES.filter((c) => typeof c.value === "string" && c.value.trim() !== ""))(
    "rejects package_id = $label with discovery guidance",
    async ({ value }) => {
      const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks();
      await expect(
        handleUseTool(
          { package_id: value, tool_id: "send_email", args: {} } as any,
          mockRegistry,
          mockCatalog,
          mockValidator,
        ),
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_PARAMS,
        message: expect.stringMatching(/"package_id" is required for use_tool/),
      });
    },
  );

  it("does NOT reject when the namespaced tool_id supplies the package (supported shape)", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({
      knownIds: ["filesystem"],
    });
    const response = await handleUseTool(
      { tool_id: "filesystem__read_file", args: {} } as any,
      mockRegistry,
      mockCatalog,
      mockValidator,
    );
    expect(response.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_tool_details
// ---------------------------------------------------------------------------

describe("get_tool_details — package prefix validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToolNotesStore.readSnapshot.mockResolvedValue([]);
    mockToolNotesStore.compactSnapshotEntries.mockResolvedValue(undefined);
  });

  it("flags 'undefined__tool' and '__tool' IDs with actionable guidance (not opaque package errors)", async () => {
    const catalog = createErrorStatusCatalog();
    const result = await handleGetToolDetails(
      { tool_ids: ["undefined__search_records", "__another"] },
      catalog,
      createRegistry(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools).toHaveLength(2);

    for (const toolId of ["undefined__search_records", "__another"]) {
      const entry = parsed.tools.find((t: any) => t.tool_id === toolId);
      expect(entry.not_found).toBe(true);
      expect(entry.description).toContain("list_tool_packages");
      expect(entry.description).toContain("package prefix");
    }
  });

  it("no-separator tool_id guidance also names the discovery tool", async () => {
    const result = await handleGetToolDetails(
      { tool_ids: ["send_email"] },
      createErrorStatusCatalog(),
      createRegistry(),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools[0].not_found).toBe(true);
    expect(parsed.tools[0].description).toContain("Invalid tool ID format");
    expect(parsed.tools[0].description).toContain("list_tool_packages");
  });

  it("still hydrates well-formed tool_ids (regression guard)", async () => {
    const catalog = {
      getPackageStatus: vi.fn().mockReturnValue("ready"),
      getPackageError: vi.fn().mockReturnValue(undefined),
      getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null }),
      getTool: vi.fn().mockReturnValue({
        packageId: "filesystem",
        tool: { name: "read_file", description: "Reads a file", inputSchema: { type: "object" } },
        summary: "Reads a file",
        argsSkeleton: { path: "<string>" },
        schemaHash: "sha256:x",
      }),
    } as unknown as Catalog;

    const result = await handleGetToolDetails(
      { tool_ids: ["filesystem__read_file"] },
      catalog,
      createRegistry(["filesystem"]),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools[0].not_found).toBeUndefined();
    expect(parsed.tools[0].description).toBe("Reads a file");
  });
});

// ---------------------------------------------------------------------------
// bulk_export
// ---------------------------------------------------------------------------

describe("bulk_export — package_id input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing package_id with discovery guidance (and keeps the namespaced alternative)", async () => {
    const result = await handleBulkExport(
      { tool_id: "list_records", args: {}, output_file: "out.ndjson" } as any,
      createRegistry(),
      createErrorStatusCatalog(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"package_id" is required for bulk_export');
    expect(result.content[0].text).toContain("list_tool_packages");
    expect(result.content[0].text).toContain("Package__tool_name");
  });

  it('rejects a stringified "undefined" package_id (previously fell through to "Package not found: undefined")', async () => {
    // Registry that knows nothing — pre-fix this produced the opaque
    // "Package not found: undefined" with no recovery guidance.
    const result = await handleBulkExport(
      { package_id: "undefined", tool_id: "list_records", args: {}, output_file: "out.ndjson" },
      createRegistry(),
      createErrorStatusCatalog(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"package_id" is required for bulk_export');
    expect(result.content[0].text).toContain("list_tool_packages");
  });

  it("unknown-but-present package_id keeps the not-found message and names the discovery tool (case b)", async () => {
    const result = await handleBulkExport(
      { package_id: "SalesforceTypo", tool_id: "list_records", args: {}, output_file: "out.ndjson" },
      createRegistry(["filesystem"]),
      createErrorStatusCatalog(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Package not found: SalesforceTypo");
    expect(result.content[0].text).toContain("list_tool_packages");
  });

  it("namespaced tool_id still supplies the package (extraction regression guard)", async () => {
    const result = await handleBulkExport(
      { tool_id: "Filesystem__list_records", args: {}, output_file: "out.ndjson" } as any,
      createRegistry(["filesystem"]),
      createErrorStatusCatalog(),
    );

    // The package was extracted from the tool_id — the error (registry miss on
    // the extracted id, case-insensitive mock) names Filesystem, not "undefined".
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Package not found: Filesystem");
    expect(result.content[0].text).toContain("list_tool_packages");
  });
});
