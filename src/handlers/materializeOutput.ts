import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { UseToolOutput } from "../types.js";
import { getLogger } from "../logging.js";
import { resolveToolResultPayload } from "../utils/toolResultPayload.js";
import { canonicalJson } from "./progressDigest.js";

// super-mcp is a separately built package and cannot import @rebel/shared.
// Parent-repo conformance tests keep this exact set aligned with IMAGE_MIME_TYPES.
export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_SAVE_IMAGES = 5;
const MAX_SAVE_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB total base64
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
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
}

const logger = getLogger();

function sanitizeForFilename(str: string): string {
  return str.replace(/[\\/:*?"<>|\n\r]/g, '_').replace(/\.\.+/g, '_').slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeImageMimeType(mimeType: string): string {
  const lowercased = mimeType.toLowerCase();
  return lowercased === "image/jpg" ? "image/jpeg" : lowercased;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMimeType(mimeType));
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

      const normalizedMimeType = normalizeImageMimeType(block.mimeType);
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
        isSupportedImageMimeType(resource.mimeType)
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
          mimeType: normalizeImageMimeType(resource.mimeType),
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

const PREVIEW_MAX_CHARS = 2048;

/**
 * The first `max` UTF-16 units of `text`, shortened by one when the cut would
 * leave the high half of a surrogate pair (emoji, astral characters) on its own.
 */
function previewOf(text: string, max = PREVIEW_MAX_CHARS): string {
  if (text.length <= max) return text;
  const lastKept = text.charCodeAt(max - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

export interface ShortenedArgsEcho {
  status: "args_shortened";
  message: string;
  original_chars: number;
  preview: string;
  sha256: string;
}

/**
 * How many chars the argument echo costs in a reply: `args_used` serialized as
 * it is inside the pretty-printed reply (one level deep).
 */
export function argsEchoChars(args: unknown): number {
  return JSON.stringify({ args_used: args }, null, 2).length;
}

/**
 * What a reply echoes as `args_used` in place of arguments too large to echo
 * whole (a long document passed in): the start of their canonical JSON, labelled,
 * with the SHA-256 of all of it, so an identity derived from the echo is still
 * the same for the same arguments and different for different ones. The caller
 * decides when the arguments are too large.
 */
export function shortenArgsEcho(args: unknown): ShortenedArgsEcho {
  const canonical = canonicalJson(args ?? null);
  return {
    status: "args_shortened",
    message: `This is a shortened echo of the arguments (${canonical.length.toLocaleString()} chars), not what was sent to the tool; preview holds their start, and sha256 identifies the full arguments.`,
    original_chars: canonical.length,
    preview: previewOf(canonical),
    sha256: `sha256:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`,
  };
}

/**
 * The one rule for the argument echo: shortened when the arguments' echo is
 * over the call's output limit, whole otherwise, and always whole when there is
 * no limit. It depends on the arguments alone, so the same arguments get the
 * same echo whatever the result beside them.
 */
export function argsEchoFor(args: unknown, limit: number | undefined): unknown {
  return limit !== undefined && argsEchoChars(args) > limit ? shortenArgsEcho(args) : args;
}

function isImagePayloadBlock(block: unknown, anyImageType: boolean): boolean {
  if (!isRecord(block)) return false;
  if (block.type === "image") return true;
  if (block.type === "resource" && isRecord(block.resource)) {
    const resource = block.resource;
    if (typeof resource.blob !== "string" || resource.blob.length === 0 || typeof resource.mimeType !== "string") {
      return false;
    }
    return anyImageType
      ? resource.mimeType.toLowerCase().startsWith("image/")
      : isSupportedImageMimeType(resource.mimeType);
  }
  return false;
}

/**
 * Removes image payloads (image blocks, and resource blocks carrying an image
 * blob) from a tool result's content. For a successful result it removes exactly
 * the images that were extracted and passed through. Error results never have
 * their images extracted, so for them it removes every image resource of any
 * type: their base64 must not reach a saved file or the inline reply.
 */
export function stripImagePayloads<T>(toolResult: T, options: { isError?: boolean } = {}): T {
  if (!isRecord(toolResult) || !Array.isArray(toolResult.content)) return toolResult;
  const anyImageType = options.isError === true;
  const content = toolResult.content.filter((block) => !isImagePayloadBlock(block, anyImageType));
  if (content.length === toolResult.content.length) return toolResult;
  return { ...toolResult, content } as T;
}

function hasStructuredContent(toolResult: unknown): boolean {
  return isRecord(toolResult) && isRecord(toolResult.structuredContent);
}

function extractDataForMaterialization(rawToolResult: unknown, includeStructuredContent: boolean): DecomposedContent {
  if (isRecord(rawToolResult)) {
    const isError = Boolean(rawToolResult.isError);
    const toolResult = isError ? stripImagePayloads(rawToolResult, { isError: true }) : rawToolResult;
    if (Array.isArray(toolResult.content)) {
      if (includeStructuredContent && !isError && hasStructuredContent(toolResult)) {
        const data = { content: toolResult.content, structuredContent: toolResult.structuredContent };
        return {
          data,
          fullContent: toolResult.content,
          textParts: [],
          imageBlocks: [],
          isStringText: false,
        };
      }
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
        };
      }

      const textParts: string[] = [];
      for (const block of toolResult.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }

      const payload = textParts.length === 0 && !isError ? resolveToolResultPayload(toolResult, "") : null;
      return {
        data: payload ? payload.data : toolResult.content,
        fullContent: toolResult.content,
        textParts,
        imageBlocks: extractImageContentBlocks(toolResult),
        isStringText: false,
      };
    }
  }
  return {
    data: rawToolResult,
    fullContent: rawToolResult,
    textParts: [],
    imageBlocks: [],
    isStringText: false,
  };
}

/** How a result is written to its saved file: JSON pretty-printed, anything else as text under frontmatter. */
function serializeForFile(
  data: unknown,
  isStringText: boolean,
  package_id: string,
  tool_id: string,
): { ext: ".json" | ".txt"; fileContent: string } {
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

  if (isJson) {
    return { ext: ".json", fileContent: JSON.stringify(parsedData, null, 2) };
  }
  const frontmatter = `---\npackage_id: ${JSON.stringify(package_id)}\ntool_id: ${JSON.stringify(tool_id)}\n---\n`;
  return { ext: ".txt", fileContent: frontmatter + (data as string) };
}

// Names no tool: the host's own file tools differ (Rebel has no "Grep" tool).
const SAVED_FILE_READ_HINT = "Read it in sections with offset and limit, or search it, using your file tools.";

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

export interface MaterializeOptions {
  /**
   * Save `content` and `structuredContent` together. Set only by the caller that
   * knows the inline reply would otherwise be replaced by the oversized
   * placeholder, so a result that is returned whole today stays whole.
   */
  includeStructuredContent?: boolean;
}

export async function materializeOutput(
  package_id: string,
  tool_id: string,
  args_used: unknown,
  toolResult: unknown,
  duration_ms: number,
  workspacePath: string,
  limit: number,
  options: MaterializeOptions = {},
): Promise<UseToolOutput | null> {
  if (!workspacePath) {
    return null;
  }

  const { data, fullContent, textParts, imageBlocks, isStringText } =
    extractDataForMaterialization(toolResult, options.includeStructuredContent === true);

  // Results with images always materialize: images are saved as binary files and
  // stripped from the LLM context regardless of text size.
  if (imageBlocks.length > 0) {
    const filenamePrefix = buildFilenamePrefix(package_id, tool_id);
    const targetDir = path.join(workspacePath, ".rebel", "tool-outputs");
    const archiveFilename = `${filenamePrefix}.json`;
    const archivePath = path.join(targetDir, archiveFilename);
    const archiveContent = JSON.stringify(fullContent, null, 2);
    const size_chars = archiveContent.length;

    if (size_chars > SIZE_CAP_CHARS) {
      logger.warn("Materialization skipped: output exceeds 20MB cap", { package_id, tool_id, size_chars });
      return null;
    }

    if (!isPathWithinTarget(archivePath, targetDir)) {
      logger.error("Path traversal detected, aborting materialization", { package_id, tool_id, filePath: archivePath });
      return null;
    }

    const preservedText = textParts.join("\n");
    // Text too large to keep inline is saved on its own, the same way a text-only
    // result is, so the AI reads text and never the archive's embedded image data.
    // Whether it stays inline is judged on the text that would go inline; the
    // serializer only decides how the saved file looks.
    // Judged on what the text costs inside the reply (escaped, without its two
    // quotes), not its raw length: newlines and quotes escape to two chars each.
    const savedText = JSON.stringify(preservedText).length - 2 > limit
      ? serializeForFile(preservedText, true, package_id, tool_id)
      : null;
    const textFilename = savedText ? `${filenamePrefix}_text${savedText.ext}` : null;

    if (savedText && savedText.fileContent.length > SIZE_CAP_CHARS) {
      logger.warn("Materialization skipped: text beside images exceeds 20MB cap", {
        package_id,
        tool_id,
        size_chars,
        text_size_chars: savedText.fileContent.length,
      });
      return null;
    }

    const tmpPaths: string[] = [];
    // The finished text file is removed if the archive then fails, so nothing is
    // left on disk that no reply names.
    let finishedTextPath: string | null = null;
    let savedImages: SavedImageFile[] = [];
    try {
      await fs.mkdir(targetDir, { recursive: true });
      // Defense-in-depth: abort if the tool-outputs dir resolves (via symlink)
      // outside the workspace, and write through the resolved real dir.
      const realTargetDir = await resolveRealTargetWithinWorkspace(targetDir, workspacePath, { package_id, tool_id });
      if (!realTargetDir) {
        return null;
      }
      savedImages = await saveImageFiles(imageBlocks, realTargetDir, filenamePrefix);
      if (savedText && textFilename) {
        const realTextPath = path.join(realTargetDir, textFilename);
        tmpPaths.push(`${realTextPath}.tmp`);
        await fs.writeFile(`${realTextPath}.tmp`, savedText.fileContent, "utf8");
        await fs.rename(`${realTextPath}.tmp`, realTextPath);
        finishedTextPath = realTextPath;
      }
      const realArchivePath = path.join(realTargetDir, archiveFilename);
      tmpPaths.push(`${realArchivePath}.tmp`);
      await fs.writeFile(`${realArchivePath}.tmp`, archiveContent, "utf8");
      await fs.rename(`${realArchivePath}.tmp`, realArchivePath);
    } catch (err: any) {
      for (const tmpPath of tmpPaths) {
        try {
          await fs.unlink(tmpPath);
        } catch (cleanupErr) {}
      }
      if (finishedTextPath) {
        try {
          await fs.unlink(finishedTextPath);
        } catch (cleanupErr: any) {
          logger.warn("Failed to remove text file after archive write failed", {
            package_id,
            tool_id,
            file_path: finishedTextPath,
            error: cleanupErr?.message ?? String(cleanupErr),
          });
        }
      }

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
    const textRelativePath = textFilename ? `.rebel/tool-outputs/${textFilename}` : undefined;
    logger.info("Materialization successful", {
      event: 'materialization_success',
      package_id,
      tool_id,
      size_chars,
      file_path: archivePath,
      relative_path: relativePath,
      image_count: savedImages.length,
      ...(textRelativePath ? { text_relative_path: textRelativePath, text_size_chars: savedText!.fileContent.length } : {}),
    });

    const estimated_tokens = Math.ceil(size_chars / 4);
    const imageFilePaths = savedImages.map((img) => img.relativePath);

    // Text-only preview (never include base64 image data in preview)
    const previewSource = savedText ? savedText.fileContent : preservedText;
    const textPreview = previewOf(previewSource);

    // Mixed-content message: guide the LLM to the text and image_files,
    // NOT the archive (which contains embedded image data)
    const imageListStr = imageFilePaths.length > 0
      ? `\nImage files saved to workspace:\n${imageFilePaths.map((p) => `  ${p}`).join("\n")}`
      : "";
    const archiveNote = `Full archive (${size_chars.toLocaleString()} chars, contains embedded image data — do NOT read it): ${relativePath}`;
    const mixedMessage = savedText && textRelativePath
      ? `Tool returned text + ${imageFilePaths.length} image(s). The text (${savedText.fileContent.length.toLocaleString()} chars) is saved to workspace file: ${textRelativePath}. ${SAVED_FILE_READ_HINT}${imageListStr}\n${archiveNote}`
      : preservedText
        ? `Tool returned text + ${imageFilePaths.length} image(s). The original text is in result.preserved_text below.${imageListStr}\n${archiveNote}`
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
        preview_truncated: textPreview.length < previewSource.length,
        ...(textRelativePath ? { text_file_path: textRelativePath } : { preserved_text: preservedText }),
        image_files: imageFilePaths,
        archive_path: relativePath,
      },
      telemetry: { duration_ms, status: "ok", materialized: true },
    };
  }

  const { ext, fileContent } = serializeForFile(data, isStringText, package_id, tool_id);
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

  const preview = previewOf(fileContent);
  const estimated_tokens = Math.ceil(size_chars / 4);

  const result = {
    status: "materialized",
    message: `Full output (${size_chars.toLocaleString()} chars) saved to workspace file: ${relativePath}. ${SAVED_FILE_READ_HINT}`,
    file_path: relativePath,
    size_chars: size_chars,
    estimated_tokens: estimated_tokens,
    preview: preview,
    preview_truncated: size_chars > PREVIEW_MAX_CHARS
  };

  return {
    package_id,
    tool_id,
    args_used,
    result,
    telemetry: { duration_ms, status: "ok", materialized: true }
  };
}
