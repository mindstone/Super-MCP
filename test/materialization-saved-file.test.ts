import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleUseTool } from "../src/handlers/useTool.js";
import { materializeOutput } from "../src/handlers/materializeOutput.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

// What the AI is pointed at must hold what the message says it holds: text for
// text beside images, no base64 for error results, and the structured data when
// the inline reply would otherwise be replaced by the oversized placeholder.

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const FRONTMATTER = '---\npackage_id: "pkg1"\ntool_id: "tool1"\n---\n';
// Base64 of made-up bytes standing in for a BMP image.
const BMP_BLOB_MARKER = "Qk1NQURFVVBCTVBQQVlMT0FETUFSS0VSRk9SVEVTVFM=";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function linesOfText(totalChars: number, tail: string): string {
  const line = "Quarterly planning notes for the made-up Acme team, line of text.\n";
  const body = line.repeat(Math.ceil((totalChars - tail.length) / line.length)).slice(0, totalChars - tail.length);
  return body + tail;
}

function createUseToolMocks(toolResult: unknown) {
  const mockClient = { callTool: vi.fn().mockResolvedValue(toolResult) };
  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const toolSchema = { type: "object" };
  const getTool = (packageId: string, toolId: string) =>
    packageId === "pkg1" && toolId === "tool1"
      ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
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
  } as unknown as Catalog;
  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };
  return { mockRegistry, mockCatalog, mockValidator };
}

async function callUseTool(toolResult: unknown, extra: Record<string, unknown> = {}) {
  const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);
  return handleUseTool(
    { package_id: "pkg1", tool_id: "tool1", args: {}, ...extra },
    mockRegistry,
    mockCatalog,
    mockValidator,
  ) as Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean; _meta?: any; structuredContent?: unknown }>;
}

function envelopeOf(text: string): any {
  const blank = text.indexOf("\n\n[");
  return JSON.parse(blank >= 0 ? text.slice(0, blank) : text);
}

function savedPathsIn(message: string): string[] {
  return [...message.matchAll(/\.rebel\/tool-outputs\/[^\s:]+/g)].map((match) => match[0].replace(/[.,;)]+$/, ""));
}

describe("Super MCP saved file holds what the message says", () => {
  let tempWorkspace: string;
  let originalWorkspacePath: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rebel-mcp-saved-file-"));
    originalWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    if (originalWorkspacePath === undefined) delete process.env.REBEL_WORKSPACE_PATH;
    else process.env.REBEL_WORKSPACE_PATH = originalWorkspacePath;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("saves large text beside an image as its own text file and points the AI at it", async () => {
    const tail = "\nTAIL_MARKER_TEXT_BESIDE_IMAGE_300000";
    const text = linesOfText(300_000, tail);
    const response = await callUseTool({
      content: [{ type: "text", text }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: false,
    });

    expect(response.isError).toBe(false);
    const replyText = response.content[0].text!;
    expect(replyText.length).toBeLessThan(10_000);
    const envelope = envelopeOf(replyText);
    const result = envelope.result;
    expect(result.status).toBe("materialized");
    expect(result.preserved_text).toBeUndefined();
    expect(typeof result.preview).toBe("string");
    expect(result.preview.length).toBeLessThanOrEqual(2_048);

    expect(typeof result.text_file_path).toBe("string");
    expect(result.text_file_path).toMatch(/^\.rebel\/tool-outputs\/.+\.txt$/);
    expect(result.message).toContain(result.text_file_path);
    const textFile = await fs.readFile(path.join(tempWorkspace, result.text_file_path), "utf8");
    expect(textFile.endsWith(tail)).toBe(true);
    expect(textFile).not.toContain(TINY_PNG_BASE64);

    expect(result.file_path).toMatch(/\.json$/);
    expect(result.archive_path).toBe(result.file_path);
    expect(response._meta.materialization.filePath).toBe(result.file_path);
    expect(response._meta.materialization.textFilePath).toBe(result.text_file_path);

    expect(result.image_files).toHaveLength(1);
    expect(response._meta.materialization.imageFiles).toEqual(result.image_files);
    const image = await fs.readFile(path.join(tempWorkspace, result.image_files[0]));
    expect([...image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(response.content[1]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
  });

  it("keeps small text beside an image inline, with no text file", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "Chart of made-up monthly totals" }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: false,
    });

    const result = envelopeOf(response.content[0].text!).result;
    expect(result.status).toBe("materialized");
    expect(result.preserved_text).toBe("Chart of made-up monthly totals");
    expect(result.preview).toBe("Chart of made-up monthly totals");
    expect(result.text_file_path).toBeUndefined();
    expect(response._meta.materialization.textFilePath).toBeUndefined();
    expect(result.image_files).toHaveLength(1);
    const outputs = await fs.readdir(path.join(tempWorkspace, ".rebel", "tool-outputs"));
    expect(outputs.filter((name) => name.endsWith(".txt"))).toEqual([]);
  });

  it("keeps base64 out of the saved file and the reply for an error with an image (workspace)", async () => {
    const errorText = `Rendering failed for the made-up report.\n${"detail line of the failure\n".repeat(1_200)}END_OF_ERROR`;
    const response = await callUseTool({
      content: [{ type: "text", text: errorText }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: true,
    });

    expect(response.isError).toBe(true);
    const replyText = response.content[0].text!;
    expect(replyText).not.toContain(TINY_PNG_BASE64);
    const result = envelopeOf(replyText).result;
    expect(result.status).toBe("materialized");
    const named = savedPathsIn(result.message);
    expect(named.length).toBeGreaterThan(0);
    for (const relativePath of named) {
      const saved = await fs.readFile(path.join(tempWorkspace, relativePath), "utf8");
      expect(saved).not.toContain(TINY_PNG_BASE64);
      expect(saved).toContain("END_OF_ERROR");
    }
  });

  it("keeps base64 out of the reply for a small error with an image (workspace)", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "Rendering failed." }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].text).not.toContain(TINY_PNG_BASE64);
    expect(response.content[0].text).toContain("Rendering failed.");
  });

  it("keeps base64 out of the reply for an error with an image when nothing can be saved", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;
    const errorText = `Rendering failed for the made-up report.\n${"detail line of the failure\n".repeat(1_200)}`;
    const response = await callUseTool({
      content: [{ type: "text", text: errorText }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].text).not.toContain(TINY_PNG_BASE64);
    expect(response.content[0].text).toContain("Rendering failed for the made-up report.");
  });

  it("saves short text beside large structured data instead of replacing it with the placeholder", async () => {
    const structuredContent = { rows: Array.from({ length: 30_000 }, (_, i) => ({ id: i, label: "made-up row" })), tail: "STRUCTURED_TAIL_MARKER" };
    const toolResult = { content: [{ type: "text", text: "OK" }], structuredContent };
    const response = await callUseTool(toolResult);

    expect(response.isError).toBe(false);
    const result = envelopeOf(response.content[0].text!).result;
    expect(result.status).toBe("materialized");
    expect(response._meta.materialization.status).toBe("materialized");
    expect(response._meta.materialization.filePath).toBe(result.file_path);
    const saved = JSON.parse(await fs.readFile(path.join(tempWorkspace, result.file_path), "utf8"));
    expect(saved.content).toEqual([{ type: "text", text: "OK" }]);
    expect(saved.structuredContent).toEqual(structuredContent);
    // Outer structuredContent passthrough is unchanged.
    expect(response.structuredContent).toEqual(structuredContent);
  });

  it("cuts the text preview on a code point boundary", async () => {
    const before = 2_047 - FRONTMATTER.length;
    const text = "a".repeat(before) + "\u{1F600}".repeat(15_000);
    const result = await materializeOutput("pkg1", "tool1", {}, { content: [{ type: "text", text }] }, 1, tempWorkspace, 20_000);

    expect(result).not.toBeNull();
    const preview = result!.result.preview as string;
    expect(preview.startsWith(FRONTMATTER)).toBe(true);
    expect(LONE_SURROGATE.test(preview)).toBe(false);
    expect(result!.result.preview_truncated).toBe(true);
  });

  it("cuts the preview of text beside an image on a code point boundary", async () => {
    const before = 2_047 - FRONTMATTER.length;
    const text = "a".repeat(before) + "\u{1F600}".repeat(15_000);
    const result = await materializeOutput("pkg1", "tool1", {}, {
      content: [{ type: "text", text }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    }, 1, tempWorkspace, 20_000);

    expect(result).not.toBeNull();
    expect(LONE_SURROGATE.test(result!.result.preview as string)).toBe(false);
  });

  it("saves text beside an image by its own length, not by how small its file form is", async () => {
    // 300,011 chars that pretty-print to a 16-char JSON file.
    const text = " ".repeat(300_000) + '{"ok":true}';
    const response = await callUseTool({
      content: [{ type: "text", text }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: false,
    });

    const replyText = response.content[0].text!;
    expect(replyText.length).toBeLessThan(10_000);
    const result = envelopeOf(replyText).result;
    expect(result.preserved_text).toBeUndefined();
    expect(typeof result.text_file_path).toBe("string");
    expect(response._meta.materialization.textFilePath).toBe(result.text_file_path);
    const saved = JSON.parse(await fs.readFile(path.join(tempWorkspace, result.text_file_path), "utf8"));
    expect(saved).toEqual({ ok: true });
  });

  it("refuses to write a text file beside an image that is over the 20,000,000-char ceiling", async () => {
    // 8,000,001 chars that pretty-print to 20,000,002.
    const text = JSON.stringify(Array(4_000_000).fill(0));
    const result = await materializeOutput("pkg1", "tool1", {}, {
      content: [{ type: "text", text }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    }, 1, tempWorkspace, 20_000);

    expect(result).toBeNull();
    const outputs = await fs.readdir(path.join(tempWorkspace, ".rebel", "tool-outputs")).catch(() => [] as string[]);
    expect(outputs).toEqual([]);
  });

  it("keeps an unsupported-type image resource out of the saved file and the reply for an error (workspace)", async () => {
    const errorText = `Rendering failed for the made-up report.\n${"detail line of the failure\n".repeat(1_200)}END_OF_ERROR`;
    const response = await callUseTool({
      content: [
        { type: "text", text: errorText },
        { type: "resource", resource: { uri: "file:///chart.bmp", mimeType: "image/bmp", blob: BMP_BLOB_MARKER } },
      ],
      isError: true,
    });

    expect(response.isError).toBe(true);
    const replyText = response.content[0].text!;
    expect(replyText).not.toContain(BMP_BLOB_MARKER);
    const result = envelopeOf(replyText).result;
    expect(result.status).toBe("materialized");
    const named = savedPathsIn(result.message);
    expect(named.length).toBeGreaterThan(0);
    for (const relativePath of named) {
      const saved = await fs.readFile(path.join(tempWorkspace, relativePath), "utf8");
      expect(saved).not.toContain(BMP_BLOB_MARKER);
      expect(saved).toContain("END_OF_ERROR");
    }
  });

  it("keeps an unsupported-type image resource out of the reply for an error when nothing can be saved", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;
    const response = await callUseTool({
      content: [
        { type: "text", text: "Rendering failed for the made-up report." },
        { type: "resource", resource: { uri: "file:///chart.bmp", mimeType: "image/bmp", blob: BMP_BLOB_MARKER } },
      ],
      isError: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].text).not.toContain(BMP_BLOB_MARKER);
    expect(response.content[0].text).toContain("Rendering failed for the made-up report.");
  });

  it("keeps a non-image resource in an error result", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;
    const response = await callUseTool({
      content: [
        { type: "text", text: "Export failed." },
        { type: "resource", resource: { uri: "file:///log.txt", mimeType: "text/plain", text: "MADE_UP_LOG_LINE" } },
      ],
      isError: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("MADE_UP_LOG_LINE");
  });

  it("removes the finished text file when the archive beside it cannot be written", async () => {
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(".json") && !String(to).includes("_text")) {
        throw Object.assign(new Error("made-up disk failure"), { code: "EIO" });
      }
      return realRename(from, to);
    });
    const result = await materializeOutput("pkg1", "tool1", {}, {
      content: [{ type: "text", text: "x\n".repeat(20_000) }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    }, 1, tempWorkspace, 20_000);

    expect(result).toBeNull();
    const outputs = await fs.readdir(path.join(tempWorkspace, ".rebel", "tool-outputs"));
    expect(outputs.filter((name) => name.includes("_text"))).toEqual([]);
    expect(outputs.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("names no host tool that may not exist in the saved-file message", async () => {
    const textOnly = await materializeOutput("pkg1", "tool1", {}, { content: [{ type: "text", text: "x\n".repeat(20_000) }] }, 1, tempWorkspace, 20_000);
    const withImage = await materializeOutput("pkg1", "tool1", {}, {
      content: [{ type: "text", text: "x\n".repeat(20_000) }, { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    }, 1, tempWorkspace, 20_000);

    for (const output of [textOnly, withImage]) {
      const message = output!.result.message as string;
      expect(message).not.toMatch(/grep/i);
      expect(message).toMatch(/offset/);
      expect(message).toMatch(/search/i);
    }
  });
});
