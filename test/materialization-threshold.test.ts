import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

/**
 * Tests for the dual-threshold design:
 * - MATERIALIZATION_THRESHOLD_CHARS (20K) — when to save outputs to file
 * - DEFAULT_MAX_OUTPUT_CHARS (100K) — truncation + continuation chunk size
 */
describe("Materialization threshold decoupling", () => {
  let tempWorkspace: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rebel-mcp-threshold-"));
    originalEnv = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    process.env.REBEL_WORKSPACE_PATH = originalEnv;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

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

    const mockCatalog = {
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      getPackageStatus: vi.fn().mockReturnValue("ready"),
      getToolSchema: vi.fn().mockResolvedValue({ type: "object" }),
    } as unknown as Catalog;

    const mockValidator = {
      validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
    };

    return { mockRegistry, mockCatalog, mockValidator, mockClient };
  };

  it("output 50K chars with workspace -> materialized (above 20K threshold)", async () => {
    const text = "A".repeat(50_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    expect(responseData.result.status).toBe("materialized");
    expect(responseData.result.file_path).toMatch(/^\.rebel\/tool-outputs\//);
    expect(responseData.telemetry.materialized).toBe(true);
  });

  it("output 15K chars -> NOT materialized (below 20K threshold)", async () => {
    const text = "A".repeat(15_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    // Should be a normal in-context response — not materialized
    expect(responseData.result.status).not.toBe("materialized");
    expect(responseData.telemetry.materialized).toBeUndefined();
  });

  it("output exactly at 20K boundary -> NOT materialized (<=limit)", async () => {
    // materializeOutput adds frontmatter for text: ---\npackage_id: "pkg1"\ntool_id: "tool1"\n---\n
    // So the total file size = frontmatter + text. For materialization to NOT trigger,
    // we need fileContent.length <= 20_000. The frontmatter is fixed for these test values.
    const frontmatterLen = `---\npackage_id: "pkg1"\ntool_id: "tool1"\n---\n`.length;
    const text = "A".repeat(20_000 - frontmatterLen);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    expect(responseData.result.status).not.toBe("materialized");
  });

  it("explicit max_output_chars: 80000 with 50K output -> NOT materialized (50K < 80K)", async () => {
    const text = "A".repeat(50_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: 80000 },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    // 50K text + frontmatter < 80K explicit limit -> not materialized
    expect(responseData.result.status).not.toBe("materialized");
    expect(responseData.telemetry.materialized).toBeUndefined();
  });

  it("explicit max_output_chars: 30000 with 50K output -> materialized (50K > 30K)", async () => {
    const text = "A".repeat(50_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: 30000 },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);
    expect(responseData.result.status).toBe("materialized");
    expect(responseData.telemetry.materialized).toBe(true);
  });

  it("max_output_chars: null -> no materialization regardless of size", async () => {
    const text = "A".repeat(200_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: null },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseText = result.content[0].text;
    // With null + large output, the response may have a large output warning appended
    // after the JSON block. Parse just the JSON portion.
    const responseData = JSON.parse(responseText.split("\n\n---")[0]);
    // With null, no truncation and no materialization — raw unlimited output
    expect(responseData.result.status).not.toBe("materialized");
    expect(responseData.telemetry.materialized).toBeUndefined();
  });

  it("continuation handler still uses 100K chunk size (not 20K)", async () => {
    // First call: trigger truncation with no workspace so we get a result_id
    delete process.env.REBEL_WORKSPACE_PATH;

    const text = "A".repeat(250_000);
    const mockToolResult = { content: [{ type: "text", text }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const firstResult = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(firstResult.isError).toBe(false);
    const firstResponseText = firstResult.content[0].text;
    // Extract result_id from continuation hint
    const resultIdMatch = firstResponseText.match(/result_id: "([^"]+)"/);
    expect(resultIdMatch).toBeTruthy();
    const resultId = resultIdMatch![1];

    // Second call: continuation with offset 0 — should return a 100K chunk, not 20K
    const contResult = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, result_id: resultId, output_offset: 0 },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(contResult.isError).toBe(false);
    // Continuation response may have a "[To get the next chunk: ...]" hint appended
    const contJson = contResult.content[0].text.split("\n\n[")[0];
    const contData = JSON.parse(contJson);
    expect(contData.continuation).toBe(true);
    // The chunk length should be up to 100K (DEFAULT_MAX_OUTPUT_CHARS), not 20K
    expect(contData.length).toBeGreaterThan(20_000);
    expect(contData.length).toBeLessThanOrEqual(100_000);
  });

  // --- Serialized-output-size behavior with image passthrough ---
  // Image blocks are stripped from the JSON envelope and returned as separate MCP
  // content blocks. This prevents base64 data from inflating outputJson and avoids
  // safety-net clobbering.

  it("S2-T1: no workspace + large image content (1MB base64) -> image stripped from envelope and passed through separately", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    const base64Data = "A".repeat(1_000_000);
    const mockToolResult = {
      content: [{ type: "image", data: base64Data, mimeType: "image/png" }],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseText = result.content[0].text;

    // Leading JSON envelope must remain parseable (continuation hint is appended after \n\n[)
    const jsonPart = responseText.split("\n\n[")[0];
    const responseData = JSON.parse(jsonPart);

    expect(responseData.result.status).not.toBe("oversized_output");
    expect(JSON.stringify(responseData)).not.toContain(base64Data);
    expect(responseData.telemetry.output_truncated).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: "image",
      data: base64Data,
      mimeType: "image/png",
    });
  });

  it("S2-T2: no workspace + mixed text (110K) + image (1MB) -> text truncation works and image is passed through separately", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    const textContent = "x".repeat(110_000);
    const base64Data = "A".repeat(1_000_000);
    const mockToolResult = {
      content: [
        { type: "text", text: textContent },
        { type: "image", data: base64Data, mimeType: "image/png" },
      ],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseText = result.content[0].text;

    // Leading JSON envelope must remain parseable
    const jsonPart = responseText.split("\n\n[")[0];
    const responseData = JSON.parse(jsonPart);

    expect(responseData.result.status).not.toBe("oversized_output");
    expect(responseData.telemetry.output_truncated).toBe(true);
    expect(responseData.telemetry.result_id).toBeTruthy();
    expect(responseText).not.toContain("[Output too large for context");
    expect(JSON.stringify(responseData)).not.toContain(base64Data);
    expect(result.content[1]).toEqual({
      type: "image",
      data: base64Data,
      mimeType: "image/png",
    });

    // Continuation cache should include the full untruncated text output
    // while image data remains out-of-band.
    const contResult = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, result_id: responseData.telemetry.result_id, output_offset: 0 },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );
    expect(contResult.isError).toBe(false);
    const contJson = contResult.content[0].text.split("\n\n[")[0];
    const contData = JSON.parse(contJson);
    expect(contData.continuation).toBe(true);
    expect(contData.total_chars).toBeGreaterThan(100_000);
    expect(contData.total_chars).toBeLessThan(1_000_000);
  });

  it("S2-T3: normal-sized output below threshold -> safety net does NOT trigger", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    // Well-within budget: small text block, no large non-text content.
    const mockToolResult = { content: [{ type: "text", text: "hello world" }] };
    const { mockRegistry, mockCatalog, mockValidator } = createMocks(mockToolResult);

    const result = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(result.isError).toBe(false);
    const responseData = JSON.parse(result.content[0].text);

    // Normal path: no oversized_output placeholder, no truncation flags
    expect(responseData.result.status).not.toBe("oversized_output");
    expect(responseData.result).toEqual(mockToolResult);
    expect(responseData.telemetry.output_truncated).toBeUndefined();
    expect(responseData.telemetry.result_id).toBeUndefined();
  });
});
