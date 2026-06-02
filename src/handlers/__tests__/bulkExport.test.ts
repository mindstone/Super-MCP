import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBulkExport, BULK_EXPORT_MAX_PAGE_BYTES } from "../bulkExport.js";
import { Catalog } from "../../catalog.js";
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

function createCatalog(annotations?: ToolAnnotations, status: "ready" | "auth_required" | "error" | "unknown" = "ready", error?: string): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue(status),
    getPackageError: vi.fn().mockReturnValue(error),
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
    vi.useRealTimers();
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

  it("loads cold Catalog annotations before the verb fallback", async () => {
    const callTool = vi.fn().mockResolvedValue(textResult({ ok: true }));
    const client = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: "create_report",
          description: "A read-only report fetch despite the create verb",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ]),
      callTool,
    };
    const registry = {
      getPackage: vi.fn().mockReturnValue({
        id: PACKAGE_ID,
        name: PACKAGE_ID,
        transport: "stdio",
        catalogId: "test-catalog",
      }),
      getClient: vi.fn().mockResolvedValue(client),
      notifyActivity: vi.fn(),
    } as unknown as PackageRegistry;
    const catalog = new Catalog(registry);

    const result = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "create_report", args: {}, output_file: "cold-catalog.ndjson" },
      registry,
      catalog,
    );

    expect(result.isError).toBe(false);
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("create_report", {});
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

    const openWorldOnly = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "list_records", args: {}, output_file: "open-world.ndjson" },
      createRegistry(vi.fn()),
      createCatalog({ openWorldHint: true }),
    );
    expect(openWorldOnly.isError).toBe(true);
    expect(openWorldOnly.content[0].text).toContain("has annotations but no readOnlyHint");
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

  it("rejects read-plus-side-effect tool names in verb fallback", async () => {
    for (const toolId of ["get_and_delete", "list_and_mark_read", "search_and_archive"]) {
      const result = await handleBulkExport(
        { package_id: PACKAGE_ID, tool_id: toolId, args: {}, output_file: `${toolId}.ndjson` },
        createRegistry(vi.fn()),
        createCatalog(undefined),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("appears to modify state");
    }
  });

  it("surfaces package auth and catalog errors before read-only checks or tool calls", async () => {
    const authCall = vi.fn();
    const authCatalog = createCatalog(undefined, "auth_required");
    const authRequired = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "auth.ndjson" },
      createRegistry(authCall),
      authCatalog,
    );
    expect(authRequired.isError).toBe(true);
    expect(authRequired.content[0].text).toContain("requires authentication");
    expect(authCatalog.getTool).not.toHaveBeenCalled();
    expect(authCall).not.toHaveBeenCalled();

    const errorCall = vi.fn();
    const errorCatalog = createCatalog(undefined, "error", "startup failed");
    const packageError = await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "catalog-error.ndjson" },
      createRegistry(errorCall),
      errorCatalog,
    );
    expect(packageError.isError).toBe(true);
    expect(packageError.content[0].text).toContain("is unavailable: startup failed");
    expect(errorCatalog.getTool).not.toHaveBeenCalled();
    expect(errorCall).not.toHaveBeenCalled();
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
      const targetLinkPath = path.join(workspace, ".rebel", "exports", "target-link.ndjson");
      await fs.symlink(outsideFile, targetLinkPath);
      const overwriteCall = vi.fn().mockResolvedValue(textResult({ items: [{ id: 1 }] }));
      const targetLink = await handleBulkExport(
        {
          package_id: PACKAGE_ID,
          tool_id: "search_records",
          args: {},
          output_file: "target-link.ndjson",
          items_path: "items",
          if_exists: "overwrite",
        },
        createRegistry(overwriteCall),
        createCatalog({ readOnlyHint: true }),
      );
      expect(targetLink.isError).toBe(false);
      expect((await fs.lstat(targetLinkPath)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(targetLinkPath, "utf8")).toBe('{"id":1}\n');
      await expect(fs.access(outsideFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an export root symlink that resolves outside the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bulk-export-root-outside-"));
    try {
      await fs.rm(path.join(workspace, ".rebel", "exports"), { recursive: true, force: true });
      await fs.symlink(outside, path.join(workspace, ".rebel", "exports"));

      const result = await handleBulkExport(
        { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "root-link.ndjson" },
        createRegistry(vi.fn()),
        createCatalog({ readOnlyHint: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(".rebel/exports must stay within REBEL_WORKSPACE_PATH");
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
    expect(complete).toEqual(expect.objectContaining({ status: "complete", pages: 1, lines: 1 }));
    expect(complete).not.toHaveProperty("pages_completed");

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
    expect(partial.pages).toBe(1);
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
    expect(failed.pages).toBe(0);
    expect(failed.lines).toBe(0);
    expect(failed.errors?.[0]).toContain("Tool output is not JSON");
  });

  it("reports partial when max_pages stops before pagination completes", async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(textResult({ items: [{ id: 1 }], next: "tok-2" }))
      .mockResolvedValueOnce(textResult({ items: [{ id: 2 }], next: "tok-3" }));

    const result = parseSuccess(await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: {},
        output_file: "max-pages.ndjson",
        items_path: "items",
        max_pages: 2,
        pagination: { token_field: "next", input_param: "pageToken" },
      },
      createRegistry(callTool),
      createCatalog({ readOnlyHint: true }),
    ));

    expect(result.status).toBe("partial");
    expect(result.pages).toBe(2);
    expect(result.lines).toBe(2);
    expect(result.errors?.[0]).toContain("Reached max_pages (2) before pagination completed");
  });

  it("truncates downstream error payloads before storing them in the summary", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "x".repeat(2_000) }],
      isError: true,
    });

    const result = parseSuccess(await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "truncated-error.ndjson" },
      createRegistry(callTool),
      createCatalog({ readOnlyHint: true }),
    ));

    expect(result.status).toBe("failed");
    expect(result.errors?.[0].length).toBeLessThan(560);
    expect(result.errors?.[0]).toContain("…[truncated]");
    expect(result.errors?.[0]).not.toContain("x".repeat(1_000));
  }, 12_000);

  it("blocks self-recursion into SuperMCP meta tools before any tool call", async () => {
    const callTool = vi.fn();
    for (const metaTool of ["bulk_export", "use_tool", "search_tools", "authenticate"]) {
      const result = await handleBulkExport(
        { package_id: PACKAGE_ID, tool_id: metaTool, args: {}, output_file: `recursion-${metaTool}.ndjson` },
        createRegistry(callTool),
        createCatalog({ readOnlyHint: true }),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("cannot call SuperMCP tool");
    }
    // The guard must fire during input parsing, before any downstream call.
    expect(callTool).not.toHaveBeenCalled();
  });

  it("follows pagination tokens across multiple pages and stops when the token clears", async () => {
    const pagedCall = vi.fn()
      .mockResolvedValueOnce(textResult({ items: [{ id: 1 }, { id: 2 }], next: "tok-2" }))
      .mockResolvedValueOnce(textResult({ items: [{ id: 3 }], next: "tok-3" }))
      .mockResolvedValueOnce(textResult({ items: [{ id: 4 }] }));

    const result = await handleBulkExport(
      {
        package_id: PACKAGE_ID,
        tool_id: "search_records",
        args: { q: "x" },
        output_file: "paged.ndjson",
        items_path: "items",
        pagination: { token_field: "next", input_param: "pageToken" },
      },
      createRegistry(pagedCall),
      createCatalog({ readOnlyHint: true }),
    );

    const summary = parseSuccess(result);
    expect(result.isError).toBe(false);
    expect(summary.status).toBe("complete");
    expect(summary.pages).toBe(3);
    expect(summary.lines).toBe(4);
    expect(pagedCall).toHaveBeenCalledTimes(3);
    // Token from each page is fed back into the next call via input_param.
    expect(pagedCall).toHaveBeenNthCalledWith(2, "search_records", { q: "x", pageToken: "tok-2" });
    expect(pagedCall).toHaveBeenNthCalledWith(3, "search_records", { q: "x", pageToken: "tok-3" });

    const outputPath = path.join(workspace, ".rebel", "exports", "paged.ndjson");
    const written = await fs.readFile(outputPath, "utf8");
    expect(written).toBe('{"id":1}\n{"id":2}\n{"id":3}\n{"id":4}\n');
  });

  it("checks the raw page byte ceiling before parsing", async () => {
    const callTool = vi.fn().mockResolvedValue(textResult("x".repeat(BULK_EXPORT_MAX_PAGE_BYTES + 1)));
    const result = parseSuccess(await handleBulkExport(
      { package_id: PACKAGE_ID, tool_id: "search_records", args: {}, output_file: "too-large.ndjson" },
      createRegistry(callTool),
      createCatalog({ readOnlyHint: true }),
    ));

    expect(result.status).toBe("failed");
    expect(result.pages).toBe(0);
    expect(result.errors?.[0]).toContain("raw output exceeded 10MB");
  });
});
