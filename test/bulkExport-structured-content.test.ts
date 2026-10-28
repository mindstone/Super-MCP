import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleBulkExport, BULK_EXPORT_MAX_PAGE_BYTES } from "../src/handlers/bulkExport.js";
import type { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";
import type { BulkExportInput, BulkExportOutput } from "../src/types.js";

vi.mock("../src/security.js", () => ({
  getSecurityPolicy: () => ({
    isToolBlocked: () => ({ blocked: false }),
    isUserDisabled: () => false,
    isAdminDisabled: () => false,
  }),
}));

describe("bulk_export result payloads", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bulk-export-structured-"));
    vi.stubEnv("REBEL_WORKSPACE_PATH", workspace);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function createHarness(...results: unknown[]) {
    const callTool = vi.fn();
    for (const result of results) callTool.mockResolvedValueOnce(result);
    callTool.mockResolvedValue(results[results.length - 1]);
    const registry = {
      getPackage: () => ({ id: "example" }),
      callTool,
      notifyActivity: vi.fn(),
    } as unknown as PackageRegistry;
    const catalog = {
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      getPackageStatus: () => "ready",
      getTool: () => ({ tool: { annotations: { readOnlyHint: true } } }),
    } as unknown as Catalog;

    const run = async (options: Partial<BulkExportInput> = {}): Promise<BulkExportOutput> => {
      const result = await handleBulkExport({
        package_id: "example",
        tool_id: "list_attendees",
        args: { limit: 2 },
        output_file: "attendees.ndjson",
        items_path: "attendees",
        ...options,
      }, registry, catalog);
      return JSON.parse(result.content[0].text);
    };
    const readOutput = () => fs.readFile(path.join(workspace, ".rebel", "exports", "attendees.ndjson"), "utf8");
    return { run, callTool, readOutput };
  }

  it("exports structuredContent rows and uses its next-page token", async () => {
    const { run, callTool, readOutput } = createHarness(
      { content: [], structuredContent: { attendees: [{ id: 1 }, { id: 2 }], nextCursor: "page-2" } },
      { content: [], structuredContent: { attendees: [{ id: 3 }], nextCursor: null } },
    );

    expect(await run({ pagination: { token_field: "nextCursor", input_param: "cursor" } }))
      .toMatchObject({ status: "complete", pages: 2, lines: 3 });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(2, "example", "list_attendees", { limit: 2, cursor: "page-2" });
    expect(await readOutput()).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  }, 15_000);

  it("joins text JSON blocks and keeps text precedence over structuredContent", async () => {
    const { run, callTool, readOutput } = createHarness({
      content: [
        { type: "text", text: '{"attendees":[' },
        { type: "text", text: '{"id":1},{"id":2}]}' },
      ],
      structuredContent: { attendees: [{ id: 99 }] },
    });

    expect(await run()).toMatchObject({ status: "complete", pages: 1, lines: 2 });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await readOutput()).toBe('{"id":1}\n{"id":2}\n');
  });

  it("exports structuredContent when the text is prose", async () => {
    const { run, readOutput } = createHarness({
      content: [{ type: "text", text: "Found one attendee." }],
      structuredContent: { attendees: [{ id: 1 }] },
    });

    expect(await run()).toMatchObject({ status: "complete", pages: 1, lines: 1 });
    expect(await readOutput()).toBe('{"id":1}\n');
  });

  it("names missing text and structuredContent and does not retry", async () => {
    const { run, callTool } = createHarness({ content: [] });

    const result = await run();
    expect(result).toMatchObject({ status: "failed", pages: 0, lines: 0 });
    expect(result.errors?.join(" ")).toMatch(/^Page 1: .*no text.*structuredContent/i);
    expect(callTool).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("retries isError results even when structuredContent has rows", async () => {
    const { run, callTool } = createHarness({
      content: [{ type: "text", text: "Temporary connector failure" }],
      structuredContent: { attendees: [{ id: 1 }] },
      isError: true,
    });

    expect(await run()).toMatchObject({
      status: "failed", pages: 0, lines: 0, errors: ["Page 1: Temporary connector failure"],
    });
    expect(callTool).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("applies the 10MB page cap to the serialized structuredContent", async () => {
    const { run, callTool } = createHarness({
      content: [],
      structuredContent: { attendees: [{ value: "é".repeat(BULK_EXPORT_MAX_PAGE_BYTES / 2) }] },
    });

    const result = await run();
    expect(result).toMatchObject({ status: "failed", pages: 0, lines: 0 });
    expect(result.errors?.join(" ")).toContain("exceeded 10MB");
    expect(callTool).toHaveBeenCalledTimes(1);
  }, 15_000);

  it.each([null, [], "invalid", 42])("rejects non-object structuredContent (%j)", async (structuredContent) => {
    const { run, callTool } = createHarness({
      content: [{ type: "text", text: "Found attendees." }],
      structuredContent,
    });

    expect(await run()).toMatchObject({ status: "failed", pages: 0, lines: 0 });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
