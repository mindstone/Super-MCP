import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleUseTool } from "../src/handlers/useTool.js";
import { extractImageContentBlocks, materializeOutput } from "../src/handlers/materializeOutput.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";
import { getLogger } from "../src/logging.js";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("materializeOutput mixed-content behavior", () => {
  let tempWorkspace: string;
  let originalWorkspacePath: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rebel-mcp-mixed-test-"));
    originalWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    process.env.REBEL_WORKSPACE_PATH = originalWorkspacePath;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const createImageBlock = (data = TINY_PNG_BASE64, mimeType = "image/png") => ({
    type: "image" as const,
    data,
    mimeType,
  });
  const createResourceImageBlock = (
    blob = TINY_PNG_BASE64,
    mimeType = "image/png",
    uri = "file:///img.png",
  ) => ({
    type: "resource" as const,
    resource: { uri, mimeType, blob },
  });

  const runMaterialize = (toolResult: unknown, limit = 100_000) =>
    materializeOutput("pkg1", "tool1", { a: 1 }, toolResult, 100, tempWorkspace, limit);

  const createUseToolMocks = (toolResult: unknown) => {
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

    const toolSchema = { type: "object" };
    const getTool = (packageId: string, toolId: string) =>
      packageId === "pkg1" && toolId === "tool1"
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
    } as unknown as Catalog;

    const mockValidator = {
      validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
    };

    return { mockRegistry, mockCatalog, mockValidator };
  };

  it("MC-T1: Mixed text + image materialises correctly", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Saved to: path.png" },
        createImageBlock(),
      ],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();
    expect(result?.result.preserved_text).toBe("Saved to: path.png");
    expect(result?.result.image_files).toHaveLength(1);
    expect(result?.result.image_files[0]).toMatch(/\.png$/);

    const savedImagePath = path.join(tempWorkspace, result!.result.image_files[0]);
    const savedImage = await fs.readFile(savedImagePath);
    expect([...savedImage.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const archivePath = path.join(tempWorkspace, result!.result.archive_path as string);
    const archiveStat = await fs.stat(archivePath);
    expect(archiveStat.isFile()).toBe(true);
  });

  it("MC-T2: Image-only (no text) materialises", async () => {
    const toolResult = {
      content: [createImageBlock()],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();
    expect(result?.result.preserved_text).toBe("");
    expect(result?.result.image_files).toHaveLength(1);

    const savedImagePath = path.join(tempWorkspace, result!.result.image_files[0]);
    const savedImageStat = await fs.stat(savedImagePath);
    expect(savedImageStat.isFile()).toBe(true);

    const archivePath = path.join(tempWorkspace, result!.result.archive_path as string);
    const archiveStat = await fs.stat(archivePath);
    expect(archiveStat.isFile()).toBe(true);
  });

  it("MC-T3: Multiple images capped at MAX_SAVE_IMAGES", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const toolResult = {
      content: Array.from({ length: 7 }, () => createImageBlock()),
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();
    expect(result?.result.image_files).toHaveLength(5);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("count cap reached")),
    ).toBe(true);
  });

  it("MC-T4: Unsupported MIME type filtered", async () => {
    const toolResult = {
      content: [
        createImageBlock("PHN2Zy8+", "image/svg+xml"),
        createImageBlock(),
      ],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();
    expect(result?.result.image_files).toHaveLength(1);
    expect(result?.result.image_files[0]).toMatch(/\.png$/);
  });

  it("MC-T5: Error result with images — no images extracted", async () => {
    const toolResult = {
      content: [createImageBlock()],
      isError: true,
    };

    const result = await runMaterialize(toolResult);
    if (result) {
      expect(result.result.image_files).toBeUndefined();
    } else {
      expect(result).toBeNull();
    }

    const outputDir = path.join(tempWorkspace, ".rebel", "tool-outputs");
    const entries = await fs.readdir(outputDir).catch(() => [] as string[]);
    const imageFiles = entries.filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name));
    expect(imageFiles).toHaveLength(0);
  });

  it("MC-T6: Text-only content unchanged", async () => {
    const toolResult = {
      content: [{ type: "text", text: "A".repeat(150_000) }],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 100_000);
    expect(result).not.toBeNull();
    expect(result?.result.status).toBe("materialized");
    expect(result?.result.file_path).toMatch(/\.txt$/);
    expect(result?.result.preserved_text).toBeUndefined();
    expect(result?.result.image_files).toBeUndefined();
  });

  it("MC-T7: JSON envelope is valid", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Saved to: path.png" },
        createImageBlock(),
      ],
      isError: false,
    };

    const result = await runMaterialize(toolResult);
    expect(result).not.toBeNull();

    const reparsed = JSON.parse(JSON.stringify(result));
    expect(reparsed.result.status).toBe("materialized");
    expect(reparsed.result.preserved_text).toBe("Saved to: path.png");
    expect(Array.isArray(reparsed.result.image_files)).toBe(true);
  });

  it("MC-T8: Saved image has correct binary content", async () => {
    const expectedDecoded = Buffer.from(TINY_PNG_BASE64, "base64");
    const toolResult = {
      content: [createImageBlock()],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();

    const savedImagePath = path.join(tempWorkspace, result!.result.image_files[0]);
    const savedImage = await fs.readFile(savedImagePath);
    expect([...savedImage.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(savedImage.length).toBe(expectedDecoded.length);
  });

  it("MC-T9: Small text + image (text below threshold) still saves images", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "short text" },
        createImageBlock(),
      ],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 100_000);
    expect(result).not.toBeNull();
    expect(result?.result.preserved_text).toBe("short text");
    expect(result?.result.image_files).toHaveLength(1);
  });

  it("MC-T10: extractImageContentBlocks helper handles valid, invalid, oversized, and mixed inputs", () => {
    const valid = extractImageContentBlocks({
      content: [createImageBlock()],
      isError: false,
    });
    expect(valid).toHaveLength(1);
    expect(valid[0].mimeType).toBe("image/png");

    const invalid = extractImageContentBlocks({
      content: [
        { type: "image", data: 123, mimeType: "image/png" },
        createImageBlock("PHN2Zy8+", "image/svg+xml"),
      ],
      isError: false,
    });
    expect(invalid).toHaveLength(0);

    const sixMb = "A".repeat(6 * 1024 * 1024);
    const oversized = extractImageContentBlocks({
      content: [
        createImageBlock(sixMb, "image/png"),
        createImageBlock(sixMb, "image/jpeg"),
        createImageBlock(),
      ],
      isError: false,
    });
    expect(oversized).toHaveLength(1);
    expect(oversized[0].mimeType).toBe("image/png");

    const mixed = extractImageContentBlocks({
      content: [
        { type: "text", text: "hello" },
        createImageBlock(),
        createImageBlock("PHN2Zy8+", "image/svg+xml"),
      ],
      isError: false,
    });
    expect(mixed).toHaveLength(1);
    expect(mixed[0].mimeType).toBe("image/png");
  });

  it("MC-T11: useTool mixed materialisation returns JSON envelope + image blocks", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Saved to: path.png" },
        createImageBlock(),
      ],
      isError: false,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.content[0].type).toBe("text");
    const envelope = JSON.parse(response.content[0].text);
    expect(envelope.result.preserved_text).toBe("Saved to: path.png");
    expect(Array.isArray(envelope.result.image_files)).toBe(true);
    expect(envelope.result.image_files.length).toBeGreaterThan(0);
    expect(response.content[1]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

  it("MC-T12: useTool non-materialised path strips images from envelope", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "small text" },
        createImageBlock(),
      ],
      isError: false,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: null },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).not.toContain(TINY_PNG_BASE64);
    const envelope = JSON.parse(response.content[0].text.split("\n\n---")[0]);
    expect(JSON.stringify(envelope)).not.toContain(TINY_PNG_BASE64);
    expect(response.content[1]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

  it("MC-T13: useTool non-materialised path without workspace still passes through images", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    const toolResult = {
      content: [
        { type: "text", text: "small text" },
        createImageBlock(),
      ],
      isError: false,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.content[0].type).toBe("text");
    expect(response.content[1]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });

    const outputDir = path.join(tempWorkspace, ".rebel", "tool-outputs");
    const entries = await fs.readdir(outputDir).catch(() => [] as string[]);
    expect(entries).toHaveLength(0);
  });

  it("MC-T14: useTool error result does not passthrough image blocks", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "error output" },
        createImageBlock(),
      ],
      isError: true,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
  });

  it("MC-T15: Preserved text respects max_output_chars", async () => {
    const longText = "A".repeat(2_500);
    const toolResult = {
      content: [
        { type: "text", text: longText },
        createImageBlock(),
      ],
      isError: false,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: 1000 },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.content[0].type).toBe("text");

    const envelope = JSON.parse(response.content[0].text);
    const preservedText = envelope.result.preserved_text as string;
    expect(typeof preservedText).toBe("string");
    expect(preservedText).toContain("[Preserved text truncated to 1000 chars]");
    expect(preservedText.length).toBeLessThan(longText.length);
    expect(response.content[1]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

  it("MC-T16: Resource-wrapped image extracted by extractImageContentBlocks", () => {
    const extracted = extractImageContentBlocks({
      content: [createResourceImageBlock(TINY_PNG_BASE64, "image/png", "file:///img.png")],
      isError: false,
    });

    expect(extracted).toEqual([
      {
        type: "image",
        data: TINY_PNG_BASE64,
        mimeType: "image/png",
      },
    ]);
  });

  it("MC-T17: Resource-wrapped image materialises and saves binary file", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Saved to: path.png" },
        createResourceImageBlock(TINY_PNG_BASE64, "image/png", "file:///img.png"),
      ],
      isError: false,
    };

    const result = await runMaterialize(toolResult, 1);
    expect(result).not.toBeNull();
    expect(result?.result.preserved_text).toBe("Saved to: path.png");
    expect(result?.result.image_files).toHaveLength(1);

    const savedImagePath = path.join(tempWorkspace, result!.result.image_files[0]);
    const savedImage = await fs.readFile(savedImagePath);
    expect([...savedImage.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it("MC-T18: Resource with non-image mimeType NOT extracted as image", () => {
    const extracted = extractImageContentBlocks({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///doc.txt",
            mimeType: "text/plain",
            text: "hello",
          },
        },
      ],
      isError: false,
    });

    expect(extracted).toEqual([]);
  });

  it("MC-T19: Mixed direct image + resource image", () => {
    const extracted = extractImageContentBlocks({
      content: [
        createImageBlock(TINY_PNG_BASE64, "image/png"),
        createResourceImageBlock(TINY_PNG_BASE64, "image/png", "file:///img2.png"),
      ],
      isError: false,
    });

    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
    expect(extracted[1]).toEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

  it("MC-T20: image/jpg direct and resource blocks emit canonical image/jpeg", () => {
    const extracted = extractImageContentBlocks({
      content: [
        createImageBlock(TINY_PNG_BASE64, "IMAGE/JPG"),
        createResourceImageBlock(TINY_PNG_BASE64, "image/jpg", "file:///legacy.jpg"),
      ],
      isError: false,
    });

    expect(extracted).toEqual([
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/jpeg" },
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/jpeg" },
    ]);
  });

  it("MC-T21: image/jpg materializes with the canonical JPEG extension", async () => {
    const result = await runMaterialize({
      content: [createImageBlock(TINY_PNG_BASE64, "image/jpg")],
      isError: false,
    }, 1);

    expect(result?.result.image_files).toHaveLength(1);
    expect(result?.result.image_files[0]).toMatch(/\.jpg$/);
  });
});
