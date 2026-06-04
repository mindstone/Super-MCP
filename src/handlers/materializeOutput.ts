import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { UseToolOutput } from "../types.js";
import { getLogger } from "../logging.js";

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const MAX_SAVE_IMAGES = 5;
const MAX_SAVE_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB total base64
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const SIZE_CAP_CHARS = 20_000_000; // 20MB

interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

interface SavedImageFile {
  relativePath: string;
  mimeType: string;
}

interface DecomposedContent {
  data: unknown;
  fullContent: unknown;
  textParts: string[];
  imageBlocks: ImageContentBlock[];
  isStringText: boolean;
  isError: boolean;
}

const logger = getLogger();

function sanitizeForFilename(str: string): string {
  return str.replace(/[\\/:*?"<>|\n\r]/g, '_').replace(/\.\.+/g, '_').slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathWithinTarget(filePath: string, targetDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedTarget = path.resolve(targetDir);
  return resolvedPath.startsWith(resolvedTarget + path.sep) || resolvedPath === resolvedTarget;
}

/**
 * Defense-in-depth symlink-traversal guard. Call AFTER `fs.mkdir(targetDir)`:
 * resolves symlinks (`fs.realpath`) on both the tool-outputs dir and the workspace,
 * and verifies the real target is still inside the real workspace. The lexical
 * `isPathWithinTarget` check does NOT follow symlinks, so a symlinked
 * `.rebel/tool-outputs` (or `.rebel`) pointing outside the workspace would slip past
 * it; this catches that and the caller writes through the returned real dir.
 * Returns the realpath'd target dir, or null to abort materialization.
 *
 * Restores super-mcp 02f703dc ("realpath symlink defense"), which was lost when a
 * submodule-pin rollback orphaned it (see Rebel postmortem
 * 260603_supermcp_bulk_export_submodule_pin_orphan).
 */
async function resolveRealTargetWithinWorkspace(
  targetDir: string,
  workspacePath: string,
  ctx: { package_id: string; tool_id: string },
): Promise<string | null> {
  let realTargetDir: string;
  let realWorkspace: string;
  try {
    realTargetDir = await fs.realpath(targetDir);
    realWorkspace = await fs.realpath(workspacePath);
  } catch (err: any) {
    logger.warn("realpath failed for tool-outputs dir; aborting materialization", {
      targetDir,
      workspacePath,
      package_id: ctx.package_id,
      tool_id: ctx.tool_id,
      error: err?.message ?? String(err),
    });
    return null;
  }
  if (realTargetDir !== realWorkspace && !realTargetDir.startsWith(realWorkspace + path.sep)) {
    logger.error("Path traversal via symlink detected, aborting materialization", {
      realTargetDir,
      realWorkspace,
      package_id: ctx.package_id,
      tool_id: ctx.tool_id,
    });
    return null;
  }
  return realTargetDir;
}

function buildFilenamePrefix(package_id: string, tool_id: string): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const hash = crypto.randomBytes(4).toString("hex");
  const safePackageId = sanitizeForFilename(package_id);
  const safeToolId = sanitizeForFilename(tool_id);
  return `${yy}${mm}${dd}_${HH}${MM}_${safePackageId}_${safeToolId}_${hash}`;
}

export function extractImageContentBlocks(toolResult: unknown): ImageContentBlock[] {
  if (!isRecord(toolResult) || !Array.isArray(toolResult.content) || toolResult.isError === true) {
    return [];
  }

  const imageBlocks: ImageContentBlock[] = [];
  let totalBase64Bytes = 0;
  let droppedForCount = 0;

  for (const block of toolResult.content) {
    if (!isRecord(block)) {
      continue;
    }

    if (block.type === "image") {
      if (typeof block.data !== "string" || !block.data || typeof block.mimeType !== "string") {
        continue;
      }

      if (imageBlocks.length >= MAX_SAVE_IMAGES) {
        droppedForCount += 1;
        continue;
      }

      const normalizedMimeType = block.mimeType.toLowerCase();
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
        continue;
      }

      const nextTotalBytes = totalBase64Bytes + block.data.length;
      if (nextTotalBytes > MAX_SAVE_IMAGE_BYTES) {
        logger.warn("Image extraction size cap reached; dropping remaining images", {
          max_save_image_bytes: MAX_SAVE_IMAGE_BYTES,
          extracted_images: imageBlocks.length,
        });
        break;
      }

      imageBlocks.push({
        type: "image",
        data: block.data,
        mimeType: normalizedMimeType,
      });
      totalBase64Bytes = nextTotalBytes;
      continue;
    }

    // MCP embedded resource with image blob
    if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource as Record<string, unknown>;
      if (
        typeof resource.blob === "string" && resource.blob &&
        typeof resource.mimeType === "string" &&
        SUPPORTED_IMAGE_MIME_TYPES.has(resource.mimeType.toLowerCase())
      ) {
        if (imageBlocks.length >= MAX_SAVE_IMAGES) {
          droppedForCount += 1;
          continue;
        }
        const nextTotalBytes = totalBase64Bytes + resource.blob.length;
        if (nextTotalBytes > MAX_SAVE_IMAGE_BYTES) {
          logger.warn("Image extraction size cap reached; dropping remaining images", {
            max_save_image_bytes: MAX_SAVE_IMAGE_BYTES,
            extracted_images: imageBlocks.length,
          });
          break;
        }
        imageBlocks.push({
          type: "image",
          data: resource.blob,
          mimeType: resource.mimeType.toLowerCase(),
        });
        totalBase64Bytes = nextTotalBytes;
      }
    }
  }

  if (droppedForCount > 0) {
    logger.warn("Image extraction count cap reached; dropping additional images", {
      max_save_images: MAX_SAVE_IMAGES,
      dropped_images: droppedForCount,
    });
  }

  return imageBlocks;
}

function extractDataForMaterialization(toolResult: unknown): DecomposedContent {
  let isError = false;
  if (isRecord(toolResult)) {
    if (toolResult.isError) isError = true;
    if (Array.isArray(toolResult.content)) {
      if (
        toolResult.content.length === 1 &&
        isRecord(toolResult.content[0]) &&
        toolResult.content[0].type === "text" &&
        typeof toolResult.content[0].text === "string"
      ) {
        return {
          data: toolResult.content[0].text,
          fullContent: toolResult.content,
          textParts: [toolResult.content[0].text],
          imageBlocks: [],
          isStringText: true,
          isError,
        };
      }

      const textParts: string[] = [];
      for (const block of toolResult.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }

      return {
        data: toolResult.content,
        fullContent: toolResult.content,
        textParts,
        imageBlocks: extractImageContentBlocks(toolResult),
        isStringText: false,
        isError,
      };
    }
  }
  return {
    data: toolResult,
    fullContent: toolResult,
    textParts: [],
    imageBlocks: [],
    isStringText: false,
    isError,
  };
}

async function saveImageFiles(
  imageBlocks: ImageContentBlock[],
  targetDir: string,
  filenamePrefix: string,
): Promise<SavedImageFile[]> {
  const savedImages: SavedImageFile[] = [];
  let totalBase64Bytes = 0;

  for (let i = 0; i < imageBlocks.length; i += 1) {
    if (savedImages.length >= MAX_SAVE_IMAGES) {
      logger.warn("Image save count cap reached; dropping additional images", {
        max_save_images: MAX_SAVE_IMAGES,
      });
      break;
    }

    const imageBlock = imageBlocks[i];
    const normalizedMimeType = imageBlock.mimeType.toLowerCase();
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
      continue;
    }

    const nextTotalBytes = totalBase64Bytes + imageBlock.data.length;
    if (nextTotalBytes > MAX_SAVE_IMAGE_BYTES) {
      logger.warn("Image save size cap reached; dropping remaining images", {
        max_save_image_bytes: MAX_SAVE_IMAGE_BYTES,
        saved_images: savedImages.length,
      });
      break;
    }

    const ext = MIME_TO_EXT[normalizedMimeType];
    if (!ext) {
      continue;
    }

    const filename = `${filenamePrefix}_img${String(savedImages.length + 1).padStart(2, "0")}${ext}`;
    const filePath = path.join(targetDir, filename);
    if (!isPathWithinTarget(filePath, targetDir)) {
      logger.warn("Skipping image save due to path traversal check", { file_path: filePath });
      continue;
    }

    const tmpFilePath = `${filePath}.tmp`;
    try {
      const buffer = Buffer.from(imageBlock.data, "base64");
      await fs.writeFile(tmpFilePath, buffer);
      await fs.rename(tmpFilePath, filePath);
      savedImages.push({
        relativePath: `.rebel/tool-outputs/${filename}`,
        mimeType: normalizedMimeType,
      });
      totalBase64Bytes = nextTotalBytes;
    } catch (err: any) {
      try {
        await fs.unlink(tmpFilePath);
      } catch (cleanupErr) {}
      logger.warn("Failed to save extracted image; continuing", {
        file_path: filePath,
        error: err?.message ?? String(err),
      });
    }
  }

  return savedImages;
}

export async function materializeOutput(
  package_id: string,
  tool_id: string,
  args_used: unknown,
  toolResult: unknown,
  duration_ms: number,
  workspacePath: string,
  limit: number,
): Promise<UseToolOutput | null> {
  if (!workspacePath) {
    return null;
  }

  const { data, fullContent, textParts, imageBlocks, isStringText, isError } = extractDataForMaterialization(toolResult);

  if (imageBlocks.length > 0 && !isError) {
    const filenamePrefix = buildFilenamePrefix(package_id, tool_id);
    const targetDir = path.join(workspacePath, ".rebel", "tool-outputs");
    const archiveFilename = `${filenamePrefix}.json`;
    const archivePath = path.join(targetDir, archiveFilename);
    const archiveContent = JSON.stringify(fullContent, null, 2);
    const size_chars = archiveContent.length;
    // Always materialize when images exist — images must be saved as binary files
    // and stripped from the LLM context regardless of text size.
    const shouldMaterializeMixedContent = true;

    if (!shouldMaterializeMixedContent) {
      return null;
    }

    if (size_chars > SIZE_CAP_CHARS) {
      logger.warn("Materialization skipped: output exceeds 20MB cap", { package_id, tool_id, size_chars });
      return null;
    }

    if (!isPathWithinTarget(archivePath, targetDir)) {
      logger.error("Path traversal detected, aborting materialization", { package_id, tool_id, filePath: archivePath });
      return null;
    }

    let archiveTmpPath = `${archivePath}.tmp`;
    let savedImages: SavedImageFile[] = [];
    try {
      await fs.mkdir(targetDir, { recursive: true });
      // Defense-in-depth: abort if the tool-outputs dir resolves (via symlink)
      // outside the workspace, and write through the resolved real dir.
      const realTargetDir = await resolveRealTargetWithinWorkspace(targetDir, workspacePath, { package_id, tool_id });
      if (!realTargetDir) {
        return null;
      }
      const realArchivePath = path.join(realTargetDir, archiveFilename);
      archiveTmpPath = `${realArchivePath}.tmp`;
      savedImages = await saveImageFiles(imageBlocks, realTargetDir, filenamePrefix);
      await fs.writeFile(archiveTmpPath, archiveContent, "utf8");
      await fs.rename(archiveTmpPath, realArchivePath);
    } catch (err: any) {
      try {
        await fs.unlink(archiveTmpPath);
      } catch (cleanupErr) {}

      logger.warn("Materialization failed", {
        event: 'materialization_failed_fallback',
        package_id,
        tool_id,
        size_chars,
        file_path: archivePath,
        errno: err?.errno,
        error: err?.message ?? String(err),
      });
      return null;
    }

    const relativePath = `.rebel/tool-outputs/${archiveFilename}`;
    logger.info("Materialization successful", {
      event: 'materialization_success',
      package_id,
      tool_id,
      size_chars,
      file_path: archivePath,
      relative_path: relativePath,
      image_count: savedImages.length,
    });

    const estimated_tokens = Math.ceil(size_chars / 4);
    const preservedText = textParts.join("\n");
    const imageFilePaths = savedImages.map((img) => img.relativePath);

    // Text-only preview (never include base64 image data in preview)
    const textPreview = preservedText.slice(0, 2048);

    // Mixed-content message: guide the LLM to preserved_text and image_files,
    // NOT the archive (which contains embedded image data)
    const imageListStr = imageFilePaths.length > 0
      ? `\nImage files saved to workspace:\n${imageFilePaths.map((p) => `  ${p}`).join("\n")}`
      : "";
    const mixedMessage = preservedText
      ? `Tool returned text + ${imageFilePaths.length} image(s). The original text is in result.preserved_text below.${imageListStr}\nFull archive (${size_chars.toLocaleString()} chars, contains embedded image data — do NOT read it): ${relativePath}`
      : `Tool returned ${imageFilePaths.length} image(s).${imageListStr}\nFull archive: ${relativePath}`;

    return {
      package_id,
      tool_id,
      args_used,
      result: {
        status: "materialized",
        message: mixedMessage,
        file_path: relativePath,
        size_chars,
        estimated_tokens,
        preview: textPreview,
        preview_truncated: preservedText.length > 2048,
        preserved_text: preservedText,
        image_files: imageFilePaths,
        archive_path: relativePath,
      },
      telemetry: { duration_ms, status: "ok", materialized: true },
    };
  }

  let isJson = !isStringText;
  let parsedData = data;

  if (isStringText && typeof data === "string") {
    const trimmed = data.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed === "object" && parsed !== null) {
          isJson = true;
          parsedData = parsed;
        }
      } catch (e) {
        // Not valid JSON
      }
    }
  }

  let fileContent = "";
  let ext = ".txt";

  if (isJson) {
    ext = ".json";
    fileContent = JSON.stringify(parsedData, null, 2);
  } else {
    ext = ".txt";
    const frontmatter = `---\npackage_id: ${JSON.stringify(package_id)}\ntool_id: ${JSON.stringify(tool_id)}\n---\n`;
    fileContent = frontmatter + (data as string);
  }

  const size_chars = fileContent.length;

  if (size_chars <= limit) {
    return null; // Not large enough to materialize
  }

  if (size_chars > SIZE_CAP_CHARS) {
    logger.warn("Materialization skipped: output exceeds 20MB cap", { package_id, tool_id, size_chars });
    return null; // T18: >20MB falls back to continuation
  }

  // Write file atomically
  const filenamePrefix = buildFilenamePrefix(package_id, tool_id);
  const filename = `${filenamePrefix}${ext}`;

  const targetDir = path.join(workspacePath, ".rebel", "tool-outputs");
  const filePath = path.join(targetDir, filename);

  // Defense-in-depth: verify resolved path is within the target directory
  if (!isPathWithinTarget(filePath, targetDir)) {
    logger.error("Path traversal detected, aborting materialization", { package_id, tool_id, filePath });
    return null;
  }

  let tmpFilePath = filePath + ".tmp";

  try {
    await fs.mkdir(targetDir, { recursive: true });
    // Defense-in-depth: abort if the tool-outputs dir resolves (via symlink)
    // outside the workspace, and write through the resolved real dir.
    const realTargetDir = await resolveRealTargetWithinWorkspace(targetDir, workspacePath, { package_id, tool_id });
    if (!realTargetDir) {
      return null;
    }
    const realFilePath = path.join(realTargetDir, filename);
    tmpFilePath = `${realFilePath}.tmp`;
    await fs.writeFile(tmpFilePath, fileContent, "utf8");
    await fs.rename(tmpFilePath, realFilePath);
  } catch (err: any) {
    // Clean up tmp file if possible
    try { await fs.unlink(tmpFilePath); } catch (e) {}
    
    // Log failure
    logger.warn("Materialization failed", {
      event: 'materialization_failed_fallback',
      package_id,
      tool_id,
      size_chars,
      file_path: filePath,
      errno: err.errno,
      error: err.message
    });
    return null; // Fallback to continuation
  }

  const relativePath = `.rebel/tool-outputs/${filename}`;

  logger.info("Materialization successful", {
    event: 'materialization_success',
    package_id,
    tool_id,
    size_chars,
    file_path: filePath,
    relative_path: relativePath
  });

  const preview = fileContent.slice(0, 2048);
  const estimated_tokens = Math.ceil(size_chars / 4);

  const result = {
    status: "materialized",
    message: `Full output (${size_chars.toLocaleString()} chars) saved to workspace file: ${relativePath}. Use the Read tool (with offset/limit for targeted sections) or Grep tool (to search for specific content) to explore.`,
    file_path: relativePath,
    size_chars: size_chars,
    estimated_tokens: estimated_tokens,
    preview: preview,
    preview_truncated: size_chars > 2048
  };

  return {
    package_id,
    tool_id,
    args_used,
    result,
    telemetry: { duration_ms, status: "ok", materialized: true }
  };
}
