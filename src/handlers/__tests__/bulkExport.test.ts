import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBulkExport, BULK_EXPORT_MAX_PAGE_BYTES } from "../bulkExport.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  },
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

const PACKAGE_ID = "TestPackage";

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

function textResult(value: unknown) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    isError: false,
  };
}

function createRegistry(callTool: ReturnType<typeof vi.fn>): PackageRegistry {
  return {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "stdio",
      catalogId: "test-catalog",
    }),
    getClient: vi.fn().mockResolvedValue({ callTool }),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
}

function createCatalog(annotations?: ToolAnnotations): Catalog {
  return {
    getTool: vi.fn().mockResolvedValue({
      tool: {
        annotations,
        inputSchema: { type: "object", properties: {} },
      },
      schemaHash: "schema-hash",
    }),
  } as unknown as Catalog;
}

function parseSuccess(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    status: "complete" | "partial" | "failed";
    pages: number;
    pages_completed: number;
    lines: number;
    bytes: number;
    output_file: string;
    errors?: string[];
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bulk-export-test-"));
  await fs.mkdir(path.join(workspace, ".rebel", "exports"), { recursive: true });
  return workspace;
}

describe("handleBulkExport", () => {
  let previousWorkspacePath: string | undefined;
  let workspace: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    workspace = await createWorkspace();
    process.env.REBEL_WORKSPACE_PATH = workspace;
  });

  afterEach(async () => {
    if (previousWorkspacePath === undefined) {
      delete process.env.REBEL_WORKSPACE_PATH;
    } else {
      process.env.REBEL_WORKSPACE_PATH = previousWorkspacePath;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("uses read-only annotations before the verb fallback", async () => {
    const callTool = vi.fn().mockResolvedValue(textResult({ ok: true }));
    const result = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "create_report", args: {}, output_file: "annotated.ndjson" },
      createRegistry(callTool),
      createCatalog({ readOnlyHint: true }),
    );

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledWith("create_report", {});
    expect(parseSuccess(result).status).toBe("complete");
  });

  it("rejects destructive or explicitly non-read-only annotations", async () => {
    const destructive = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "list_records", args: {}, output_file: "destructive.ndjson" },
      createRegistry(vi.fn()),
      createCatalog({ readOnlyHint: true, destructiveHint: true }),
    );
    expect(destructive.isError).toBe(true);
    expect(destructive.content[0].text).toContain("annotated as destructive");

    const notReadOnly = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "list_records", args: {}, output_file: "not-read-only.ndjson" },
      createRegistry(vi.fn()),
      createCatalog({ readOnlyHint: false }),
    );
    expect(notReadOnly.isError).toBe(true);
    expect(notReadOnly.content[0].text).toContain("not annotated as read-only");
  });

  it("falls back to deterministic verbs only when annotations are absent and no longer trusts draft", async () => {
    const allowedCall = vi.fn().mockResolvedValue(textResult({ ok: true }));
    const allowed = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "fallback.ndjson" },
      createRegistry(allowedCall),
      createCatalog(undefined),
    );
    expect(allowed.isError).toBe(false);
    expect(allowedCall).toHaveBeenCalledTimes(1);

    const rejected = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "draft_report", args: {}, output_file: "draft.ndjson" },
      createRegistry(vi.fn()),
      createCatalog(undefined),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("appears to modify state");
  });

  it("rejects lexical traversal and symlink escapes", async () => {
    const lexical = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "../escape.ndjson" },
      createRegistry(vi.fn()),
      createCatalog({ readOnlyHint: true }),
    );
    expect(lexical.isError).toBe(true);
    expect(lexical.content[0].text).toContain("must stay within .rebel/exports");

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bulk-export-outside-"));
    try {
      await fs.symlink(outside, path.join(workspace, ".rebel", "exports", "linked-dir"));
      const linkedDir = await handleBulkExport(
        { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "linked-dir/out.ndjson" },
        createRegistry(vi.fn()),
        createCatalog({ readOnlyHint: true }),
      );
      expect(linkedDir.isError).toBe(true);
      expect(linkedDir.content[0].text).toContain("parent directory must stay within .rebel/exports");

      const outsideFile = path.join(outside, "target.ndjson");
      await fs.symlink(outsideFile, path.join(workspace, ".rebel", "exports", "target-link.ndjson"));
      const targetLink = await handleBulkExport(
        {
          package_id: PACKAGE_ID,
          tool_id: "search_records",
          args: {},
          output_file: "target-link.ndjson",
          if_exists: "overwrite",
        },
        createRegistry(vi.fn()),
        createCatalog({ readOnlyHint: true }),
      );
      expect(targetLink.isError).toBe(true);
      expect(targetLink.content[0].text).toContain("must not be a symlink");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("honors if_exists error versus overwrite", async () => {
    const outputPath = path.join(workspace, ".rebel", "exports", "existing.ndjson");
    await fs.writeFile(outputPath, "old\n", "utf8");

    const errorResult = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "existing.ndjson" },
      createRegistry(vi.fn()),
      createCatalog({ readOnlyHint: true }),
    );
    expect(errorResult.isError).toBe(true);
    expect(await fs.readFile(outputPath, "utf8")).toBe("old\n");

    const overwriteCall = vi.fn().mockResolvedValue(textResult({ items: [{ id: 1 }] }));
    const overwrite = await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: {},
        output_file: "existing.ndjson",
        items_path: "items",
        if_exists: "overwrite",
      },
      createRegistry(overwriteCall),
      createCatalog({ readOnlyHint: true }),
    );
    expect(overwrite.isError).toBe(false);
    expect(parseSuccess(overwrite).status).toBe("complete");
    expect(await fs.readFile(outputPath, "utf8")).toBe('{"id":1}\n');
  });

  it("reports complete, partial, and failed statuses", async () => {
    const completeCall = vi.fn().mockResolvedValue(textResult({ items: [{ id: "done" }] }));
    const complete = parseSuccess(await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: {},
        output_file: "complete.ndjson",
        items_path: "items",
      },
      createRegistry(completeCall),
      createCatalog({ readOnlyHint: true }),
    ));
    expect(complete).toEqual(expect.objectContaining({ status: "complete", pages: 1, pages_completed: 1, lines: 1 }));

    const partialCall = vi.fn()
      .mockResolvedValueOnce(textResult({ items: [{ id: "first" }], next: "page-2" }))
      .mockResolvedValueOnce(textResult("x".repeat(BULK_EXPORT_MAX_PAGE_BYTES + 1)));
    const partial = parseSuccess(await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: {},
        output_file: "partial.ndjson",
        items_path: "items",
        pagination: { token_field: "next", input_param: "pageToken" },
      },
      createRegistry(partialCall),
      createCatalog({ readOnlyHint: true }),
    ));
    expect(partial.status).toBe("partial");
    expect(partial.pages_completed).toBe(1);
    expect(partial.lines).toBe(1);
    expect(partial.errors?.[0]).toContain("raw output exceeded 10MB");

    const failedCall = vi.fn().mockResolvedValue(textResult("not json"));
    const failed = parseSuccess(await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: {},
        output_file: "failed.ndjson",
      },
      createRegistry(failedCall),
      createCatalog({ readOnlyHint: true }),
    ));
    expect(failed.status).toBe("failed");
    expect(failed.pages_completed).toBe(0);
    expect(failed.lines).toBe(0);
    expect(failed.errors?.[0]).toContain("Tool output is not JSON");
  });

  it("checks the raw page byte ceiling before parsing", async () => {
    const callTool = vi.fn().mockResolvedValue(textResult("x".repeat(BULK_EXPORT_MAX_PAGE_BYTES + 1)));
    const result = parseSuccess(await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "too-large.ndjson" },
      createRegistry(callTool),
      createCatalog({ readOnlyHint: true }),
    ));

    expect(result.status).toBe("failed");
    expect(result.pages_completed).toBe(0);
    expect(result.errors?.[0]).toContain("raw output exceeded 10MB");
  });
});
