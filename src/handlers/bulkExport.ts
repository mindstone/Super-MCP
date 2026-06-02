import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";
import { PackageRegistry } from "../registry.js";
import { getSecurityPolicy } from "../security.js";
import { BulkExportInput, BulkExportOutput } from "../types.js";
import { coerceStringifiedJson, coerceStringifiedNumber } from "../utils/normalizeInput.js";

const logger = getLogger();

const BULK_EXPORT_MAX_RETRIES = 3;
const BULK_EXPORT_RETRY_BASE_MS = 1_000;
const BULK_EXPORT_TIMEOUT_MS = 10 * 60 * 1_000;
const BULK_EXPORT_TIMEOUT_MESSAGE = "Bulk export timed out after 10 minutes.";
const BULK_EXPORT_ABORTED_MESSAGE = "Bulk export was cancelled.";
export const BULK_EXPORT_MAX_PAGE_BYTES = 10 * 1024 * 1024;

const TRUSTABLE_READ_ONLY_VERBS = [
  "list",
  "get",
  "search",
  "read",
  "fetch",
  "describe",
  "show",
  "check",
  "view",
  "inspect",
  "lookup",
  "find",
  "count",
  "query",
  "history",
  "preview",
  "load",
] as const;

const SIDE_EFFECT_VERBS = [
  "send",
  "post",
  "create",
  "delete",
  "remove",
  "update",
  "modify",
  "edit",
  "add",
  "submit",
  "publish",
  "archive",
  "move",
  "copy",
  "transfer",
  "execute",
  "run",
  "trigger",
  "start",
  "stop",
  "cancel",
  "approve",
  "reject",
  "assign",
  "unassign",
  "replace",
  "manage",
] as const;

const SELF_RECURSION_TOOL_IDS = new Set([
  "use_tool",
  "bulk_export",
  "list_tool_packages",
  "list_tools",
  "get_tool_details",
  "get_help",
  "health_check",
  "health_check_all",
  "authenticate",
  "restart_package",
  "search_tools",
]);

const readOnlyPatterns = TRUSTABLE_READ_ONLY_VERBS.map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`),
);

const sideEffectPatterns = SIDE_EFFECT_VERBS.map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`),
);

interface ParsedBulkExportInput {
  packageId: string;
  toolId: string;
  args: Record<string, unknown>;
  outputFile: string;
  ifExists: "error" | "overwrite";
  itemsPath?: string;
  maxPages?: number;
  pagination?: { tokenField: string; inputParam: string };
}

interface ToolExecutionResult {
  output: string;
  isError: boolean;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

interface RunBulkExportParams {
  toolName: string;
  args: Record<string, unknown>;
  absoluteOutputFile: string;
  relativeOutputFile: string;
  ifExists: "error" | "overwrite";
  itemsPath?: string;
  maxPages?: number;
  signal: AbortSignal;
  pagination?: { tokenField: string; inputParam: string };
  executeTool: (name: string, input: unknown) => Promise<ToolExecutionResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function errorResponse(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function successResponse(output: BulkExportOutput): { content: Array<{ type: "text"; text: string }>; isError: false } {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    isError: false,
  };
}

function normalizeToSnakeCase(id: string): string {
  return id
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function isDeterministicallyReadOnly(toolId: string): boolean {
  const normalized = normalizeToSnakeCase(toolId);
  const hasReadOnlyVerb = readOnlyPatterns.some((pattern) => pattern.test(normalized));
  if (!hasReadOnlyVerb) return false;
  const hasSideEffectVerb = sideEffectPatterns.some((pattern) => pattern.test(normalized));
  return !hasSideEffectVerb;
}

function validateReadOnlyFromAnnotations(toolId: string, annotations: ToolAnnotations | undefined): string | null | undefined {
  if (
    annotations === undefined ||
    (
      annotations.readOnlyHint === undefined &&
      annotations.destructiveHint === undefined &&
      annotations.openWorldHint === undefined
    )
  ) {
    return undefined;
  }

  if (annotations.destructiveHint === true) {
    return `bulk_export only supports read-only tools. '${toolId}' is annotated as destructive.`;
  }
  if (annotations.readOnlyHint === false) {
    return `bulk_export only supports read-only tools. '${toolId}' is not annotated as read-only.`;
  }
  if (annotations.readOnlyHint === true) {
    return null;
  }

  return `bulk_export only supports tools with explicit read-only annotations. '${toolId}' has annotations but no readOnlyHint.`;
}

async function validateReadOnlyTool(
  packageId: string,
  toolId: string,
  catalog: Catalog,
): Promise<string | null> {
  const catalogWithGetTool = catalog as Catalog & {
    getTool?: (packageId: string, toolId: string) => Promise<{ tool?: { annotations?: ToolAnnotations } } | undefined>;
  };
  const cachedTool = typeof catalogWithGetTool.getTool === "function"
    ? await catalogWithGetTool.getTool(packageId, toolId)
    : undefined;
  const annotationDecision = validateReadOnlyFromAnnotations(toolId, cachedTool?.tool?.annotations);
  if (annotationDecision !== undefined) {
    return annotationDecision;
  }

  if (!isDeterministicallyReadOnly(toolId)) {
    return `bulk_export only supports deterministically read-only tools. '${toolId}' appears to modify state.`;
  }

  return null;
}

function getByPath(obj: unknown, dotPath: string): unknown {
  let current = obj;
  for (const key of dotPath.split(".")) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseNamespacedTool(packageId: string | undefined, toolId: string): { packageId: string; toolId: string } {
  if (toolId.includes("__") && !packageId) {
    const parts = toolId.split("__");
    if (parts.length >= 2) {
      return {
        packageId: parts[0],
        toolId: parts.slice(1).join("__"),
      };
    }
  }

  if (packageId && toolId.startsWith(`${packageId}__`)) {
    return {
      packageId,
      toolId: toolId.substring(packageId.length + 2),
    };
  }

  if (!packageId) {
    throw new Error("package_id is required unless tool_id is namespaced like 'Package__tool_name'.");
  }

  return { packageId, toolId };
}

function parseInput(input: BulkExportInput): ParsedBulkExportInput {
  const normalizedArgs = coerceStringifiedJson<Record<string, unknown>>(input.args, "object", {
    handler: "bulk_export",
    field: "args",
    package_id: typeof input.package_id === "string" ? input.package_id : undefined,
    tool_id: typeof input.tool_id === "string" ? input.tool_id : undefined,
  });
  const normalizedPagination = coerceStringifiedJson<Record<string, unknown>>(input.pagination, "object", {
    handler: "bulk_export",
    field: "pagination",
    package_id: typeof input.package_id === "string" ? input.package_id : undefined,
    tool_id: typeof input.tool_id === "string" ? input.tool_id : undefined,
  });
  const normalizedMaxPages = coerceStringifiedNumber(input.max_pages, {
    handler: "bulk_export",
    field: "max_pages",
  });

  const rawPackageId = typeof input.package_id === "string" && input.package_id.trim().length > 0
    ? input.package_id.trim()
    : undefined;
  const rawToolId = typeof input.tool_id === "string" ? input.tool_id.trim() : "";
  const outputFile = typeof input.output_file === "string" ? input.output_file.trim() : "";
  const ifExists = input.if_exists ?? "error";
  const itemsPath = typeof input.items_path === "string" && input.items_path.trim().length > 0
    ? input.items_path.trim()
    : undefined;

  if (!rawToolId) {
    throw new Error("tool_id is required and must be a string.");
  }
  if (!isRecord(normalizedArgs)) {
    throw new Error("args is required and must be an object.");
  }
  if (!outputFile) {
    throw new Error("output_file is required and must be a relative file path.");
  }
  if (input.items_path !== undefined && itemsPath === undefined) {
    throw new Error("items_path must be a non-empty string when provided.");
  }
  if (ifExists !== "error" && ifExists !== "overwrite") {
    throw new Error("if_exists must be either 'error' or 'overwrite'.");
  }
  if (normalizedMaxPages !== undefined && typeof normalizedMaxPages !== "number") {
    throw new Error("max_pages must be a number when provided.");
  }

  const { packageId, toolId } = parseNamespacedTool(rawPackageId, rawToolId);
  const normalizedToolId = normalizeToSnakeCase(toolId);

  if (SELF_RECURSION_TOOL_IDS.has(normalizedToolId)) {
    throw new Error(`bulk_export cannot call SuperMCP tool '${toolId}'. Choose a downstream package tool instead.`);
  }

  if (normalizedPagination !== undefined && !isRecord(normalizedPagination)) {
    throw new Error("pagination must be an object when provided.");
  }

  let pagination: ParsedBulkExportInput["pagination"];
  if (normalizedPagination) {
    const tokenField = normalizedPagination.token_field;
    const inputParam = normalizedPagination.input_param;
    if (typeof tokenField !== "string" || tokenField.trim().length === 0) {
      throw new Error("pagination.token_field is required and must be a non-empty string.");
    }
    if (typeof inputParam !== "string" || inputParam.trim().length === 0) {
      throw new Error("pagination.input_param is required and must be a non-empty string.");
    }
    pagination = {
      tokenField: tokenField.trim(),
      inputParam: inputParam.trim(),
    };
  }

  return {
    packageId,
    toolId,
    args: { ...normalizedArgs },
    outputFile,
    ifExists,
    itemsPath,
    maxPages: typeof normalizedMaxPages === "number" ? normalizedMaxPages : undefined,
    pagination,
  };
}

function isPathWithinRealRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveOutputPath(outputFile: string): Promise<{ absolutePath: string; relativePath: string }> {
  const workspacePath = process.env.REBEL_WORKSPACE_PATH?.trim();
  if (!workspacePath) {
    throw new Error("REBEL_WORKSPACE_PATH is not set.");
  }

  let workspaceStats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    workspaceStats = await fs.stat(workspacePath);
  } catch {
    throw new Error(`REBEL_WORKSPACE_PATH does not exist: ${workspacePath}`);
  }

  if (!workspaceStats.isDirectory()) {
    throw new Error(`REBEL_WORKSPACE_PATH is not a directory: ${workspacePath}`);
  }

  if (path.isAbsolute(outputFile)) {
    throw new Error("output_file must be a relative path under .rebel/exports.");
  }

  const exportRoot = path.resolve(workspacePath, ".rebel", "exports");
  const absolutePath = path.resolve(exportRoot, outputFile);
  const relativeFromRoot = path.relative(exportRoot, absolutePath);

  if (
    relativeFromRoot === "" ||
    relativeFromRoot === "." ||
    relativeFromRoot.startsWith("..") ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error("output_file must stay within .rebel/exports.");
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const realExportRoot = await fs.realpath(exportRoot);
  const realParentDir = await fs.realpath(path.dirname(absolutePath));
  // Lexical checks above block direct traversal. This realpath check catches
  // symlinked subdirectories under .rebel/exports that point outside the export root.
  if (!isPathWithinRealRoot(realParentDir, realExportRoot)) {
    throw new Error("output_file parent directory must stay within .rebel/exports.");
  }
  try {
    const targetStats = await fs.lstat(absolutePath);
    if (targetStats.isSymbolicLink()) {
      throw new Error("output_file must not be a symlink.");
    }
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const relativePath = path.posix.join(
    ".rebel",
    "exports",
    ...relativeFromRoot.split(path.sep).filter(Boolean),
  );

  return { absolutePath, relativePath };
}

function extractMcpTextResult(toolResult: unknown): ToolExecutionResult {
  const isError = isRecord(toolResult) && toolResult.isError === true;

  if (!isRecord(toolResult) || !Array.isArray(toolResult.content)) {
    return {
      output: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult) ?? "",
      isError: isError || true,
    };
  }

  const text = toolResult.content
    .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");

  if (text.length > 0) {
    return { output: text, isError };
  }

  return {
    output: JSON.stringify(toolResult.content),
    isError: true,
  };
}

async function waitWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDrainOrAbort(stream: NodeJS.WritableStream, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await Promise.race([
    once(stream, "drain"),
    once(stream, "error"),
    once(signal, "abort"),
  ]);
}

function getAbortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  return typeof reason === "string"
    ? reason
    : reason instanceof Error
      ? reason.message
      : BULK_EXPORT_ABORTED_MESSAGE;
}

function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason ?? BULK_EXPORT_ABORTED_MESSAGE);
    }
  };

  if (primary.aborted) {
    abortFrom(primary);
  } else {
    primary.addEventListener("abort", () => abortFrom(primary), { once: true });
  }

  if (secondary.aborted) {
    abortFrom(secondary);
  } else {
    secondary.addEventListener("abort", () => abortFrom(secondary), { once: true });
  }

  return controller.signal;
}

async function runBulkExport(params: RunBulkExportParams): Promise<BulkExportOutput> {
  const maxPages = Math.max(1, Math.min(params.maxPages ?? 100, 500));
  if (params.ifExists === "error") {
    try {
      await fs.access(params.absoluteOutputFile);
      return {
        status: "failed",
        pages: 0,
        pages_completed: 0,
        lines: 0,
        bytes: 0,
        output_file: params.relativeOutputFile,
        errors: [`Output file already exists: ${params.relativeOutputFile}`],
      };
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  const stream = createWriteStream(params.absoluteOutputFile, { flags: params.ifExists === "error" ? "wx" : "w" });
  let streamError: Error | undefined;

  stream.on("error", (error) => {
    streamError = error;
  });

  let page = 0;
  let lines = 0;
  let bytes = 0;
  let currentArgs: Record<string, unknown> = { ...params.args };
  const errors: string[] = [];
  let completedNaturally = false;

  try {
    while (page < maxPages) {
      if (params.signal.aborted) {
        errors.push(getAbortMessage(params.signal));
        break;
      }
      if (streamError) {
        break;
      }

      let result: ToolExecutionResult | undefined;

      for (let attempt = 0; attempt <= BULK_EXPORT_MAX_RETRIES; attempt++) {
        if (params.signal.aborted) {
          break;
        }

        result = await params.executeTool(params.toolName, currentArgs);
        if (!result.isError) {
          break;
        }

        if (attempt < BULK_EXPORT_MAX_RETRIES) {
          const delay = BULK_EXPORT_RETRY_BASE_MS * Math.pow(2, attempt);
          await waitWithAbort(delay, params.signal);
        } else {
          errors.push(`Page ${page + 1}: ${result.output}`);
        }
      }

      if (params.signal.aborted) {
        const abortMessage = getAbortMessage(params.signal);
        if (!errors.includes(abortMessage)) {
          errors.push(abortMessage);
        }
        break;
      }

      if (!result || result.isError) {
        break;
      }

      const rawPageBytes = Buffer.byteLength(result.output);
      if (rawPageBytes > BULK_EXPORT_MAX_PAGE_BYTES) {
        errors.push(`Page ${page + 1} raw output exceeded 10MB; lower the tool's page size.`);
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.output);
      } catch {
        errors.push("Tool output is not JSON. Try adding returnJson: true to args.");
        break;
      }

      let items: unknown[];
      if (params.itemsPath) {
        const extracted = getByPath(parsed, params.itemsPath);
        if (page === 0 && extracted === undefined) {
          const keys = isRecord(parsed) ? Object.keys(parsed).join(", ") : "none";
          errors.push(`No items at path '${params.itemsPath}'. Available keys: ${keys}`);
          break;
        }
        items = Array.isArray(extracted) ? extracted : extracted != null ? [extracted] : [];
      } else {
        items = [parsed];
      }

      for (const item of items) {
        if (streamError) {
          break;
        }

        const line = `${JSON.stringify(item)}\n`;
        const canContinue = stream.write(line);
        if (!canContinue && !streamError) {
          await waitForDrainOrAbort(stream, params.signal);
        }
        if (streamError) {
          break;
        }

        lines++;
        bytes += Buffer.byteLength(line);
      }

      page++;

      if (!params.pagination) {
        completedNaturally = true;
        break;
      }

      const nextToken = getByPath(parsed, params.pagination.tokenField);
      if (!nextToken) {
        completedNaturally = true;
        break;
      }

      currentArgs = {
        ...currentArgs,
        [params.pagination.inputParam]: nextToken,
      };
    }

    if (page >= maxPages && errors.length === 0) {
      completedNaturally = true;
    }
  } finally {
    stream.end();
    try {
      await finished(stream);
    } catch {
      // Stream error is tracked via streamError.
    }
  }

  if (streamError) {
    errors.push(`Stream error: ${streamError.message}`);
  }

  const status: BulkExportOutput["status"] =
    errors.length === 0 && completedNaturally ? "complete" : lines > 0 ? "partial" : "failed";

  return {
    status,
    pages: page,
    pages_completed: page,
    lines,
    bytes,
    output_file: params.relativeOutputFile,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function validateSecurityPolicy(packageId: string, toolId: string, registry: PackageRegistry): string | null {
  const securityPolicy = getSecurityPolicy();
  const blockCheck = securityPolicy.isToolBlocked(packageId, toolId);
  if (blockCheck.blocked) {
    return blockCheck.reason || `Tool '${packageId}__${toolId}' is blocked by security policy.`;
  }

  const packageConfig = registry.getPackage(packageId);
  if (!packageConfig) {
    return `Package not found: ${packageId}`;
  }

  if (securityPolicy.isAdminDisabled(packageConfig.catalogId, toolId)) {
    return `Tool '${packageId}__${toolId}' is disabled by your organization's administrator.`;
  }

  if (securityPolicy.isUserDisabled(packageId, toolId)) {
    return `Tool '${packageId}__${toolId}' is disabled by user preference. Re-enable it in Settings to use.`;
  }

  return null;
}

export async function handleBulkExport(
  input: BulkExportInput,
  registry: PackageRegistry,
  catalog: Catalog,
  externalSignal?: AbortSignal,
): Promise<any> {
  let parsedInput: ParsedBulkExportInput;
  try {
    parsedInput = parseInput(input);
  } catch (error) {
    return errorResponse(toErrorMessage(error));
  }

  const securityError = validateSecurityPolicy(parsedInput.packageId, parsedInput.toolId, registry);
  if (securityError) {
    return errorResponse(securityError);
  }

  try {
    const readOnlyError = await validateReadOnlyTool(parsedInput.packageId, parsedInput.toolId, catalog);
    if (readOnlyError) {
      return errorResponse(readOnlyError);
    }
  } catch (error) {
    return errorResponse(toErrorMessage(error));
  }

  let resolvedOutput;
  try {
    resolvedOutput = await resolveOutputPath(parsedInput.outputFile);
  } catch (error) {
    return errorResponse(toErrorMessage(error));
  }
  if (parsedInput.ifExists === "error") {
    try {
      await fs.access(resolvedOutput.absolutePath);
      return errorResponse(`Output file already exists: ${resolvedOutput.relativePath}`);
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== "ENOENT") {
        return errorResponse(toErrorMessage(error));
      }
    }
  }

  const controller = new AbortController();
  const signal = combineAbortSignals(controller.signal, externalSignal);
  const timeout = setTimeout(() => controller.abort(BULK_EXPORT_TIMEOUT_MESSAGE), BULK_EXPORT_TIMEOUT_MS);

  try {
    const result = await runBulkExport({
      toolName: parsedInput.toolId,
      args: parsedInput.args,
      absoluteOutputFile: resolvedOutput.absolutePath,
      relativeOutputFile: resolvedOutput.relativePath,
      ifExists: parsedInput.ifExists,
      itemsPath: parsedInput.itemsPath,
      maxPages: parsedInput.maxPages,
      signal,
      pagination: parsedInput.pagination,
      executeTool: async (toolName, args) => {
        try {
          const client = await registry.getClient(parsedInput.packageId);
          const toolResult = await Promise.race([
            client.callTool(toolName, args),
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new Error(getAbortMessage(signal)));
                return;
              }
              signal.addEventListener(
                "abort",
                () => reject(new Error(getAbortMessage(signal))),
                { once: true },
              );
            }),
          ]);
          registry.notifyActivity(parsedInput.packageId);
          return extractMcpTextResult(toolResult);
        } catch (error) {
          logger.warn("bulk_export tool call failed", {
            package_id: parsedInput.packageId,
            tool_id: toolName,
            error: toErrorMessage(error),
          });
          return {
            output: toErrorMessage(error),
            isError: true,
          };
        }
      },
    });

    return successResponse(result);
  } catch (error) {
    logger.warn("bulk_export failed", {
      package_id: parsedInput.packageId,
      tool_id: parsedInput.toolId,
      error: toErrorMessage(error),
    });
    return errorResponse(toErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
