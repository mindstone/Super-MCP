import { randomUUID } from "crypto";
import {
  UseToolInput,
  UseToolOutput,
  ERROR_CODES,
  USE_TOOL_META_PARAMS,
  USE_TOOL_SOFT_META_PARAMS,
  type ToolBlockedReason,
} from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import type { ValidationResult } from "../validator.js";
import { McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../logging.js";
import { getSecurityPolicy } from "../security.js";
import { findBestMatch } from "../utils/fuzzyMatch.js";
import {
  coerceStringifiedBoolean,
  coerceStringifiedNumber,
  normalizeArgKeys,
  formatKeyAliasBreadcrumb,
  canonicalKey,
  canonicalKeyNormalize,
  coerceArgsToSchema,
  formatAutoRepairBreadcrumb,
  type AutoRepairBreadcrumb,
} from "../utils/normalizeInput.js";
import { materializeOutput, extractImageContentBlocks, SUPPORTED_IMAGE_MIME_TYPES } from "./materializeOutput.js";
import { parseUseToolInput } from "./useToolInput.js";

const logger = getLogger();

function isDownstreamOutputValidationError(error: McpError): boolean {
  let dataText = "";
  if (error.data !== undefined) {
    try {
      dataText = JSON.stringify(error.data);
    } catch {
      dataText = String(error.data);
    }
  }

  const combined = `${error.message}\n${dataText}`;

  return /\boutput\s+validation\b/i.test(combined)
    || /\btool\s+result\s+validation\b/i.test(combined)
    || /\bstructured\s*content\s+validation\b/i.test(combined)
    || /\bstructured\s*content\b[\s\S]{0,160}\boutput\s+schema\b/i.test(combined)
    || /\boutput\s+schema\b[\s\S]{0,160}\bstructured\s*content\b/i.test(combined)
    || /\bfailed\s+to\s+validate\s+structured\s*content\b/i.test(combined);
}

// --- Continuation cache for truncated results ---
interface CachedResult {
  serializedOutput: string;
  totalChars: number;
  createdAt: number;
}

interface ContinuationResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  resultId: string;
}
const RESULT_CACHE_MAX_SIZE = 50;
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const resultCache = new Map<string, CachedResult>();

function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of resultCache) {
    if (now - entry.createdAt > RESULT_CACHE_TTL_MS) {
      resultCache.delete(key);
    }
  }
}

function cacheResult(id: string, serialized: string): void {
  evictExpiredEntries();
  if (resultCache.size >= RESULT_CACHE_MAX_SIZE) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of resultCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) resultCache.delete(oldestKey);
  }
  resultCache.set(id, { serializedOutput: serialized, totalChars: serialized.length, createdAt: Date.now() });
}

function getCachedResult(id: string): CachedResult | undefined {
  const entry = resultCache.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > RESULT_CACHE_TTL_MS) {
    resultCache.delete(id);
    return undefined;
  }
  return entry;
}

function handleContinuation(
  resultId: string,
  offset: number,
  maxOutputChars: number | null | undefined,
): ContinuationResult {
  if (offset < 0 || !Number.isFinite(offset)) {
    return { content: [{ type: "text", text: `Error: output_offset must be a non-negative number (got ${offset}).` }], isError: true, resultId };
  }
  const cached = getCachedResult(resultId);
  if (!cached) {
    return { content: [{ type: "text", text: "Cached result expired or not found. Please re-run the original tool call." }], isError: true, resultId };
  }
  if (offset >= cached.totalChars) {
    return { content: [{ type: "text", text: `No more data (offset ${offset} >= total ${cached.totalChars} chars).` }], isError: false, resultId };
  }
  const effectiveLimit = maxOutputChars === null ? undefined : (maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const chunkEnd = effectiveLimit !== undefined ? Math.min(offset + effectiveLimit, cached.totalChars) : cached.totalChars;
  const chunk = cached.serializedOutput.slice(offset, chunkEnd);
  const hasMore = chunkEnd < cached.totalChars;
  const response = {
    continuation: true,
    result_id: resultId,
    offset,
    length: chunk.length,
    total_chars: cached.totalChars,
    has_more: hasMore,
    content: chunk,
  };
  let text = JSON.stringify(response, null, 2);
  if (hasMore) {
    text += `\n\n[To get the next chunk: use_tool({ package_id: "_", tool_id: "_", args: {}, result_id: "${resultId}", output_offset: ${chunkEnd} })]`;
  }
  return { content: [{ type: "text", text }], isError: false, resultId };
}
const LARGE_OUTPUT_WARNING_THRESHOLD = 150_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

// Materialization threshold: save outputs > 20K chars to file instead of keeping in context.
// Separate from DEFAULT_MAX_OUTPUT_CHARS (100K) which drives truncation + continuation chunk size.
// With auto-materialization, data isn't lost — it's saved to .rebel/tool-outputs/ for Read/Grep access.
const MATERIALIZATION_THRESHOLD_CHARS = 20_000;

// Safety net threshold: if serialized output exceeds this after all truncation,
// replace with placeholder + continuation. Set above the default truncation limit
// to allow envelope overhead, but with a minimum floor for small custom limits.
const SERIALIZED_OUTPUT_SAFETY_NET_FLOOR = 200_000;
const MAX_SCHEMA_FRAGMENTS = 5;
const FULL_SCHEMA_FRAGMENT_KEY = "__full_schema";
const FULL_SCHEMA_THRESHOLD = 2;
export const STOP_RETRYING_THRESHOLD = 3;
/**
 * Terminal guidance appended once `STOP_RETRYING_THRESHOLD` failed attempts are
 * reached on a call the handler cannot classify further.
 *
 * REBEL-7JD reworded this: it used to say "Arguments may require user
 * clarification. Please ask the user for specifics." — which routed a
 * self-fixable call-shape mistake to a non-technical user. The message now tells
 * the model to change the call or report what failed.
 *
 * CROSS-REPO: the host app substring-matches this text to route the terminal
 * inbox affordance (`isArgValidationExhausted` in the superproject's
 * src/renderer/features/inbox/hooks/usePendingApprovals.ts). Rewording it again
 * requires updating that classifier in the same change, or the terminal state
 * silently becomes unreachable.
 */
const STOP_RETRYING_MESSAGE =
  "These arguments have failed validation several times. Stop re-sending the same call shape — change the call or report what failed.";

/**
 * Terminal guidance for the MISPLACED-meta-param case, which the shared message
 * above fits badly: the model can fix this itself in one move, so telling it to
 * "report what failed" would strand a recoverable call (REBEL-7JD).
 *
 * CROSS-REPO (reciprocal of the note on `STOP_RETRYING_MESSAGE` above): this line
 * must NOT match `isArgValidationExhausted` in the superproject's
 * src/renderer/features/inbox/hooks/usePendingApprovals.ts. That classifier keys on
 * "stop re-sending the same call shape"; this message says "this call shape" — the
 * one-word distance is LOAD-BEARING, not incidental phrasing. Rewording this to
 * "the same call shape" would silently flip a user-facing inbox state, surfacing
 * the terminal "Rebel needs a bit more from you" copy for a call-shape mistake the
 * user did not make and cannot fix. A negative test pins the non-match
 * (usePendingApprovals.test.ts).
 */
function buildMisplacedStopRetryingMessage(misplacedParams: string[]): string {
  const names = misplacedParams.join(", ");
  const subject = misplacedParams.length === 1 ? `${names} belongs` : `${names} belong`;
  return (
    `Stop re-sending this call shape; ${subject} at the top level of use_tool, ` +
    `outside \`args\` — re-issue once with it moved, or drop it and proceed.`
  );
}
const MAX_ATTEMPT_MAP_SIZE = 500;
const validationAttemptMap = new Map<string, number>();

interface RepairTicket {
  missing_required: string[];
  type_errors: Array<{ field: string; expected: string; got: string; value?: unknown }>;
  enum_violations: Array<{ field: string; allowed: unknown[]; got: unknown }>;
  format_errors: Array<{ field: string; expected: string; got: unknown }>;
  range_errors?: Array<{ field: string; constraint: string; limit: number; got: unknown }>;
  pattern_errors?: Array<{ field: string; pattern: string; got: unknown }>;
  length_errors?: Array<{ field: string; constraint: string; limit: number; got: unknown }>;
  unknown_fields: string[];
  /**
   * `use_tool` meta-params (types.ts USE_TOOL_META_PARAMS) the model nested inside
   * `args` instead of passing at the top level (REBEL-7JD). Subtracted from
   * `unknown_fields` so the ticket never tells the model to drop a param it
   * should move. OPTIONAL and additive-only: the inline downstream-InvalidParams
   * ticket literal below omits it, and host-side consumers must not require it.
   *
   * Secondary carrier only — the prose in `message` is the truncation-safe one
   * (the host caps the JOINED error string at 2000 chars, tail-first).
   *
   * In practice only the SOFT meta-params (`dry_run`, `result_id`) can appear
   * here: the hard-reject three are stopped earlier at the envelope guard
   * (useToolInput.ts rejectMisplacedMetaParams), so a nested occurrence of those
   * never reaches the validator to be stripped and classified into this field.
   */
  misplaced_params?: string[];
  did_you_mean: Record<string, string>;
  schema_fragments: Record<string, unknown>;
  valid_fields: string[];
  attempt: number;
  downstream_error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ConnectDiagnosticErrorClass =
  | "connect_timeout"
  | "connection_closed"
  | "spawn_error"
  | "other";

interface ConnectDiagnosticSummary {
  attempt: number;
  spawnObservedThisCall?: boolean;
  childCloseObserved?: boolean;
  childExitCode?: number | null;
  stderrPresent?: boolean;
  errorClass: ConnectDiagnosticErrorClass;
}

const CONNECT_DIAGNOSTIC_KEYS = [
  "spawnObservedThisCall",
  "spawnError",
  "childCloseObserved",
  "childExitCode",
  "stderrTail",
] as const;
const CONNECT_DIAGNOSTIC_ERROR_CLASSES = new Set<ConnectDiagnosticErrorClass>([
  "connect_timeout",
  "connection_closed",
  "spawn_error",
  "other",
]);

function deriveConnectDiagnosticSummary(
  value: unknown,
  inferredAttempt: number,
  errorMessage?: string,
): ConnectDiagnosticSummary | undefined {
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const hasConnectDiagnosticField = CONNECT_DIAGNOSTIC_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    );
    if (!hasConnectDiagnosticField) {
      return undefined;
    }

    const sourceAttempt = value.attempt;
    const attempt =
      sourceAttempt === 1 || sourceAttempt === 2
        ? sourceAttempt
        : inferredAttempt;
    const spawnObservedThisCall =
      typeof value.spawnObservedThisCall === "boolean"
        ? value.spawnObservedThisCall
        : undefined;
    const childCloseObserved =
      typeof value.childCloseObserved === "boolean"
        ? value.childCloseObserved
        : undefined;
    const childExitCode =
      value.childExitCode === null ||
      (typeof value.childExitCode === "number" &&
        Number.isSafeInteger(value.childExitCode))
        ? value.childExitCode
        : undefined;
    const stderrPresent =
      typeof value.stderrTail === "string"
        ? value.stderrTail.length > 0
        : undefined;

    let errorClass: ConnectDiagnosticErrorClass = "other";
    if (
      typeof value.errorClass === "string" &&
      CONNECT_DIAGNOSTIC_ERROR_CLASSES.has(
        value.errorClass as ConnectDiagnosticErrorClass,
      )
    ) {
      errorClass = value.errorClass as ConnectDiagnosticErrorClass;
    } else if (
      typeof value.spawnError === "string" &&
      value.spawnError.trim().length > 0
    ) {
      errorClass = "spawn_error";
    } else if (
      typeof errorMessage === "string" &&
      /\b(?:ENOENT|EACCES)\b|command not found|permission denied/i.test(
        errorMessage,
      )
    ) {
      errorClass = "spawn_error";
    } else if (
      typeof errorMessage === "string" &&
      /request timed out|connection timed out|connect timeout|ETIMEDOUT|-32001/i.test(
        errorMessage,
      )
    ) {
      errorClass = "connect_timeout";
    } else if (
      childCloseObserved === true ||
      (typeof errorMessage === "string" &&
        /connection (?:was )?closed|transport closed|ConnectionClosed/i.test(
          errorMessage,
        ))
    ) {
      errorClass = "connection_closed";
    }

    return {
      attempt,
      ...(spawnObservedThisCall !== undefined
        ? { spawnObservedThisCall }
        : {}),
      ...(childCloseObserved !== undefined ? { childCloseObserved } : {}),
      ...(childExitCode !== undefined ? { childExitCode } : {}),
      ...(stderrPresent !== undefined ? { stderrPresent } : {}),
      errorClass,
    };
  } catch {
    // Malformed diagnostics must never mask the original downstream error.
    return undefined;
  }
}

function deriveAllowlistedConnectDiagnostics(
  error: unknown,
  errorMessage: string,
): {
  connect_summary?: ConnectDiagnosticSummary;
  first_attempt_summary?: ConnectDiagnosticSummary;
} {
  try {
    if (!isRecord(error)) {
      return {};
    }
    const data = error.data;
    if (!isRecord(data)) {
      return {};
    }

    let firstAttemptData: unknown;
    try {
      firstAttemptData = data.firstAttempt;
    } catch {
      firstAttemptData = undefined;
    }
    const firstAttemptSummary = deriveConnectDiagnosticSummary(
      firstAttemptData,
      1,
    );
    const connectSummary = deriveConnectDiagnosticSummary(
      data,
      firstAttemptSummary ? 2 : 1,
      errorMessage,
    );

    return {
      ...(connectSummary ? { connect_summary: connectSummary } : {}),
      ...(firstAttemptSummary
        ? { first_attempt_summary: firstAttemptSummary }
        : {}),
    };
  } catch {
    // This is diagnostic-only enrichment; the original failure still surfaces.
    return {};
  }
}

/**
 * Spec-conformant passthrough fields hoisted onto super-mcp's outer use_tool
 * response block. The MCP spec carries `_meta` and `structuredContent` on the
 * outer tool_result envelope; super-mcp wraps results into a single text block
 * for the model, but downstream consumers (agentMessageHandler, MCP App view,
 * mobile/cloud DTOs) read these fields off the OUTER block per spec.
 *
 * See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md and the
 * `super-mcp-passthrough` boundary registry entry.
 */
interface OuterPassthroughMeta {
  /** Hoisted from inner._meta.ui when shaped like a usable McpAppUiMeta record. */
  ui?: Record<string, unknown>;
  /** Hoisted from inner.structuredContent (type-opaque). */
  structuredContent?: unknown;
}

interface SuperMcpResolution {
  from: string;
  to: string;
}

interface SuperMcpTelemetryMeta {
  packageId: string;
  toolId: string;
  durationMs: number;
  outputChars?: number;
  truncated?: boolean;
  resultId?: string;
  dryRun?: boolean;
  continuation?: boolean;
  staged?: boolean;
  /** Argument-shape normalisations applied (e.g. "coerce_undefined_args"). */
  normalisations?: string[];
  /** Package alias resolution (e.g. bare "GoogleWorkspace" -> instance id). */
  packageResolution?: SuperMcpResolution;
  /** Bare-tool-name resolution across packages. */
  toolResolution?: SuperMcpResolution & { packageId: string };
}

interface MaterializationMeta {
  status: "materialized" | "oversized_output";
  originalChars?: number;
  filePath?: string;
  imageFiles?: string[];
}

/**
 * Extract `_meta.ui` and `structuredContent` from the inner downstream tool
 * result. Only hoists `_meta.ui` when shaped like a usable record (non-array
 * object with non-empty string `resourceUri`); malformed shapes are dropped.
 * Returns the snapshot to be applied by `applyOuterMeta` to the use_tool
 * outer return block on every code path.
 *
 * IMPORTANT: capture this BEFORE truncation/safety-net rewrites — the
 * passthrough fields belong to the original inner envelope.
 */
function extractInnerPassthroughMeta(toolResult: unknown): OuterPassthroughMeta {
  if (!isRecord(toolResult)) return {};
  const meta: OuterPassthroughMeta = {};

  if (toolResult.structuredContent !== undefined) {
    meta.structuredContent = toolResult.structuredContent;
  }

  const innerMeta = toolResult._meta;
  if (isRecord(innerMeta) && isRecord(innerMeta.ui)) {
    const ui = innerMeta.ui;
    const resourceUri = ui.resourceUri;
    if (typeof resourceUri === "string" && resourceUri.length > 0) {
      meta.ui = ui;
    }
  }

  return meta;
}

/**
 * Apply the hoisted passthrough fields plus super-mcp's own telemetry/materialisation
 * namespaces onto the outer use_tool response block. See
 * docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md for the full schema.
 *
 * - Always emits `_meta.superMcp`.
 * - Conditionally emits `_meta.ui` (only when present and the result is not an error).
 * - Conditionally emits `_meta.materialization` (only when materialisation fired).
 * - Hoists `structuredContent` to the outer block when present and not an error.
 */
// INVARIANT: The only caller of this function is buildOuter. See SUPER_MCP_PASSTHROUGH_CONTRACT.md § Single-egress invariant.
function applyOuterMeta(
  outer: { content: Array<unknown>; isError?: boolean; _meta?: Record<string, unknown>; structuredContent?: unknown },
  options: {
    passthrough: OuterPassthroughMeta;
    superMcp: SuperMcpTelemetryMeta;
    materialization?: MaterializationMeta;
    isError: boolean;
  },
): void {
  const meta: Record<string, unknown> = {
    superMcp: {
      packageId: options.superMcp.packageId,
      toolId: options.superMcp.toolId,
      durationMs: options.superMcp.durationMs,
      ...(options.superMcp.outputChars !== undefined ? { outputChars: options.superMcp.outputChars } : {}),
      ...(options.superMcp.truncated !== undefined ? { truncated: options.superMcp.truncated } : {}),
      ...(options.superMcp.resultId !== undefined ? { resultId: options.superMcp.resultId } : {}),
      ...(options.superMcp.dryRun ? { dryRun: true } : {}),
      ...(options.superMcp.continuation ? { continuation: true } : {}),
      ...(options.superMcp.staged ? { staged: true } : {}),
      ...(options.superMcp.normalisations && options.superMcp.normalisations.length > 0
        ? { normalisations: options.superMcp.normalisations }
        : {}),
      ...(options.superMcp.packageResolution ? { packageResolution: options.superMcp.packageResolution } : {}),
      ...(options.superMcp.toolResolution ? { toolResolution: options.superMcp.toolResolution } : {}),
    },
  };

  // Spec passthrough only applied to non-error results: an inner error envelope
  // is malformed by definition; surfacing its _meta.ui / structuredContent on
  // the outer block would mis-route consumers.
  if (!options.isError && options.passthrough.ui) {
    meta.ui = options.passthrough.ui;
  }

  if (options.materialization) {
    meta.materialization = options.materialization;
  }

  outer._meta = meta;

  if (!options.isError && options.passthrough.structuredContent !== undefined) {
    outer.structuredContent = options.passthrough.structuredContent;
  }
}

interface UseToolOuter {
  content: Array<unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

function buildOuter(args: {
  content: Array<unknown>;
  isError: boolean;
  superMcp: SuperMcpTelemetryMeta & { dryRun?: boolean; continuation?: boolean; staged?: boolean };
  passthrough?: OuterPassthroughMeta;
  materialization?: MaterializationMeta;
}): UseToolOuter {
  const outer: UseToolOuter = {
    content: args.content,
    isError: args.isError,
  };
  applyOuterMeta(outer, {
    passthrough: args.passthrough ?? {},
    superMcp: args.superMcp,
    ...(args.materialization ? { materialization: args.materialization } : {}),
    isError: args.isError,
  });
  return outer;
}

interface TextContentBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function truncateToolResultTextContent(
  toolResult: unknown,
  requestedLimit: number,
): { toolResult: unknown; truncated: boolean } {
  if (!isRecord(toolResult) || !Array.isArray(toolResult.content)) {
    return { toolResult, truncated: false };
  }

  const normalizedLimit = Math.max(0, Math.floor(requestedLimit));
  const content = toolResult.content;
  const totalTextChars = content.reduce((total, block) => {
    if (!isTextContentBlock(block)) {
      return total;
    }
    return total + block.text.length;
  }, 0);

  if (totalTextChars <= normalizedLimit) {
    return { toolResult, truncated: false };
  }

  const truncationMessage = `\n\n[Result truncated to ${normalizedLimit} chars. Re-run with larger max_output_chars if you need the full output, or pass null for unlimited.]`;
  let remainingChars = normalizedLimit;
  let messageAppended = false;

  const truncatedContent = content.map((block) => {
    if (!isTextContentBlock(block)) {
      return block;
    }

    if (remainingChars > 0) {
      if (block.text.length <= remainingChars) {
        remainingChars -= block.text.length;
        return block;
      }

      const truncatedText = block.text.slice(0, remainingChars);
      remainingChars = 0;
      messageAppended = true;
      return {
        ...block,
        text: `${truncatedText}${truncationMessage}`,
      };
    }

    if (!messageAppended) {
      messageAppended = true;
      return {
        ...block,
        text: truncationMessage,
      };
    }

    return {
      ...block,
      text: "",
    };
  });

  return {
    toolResult: {
      ...toolResult,
      content: truncatedContent,
    },
    truncated: true,
  };
}

function getValidationAttemptKey(packageId: string, toolId: string): string {
  return `${packageId}::${toolId}`;
}

function incrementValidationAttempt(key: string): number {
  if (validationAttemptMap.size >= MAX_ATTEMPT_MAP_SIZE) {
    validationAttemptMap.clear();
  }
  const attempt = (validationAttemptMap.get(key) ?? 0) + 1;
  validationAttemptMap.set(key, attempt);
  return attempt;
}

function resetValidationAttempt(key: string): void {
  validationAttemptMap.delete(key);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseInstancePath(instancePath: string | undefined): string[] {
  if (!instancePath) {
    return [];
  }

  return instancePath
    .split("/")
    .filter(Boolean)
    .map(decodeJsonPointerSegment);
}

function formatFieldPath(segments: string[]): string {
  return segments.length > 0 ? segments.join(".") : "root";
}

function getFieldFromValidationError(validationError: any): string {
  return formatFieldPath(parseInstancePath(validationError.instancePath));
}

function getRequiredFieldFromValidationError(validationError: any): string {
  const segments = parseInstancePath(validationError.instancePath);
  const missingProperty = validationError?.params?.missingProperty;
  if (typeof missingProperty === "string" && missingProperty.length > 0) {
    segments.push(missingProperty);
  }
  return formatFieldPath(segments);
}

function getTopLevelField(fieldPath: string): string | null {
  if (!fieldPath || fieldPath === "root") {
    return null;
  }
  return fieldPath.split(".")[0] || null;
}

function getValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function getValidationLimit(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

function buildSchemaFragments(
  schema: unknown,
  failingFields: Set<string>,
  includeFullSchema: boolean,
): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {};
  }

  if (includeFullSchema) {
    return {
      [FULL_SCHEMA_FRAGMENT_KEY]: schema,
    };
  }

  const schemaProperties = isRecord(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const fragments: Record<string, unknown> = {};

  for (const field of failingFields) {
    if (Object.keys(fragments).length >= MAX_SCHEMA_FRAGMENTS) {
      break;
    }

    const topLevelField = getTopLevelField(field);
    if (!topLevelField || fragments[topLevelField] !== undefined) {
      continue;
    }

    const fragment = schemaProperties[topLevelField];
    if (fragment !== undefined) {
      fragments[topLevelField] = fragment;
    }
  }

  return fragments;
}

/**
 * How a misplaced meta-param must be corrected, mirroring the envelope guard's
 * top-level-absence condition (`rejectMisplacedMetaParams` in useToolInput.ts).
 *
 * `move`   — absent at top level: the model must lift it out of `args`.
 * `remove` — ALREADY present at top level: the top-level value is the one being
 *            honoured, so "move it" would be wrong advice; the nested copy is
 *            simply surplus and must be deleted (reviewer-kimi F4).
 */
type MisplacedParamFix = "move" | "remove";

/** Names of the `use_tool` meta-params found nested in `args`, with their fix. */
type MisplacedParamMap = Record<string, MisplacedParamFix>;

/**
 * Classify `args` keys that are actually top-level `use_tool` meta-params
 * (REBEL-7JD). Keyed off the FULL `USE_TOOL_META_PARAMS` set, not the hard-reject
 * subset: this is the only path that teaches `dry_run` and `result_id`, which the
 * envelope guard deliberately lets through (see types.ts USE_TOOL_SOFT_META_PARAMS).
 *
 * Two callers supply the candidate key set:
 *   - the stripping path passes `strippedArgs` (the validator's pre-strip key
 *     names — NOT the post-strip `provided_args`, because the validator deletes
 *     unknown keys in place);
 *   - the declared-property gate passes the keys IT computed (residue R1), because
 *     on a permissive schema nothing is stripped and `strippedArgs` is empty.
 */
/**
 * Which `use_tool` meta-params the caller actually supplied at the TOP level.
 * Mirrors the envelope guard's absence condition (`input[param] !== undefined` in
 * useToolInput.ts rejectMisplacedMetaParams) so the ticket and the guard agree on
 * what "already present" means.
 */
function getTopLevelMetaParamPresence(input: unknown): Record<string, boolean> {
  const presence: Record<string, boolean> = {};
  if (!isRecord(input)) {
    return presence;
  }
  for (const param of USE_TOOL_META_PARAMS) {
    presence[param] = input[param] !== undefined;
  }
  return presence;
}

function classifyMisplacedMetaParams(
  candidateKeys: readonly string[],
  topLevelPresence: Record<string, boolean> | undefined,
): MisplacedParamMap {
  const misplaced: MisplacedParamMap = {};
  for (const key of candidateKeys) {
    if (!(USE_TOOL_META_PARAMS as readonly string[]).includes(key)) continue;
    misplaced[key] = topLevelPresence?.[key] ? "remove" : "move";
  }
  return misplaced;
}

/**
 * Soft `use_tool` meta-params (`dry_run`, `result_id`) present in `args` that the
 * tool's schema does NOT declare — i.e. the misplacement pattern (REBEL-7JD
 * residue R1).
 *
 * WHY DECLARED-PROPERTY, not "will the validator strip this": the stripping
 * question leaves a silent-dispatch hole. On a permissive schema
 * (`additionalProperties: true`, or no `properties` at all) a nested `dry_run`
 * validates clean and used to reach the downstream tool — so a model asking for a
 * dry run executed a real mutation. The right question is whether the tool
 * declares the parameter: if it does, the key is a legitimate tool argument; if it
 * does not, it is the misplacement pattern and must be taught, never dispatched.
 *
 * Scope is the SOFT pair ONLY (plan Amendment A / reviewer-opus F3). The hard three
 * (max_output_chars, output_offset, schema_hash) are handled at the envelope layer
 * (useToolInput.ts rejectMisplacedMetaParams) and keep their top-level-twin escape
 * hatch — widening this gate to cover them would silently revoke it.
 *
 * CANONICAL TWINS are NOT dispatched verbatim — they are RENAMED first (DA F1).
 * A schema declaring `dryRun` legitimises a nested `dry_run`, so the gate must not
 * throw on that working call. But the earlier design (subtract the twin, dispatch
 * the literal key) re-opened the very hole this gate exists to close: on a
 * permissive schema (`additionalProperties: true`) the nested `dry_run` validates
 * clean, so the auto-repair seam's condition (`!isValid || strippedArgs.length > 0`)
 * is false and `canonicalKeyNormalize` never runs — the tool then received the
 * unknown `dry_run`, ignored it, kept its own `dryRun` default (false) and MUTATED
 * FOR REAL. So this gate performs the rename itself: `dry_run` → declared `dryRun`.
 *
 * The rename fixes the SPELLING; the seam then RE-PROVES THE VALUE against the
 * declared property before dispatching (R10 — see the rename block in
 * `handleUseTool`). Only then are both readings of the call safe: if the model meant
 * the tool's own `dryRun`, the spelling is fixed and the value is known-valid; if it
 * meant use_tool's dry-run, the tool does a dry run and nothing mutates. A
 * type-mismatched twin (`{result_id: 42}` against a declared `resultId: string`) is
 * NOT a decidable intent — it is taught, not dispatched.
 *
 * A twin is only renamed when the intent is DECIDABLE:
 *   - exactly ONE declared property shares the canonical form (ambiguous twins are
 *     pathological — e.g. `dryRun` and `dry-run` both declared), and
 *   - the target key is not already present in `args` (renaming would clobber an
 *     explicit value), and
 *   - the renamed shape re-validates cleanly against the schema (R10; decided at the
 *     seam, which owns the validator, not in this classifier).
 * Otherwise the param is reported as misplaced, so the call fails VISIBLY with the
 * teaching ticket rather than guessing or silently passing through.
 *
 * Evaluate on the POST-repair effective `args` (the keys actually about to be
 * dispatched), not on the pre-validation snapshot.
 */
type SoftMetaParamGateResult = {
  /** Soft meta-params that must be taught (not declared, no decidable twin). */
  misplaced: string[];
  /** Canonical-twin renames to apply to the dispatched args before sending. */
  renames: { from: string; to: string }[];
};

function classifySoftMetaParamsForDispatch(
  effectiveArgs: unknown,
  schema: unknown,
): SoftMetaParamGateResult {
  const result: SoftMetaParamGateResult = { misplaced: [], renames: [] };
  if (!isRecord(effectiveArgs)) {
    return result;
  }
  const declared = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const declaredKeys = Object.keys(declared);

  for (const param of USE_TOOL_SOFT_META_PARAMS) {
    if (!(param in effectiveArgs)) continue;
    // Literally declared → a legitimate tool argument, untouched.
    if (param in declared) continue;
    const target = canonicalKey(param);
    const twins = declaredKeys.filter((key) => canonicalKey(key) === target);
    if (twins.length !== 1) {
      // No twin at all, or an ambiguous one: teach, never dispatch.
      result.misplaced.push(param);
      continue;
    }
    const to = twins[0]!;
    if (Object.prototype.hasOwnProperty.call(effectiveArgs, to)) {
      // The declared spelling already carries a value; renaming would clobber it
      // and the model's intent is undecidable. Fail visible.
      result.misplaced.push(param);
      continue;
    }
    result.renames.push({ from: param, to });
  }
  return result;
}

/**
 * Tool+param pairs the collision warn (i) has already fired for. The warn is a
 * wake-up signal (does any real tool declare a meta-param name?), not a per-call
 * metric, so once per tool+param is the useful cardinality (REBEL-7JD residue R8).
 * Unbounded growth is bounded in practice by the tool catalogue size × 2 soft params.
 */
const metaParamCollisionWarned = new Set<string>();

function summarizeMisplacedParams(misplaced: MisplacedParamMap): string[] {
  const names = Object.keys(misplaced);
  if (names.length === 0) {
    return [];
  }

  const sections: string[] = [
    `Misplaced use_tool parameters: ${names.join(", ")}.`,
    `These are top-level use_tool parameters, not tool arguments — ` +
      `move them outside "args": ` +
      `use_tool({ package_id: "...", tool_id: "...", args: {...}, <name>: <value> }).`,
  ];

  for (const name of names) {
    const instruction =
      misplaced[name] === "remove"
        ? `${name}: remove it from "args"; the top-level value is the one used.`
        : `${name}: move it outside "args".`;
    sections.push(instruction);
    if (name === "result_id") {
      // Warn the model off the trap: result_id at the top level is a CONTINUATION
      // call, which returns cached output without invoking the tool at all
      // (useTool.ts continuation branch). arbitrator-recall F7.
      sections.push(
        "Note: passing result_id at the top level makes this a continuation call — the tool will not run.",
      );
    }
  }

  return sections;
}

function summarizeRepairTicket(
  packageId: string,
  toolId: string,
  ticket: RepairTicket,
  includeStopRetryingGuidance: boolean,
  misplaced: MisplacedParamMap = {},
): string {
  const sections: string[] = [];

  // REBEL-7JD: the misplacement teaching LEADS the substantive sections so the
  // model reads it first (salience). Truncation safety comes from being in
  // `message` at all, not from the ordering — the host caps the joined string.
  sections.push(...summarizeMisplacedParams(misplaced));

  if (ticket.missing_required.length > 0) {
    sections.push(`Missing required: ${ticket.missing_required.join(", ")}.`);
  }

  if (ticket.type_errors.length > 0) {
    const details = ticket.type_errors
      .map((entry) => `${entry.field} (expected ${entry.expected}, got ${entry.got})`)
      .join("; ");
    sections.push(`Type errors: ${details}.`);
  }

  if (ticket.enum_violations.length > 0) {
    const details = ticket.enum_violations
      .map((entry) => `${entry.field} (allowed ${entry.allowed.map(String).join(", ")}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Enum violations: ${details}.`);
  }

  if (ticket.format_errors.length > 0) {
    const details = ticket.format_errors
      .map((entry) => `${entry.field} (expected ${entry.expected}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Format errors: ${details}.`);
  }

  const rangeErrors = ticket.range_errors ?? [];
  if (rangeErrors.length > 0) {
    const details = rangeErrors
      .map((entry) => `${entry.field} (${entry.constraint}: ${entry.limit}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Range errors: ${details}.`);
  }

  const patternErrors = ticket.pattern_errors ?? [];
  if (patternErrors.length > 0) {
    const details = patternErrors
      .map((entry) => `${entry.field} (must match ${entry.pattern}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Pattern errors: ${details}.`);
  }

  const lengthErrors = ticket.length_errors ?? [];
  if (lengthErrors.length > 0) {
    const details = lengthErrors
      .map((entry) => `${entry.field} (${entry.constraint}: ${entry.limit}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Length errors: ${details}.`);
  }

  if (ticket.unknown_fields.length > 0) {
    const details = ticket.unknown_fields
      .map((field) => {
        const suggestion = ticket.did_you_mean[field];
        return suggestion ? `${field} (did you mean: ${suggestion}?)` : field;
      })
      .join(", ");
    sections.push(`Unknown fields: ${details}.`);

    if (ticket.valid_fields.length > 0) {
      sections.push(`Valid arguments: ${ticket.valid_fields.join(", ")}.`);
    } else {
      sections.push(`This tool takes no arguments. Call it with an empty object: {}.`);
    }
  }

  let message = `Argument validation failed for tool '${toolId}' in package '${packageId}'.`;
  if (sections.length > 0) {
    message += ` ${sections.join(" ")}`;
  }
  if (includeStopRetryingGuidance) {
    const misplacedNames = Object.keys(misplaced);
    // A misplacement is self-fixable in one move, so the shared "report what
    // failed" guidance fits badly — emit the misplacement-specific terminal line
    // instead (REBEL-7JD). The downstream-InvalidParams site cannot classify and
    // keeps the shared constant.
    message +=
      misplacedNames.length > 0
        ? ` ${buildMisplacedStopRetryingMessage(misplacedNames)}`
        : ` ${STOP_RETRYING_MESSAGE}`;
  }
  return message;
}

function buildRepairTicket(
  schema: unknown,
  validationErrors: any[],
  strippedArgs: string[],
  attempt: number,
  /**
   * `use_tool` meta-params found nested in `args`, with the fix each needs
   * (REBEL-7JD). Computed once by the caller via `classifyMisplacedMetaParams`
   * and shared with `summarizeRepairTicket` so ticket and prose cannot disagree.
   * Omitted → no misplacement (keeps existing call shapes valid).
   */
  misplacedParams: MisplacedParamMap = {},
): RepairTicket {
  const missingRequired: string[] = [];
  const typeErrors: Array<{ field: string; expected: string; got: string; value?: unknown }> = [];
  const enumViolations: Array<{ field: string; allowed: unknown[]; got: unknown }> = [];
  const formatErrors: Array<{ field: string; expected: string; got: unknown }> = [];
  const rangeErrors: Array<{ field: string; constraint: string; limit: number; got: unknown }> = [];
  const patternErrors: Array<{ field: string; pattern: string; got: unknown }> = [];
  const lengthErrors: Array<{ field: string; constraint: string; limit: number; got: unknown }> = [];
  const failingFields = new Set<string>();
  const validFields = isRecord(schema) && isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  const didYouMean: Record<string, string> = {};

  for (const validationError of validationErrors) {
    if (!validationError || typeof validationError !== "object") {
      continue;
    }

    if (validationError.keyword === "required") {
      const field = getRequiredFieldFromValidationError(validationError);
      missingRequired.push(field);
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "type") {
      const field = getFieldFromValidationError(validationError);
      const expected = Array.isArray(validationError.params?.type)
        ? validationError.params.type.join("|")
        : String(validationError.params?.type ?? "unknown");
      const got = getValueType(validationError.data);
      const typeError: { field: string; expected: string; got: string; value?: unknown } = {
        field,
        expected,
        got,
      };
      if (validationError.data !== undefined) {
        typeError.value = validationError.data;
      }
      typeErrors.push(typeError);
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "enum") {
      const field = getFieldFromValidationError(validationError);
      const allowed = Array.isArray(validationError.params?.allowedValues)
        ? validationError.params.allowedValues
        : [];
      enumViolations.push({
        field,
        allowed,
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "format") {
      const field = getFieldFromValidationError(validationError);
      formatErrors.push({
        field,
        expected: String(validationError.params?.format ?? "unknown"),
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }

    if (["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum"].includes(validationError.keyword)) {
      const field = getFieldFromValidationError(validationError);
      rangeErrors.push({
        field,
        constraint: validationError.keyword,
        limit: getValidationLimit(validationError.params?.limit),
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "pattern") {
      const field = getFieldFromValidationError(validationError);
      patternErrors.push({
        field,
        pattern: String(validationError.params?.pattern ?? "unknown"),
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }

    if (["maxLength", "minLength", "maxItems", "minItems"].includes(validationError.keyword)) {
      const field = getFieldFromValidationError(validationError);
      lengthErrors.push({
        field,
        constraint: validationError.keyword,
        limit: getValidationLimit(validationError.params?.limit),
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }
  }

  // REBEL-7JD: a stripped key that is really a top-level use_tool meta-param is
  // MISPLACED, not unknown. Subtract it from unknown_fields so the ticket never
  // carries the contradictory pair "move it outside args" + "drop this unknown
  // field" (and so a no-arg tool doesn't also claim "takes no arguments" about a
  // call whose only surplus key was the meta-param).
  const misplacedNames = Object.keys(misplacedParams);
  const unknownFields = strippedArgs.filter((field) => misplacedParams[field] === undefined);

  for (const unknownField of unknownFields) {
    const suggestion = findBestMatch(unknownField, validFields);
    if (suggestion) {
      didYouMean[unknownField] = suggestion;
      failingFields.add(suggestion);
    }
  }

  const includeFullSchema = attempt >= FULL_SCHEMA_THRESHOLD;

  const repairTicket: RepairTicket = {
    missing_required: missingRequired,
    type_errors: typeErrors,
    enum_violations: enumViolations,
    format_errors: formatErrors,
    unknown_fields: unknownFields,
    ...(misplacedNames.length > 0 ? { misplaced_params: misplacedNames } : {}),
    did_you_mean: didYouMean,
    schema_fragments: buildSchemaFragments(schema, failingFields, includeFullSchema),
    valid_fields: validFields,
    attempt,
  };

  if (rangeErrors.length > 0) {
    repairTicket.range_errors = rangeErrors;
  }

  if (patternErrors.length > 0) {
    repairTicket.pattern_errors = patternErrors;
  }

  if (lengthErrors.length > 0) {
    repairTicket.length_errors = lengthErrors;
  }

  return repairTicket;
}

export async function handleUseTool(
  input: UseToolInput & { _rebel_staged?: boolean; _rebel_staged_message?: string },
  registry: PackageRegistry,
  catalog: Catalog,
  validator: { validate: (schema: any, data: any, context?: { package_id?: string; tool_id?: string }) => ValidationResult }
): Promise<any> {
  // Staged tool calls: the host process (toolSafetyService PreToolUse hook) intercepted
  // this call for deferred user approval. It sets _rebel_staged via updatedInput so the
  // SDK treats the call as "allowed" (preventing sibling-error cascade for parallel calls)
  // while we return immediately without executing the underlying tool.
  // See: src/main/services/toolSafetyService.ts — staging path.
  // This short-circuit MUST run before dispatch validation (parseUseToolInput): the host
  // has already created and broadcast the approval entry by the time we run, so rejecting
  // here would diverge model and user state — validation runs on the approval-replay leg.
  if (typeof input === "object" && input !== null && input._rebel_staged) {
    return buildOuter({
      content: [{ type: "text", text: input._rebel_staged_message ?? "Tool call staged for approval." }],
      isError: false,
      superMcp: {
        packageId: input.package_id,
        toolId: input.tool_id,
        durationMs: 0,
        staged: true,
      },
    });
  }

  input = parseUseToolInput(input);

  // Continuation: retrieve cached truncated result (before any validation/security)
  const { _rebel_staged: _, _rebel_staged_message: __, ...cleanForContinuation } = input;
  if (cleanForContinuation.output_offset !== undefined) {
    cleanForContinuation.output_offset = coerceStringifiedNumber(cleanForContinuation.output_offset, {
      handler: "use_tool",
      field: "output_offset",
    }) as typeof cleanForContinuation.output_offset;
  }
  if (cleanForContinuation.max_output_chars !== undefined) {
    cleanForContinuation.max_output_chars = coerceStringifiedNumber(cleanForContinuation.max_output_chars, {
      handler: "use_tool",
      field: "max_output_chars",
    }) as typeof cleanForContinuation.max_output_chars;
  }
  if (cleanForContinuation.result_id) {
    if (cleanForContinuation.output_offset === undefined || cleanForContinuation.output_offset === null) {
      return { content: [{ type: "text", text: "Error: output_offset is required when using result_id." }], isError: true };
    }
    const continuation = handleContinuation(cleanForContinuation.result_id, cleanForContinuation.output_offset, cleanForContinuation.max_output_chars);
    return buildOuter({
      content: continuation.content,
      isError: continuation.isError,
      superMcp: {
        packageId: cleanForContinuation.package_id,
        toolId: cleanForContinuation.tool_id,
        durationMs: 0,
        resultId: continuation.resultId,
        continuation: true,
      },
    });
  }

  // Strip rebel-internal flags so they never leak to downstream tool handlers
  const { _rebel_staged, _rebel_staged_message, ...cleanInput } = input;

  let { package_id, tool_id, args, dry_run = false, max_output_chars, schema_hash } = cleanInput;

  const normalisations: string[] = [];

  // R1: coerce undefined/null args to {} so no-arg tools (list_*, status, ready, etc.)
  // pass Zod schemas that require an object. Logged once per call as a telemetry breadcrumb.
  // Evidence: 100+ replayed errors per fortnight on `list_workspace_accounts`,
  // `list_slack_workspaces`, `authenticate_*`, etc. — agent omits args entirely and the
  // upstream connector rejects `undefined`. Validator then loops through repair tickets.
  if (args === undefined || args === null) {
    args = {} as typeof args;
    normalisations.push("coerce_undefined_args");
    logger.debug("Coerced undefined/null args to {}", {
      handler: "use_tool",
      package_id,
      tool_id,
    });
  }

  dry_run = coerceStringifiedBoolean(dry_run, { handler: "use_tool", field: "dry_run" }) as typeof dry_run;
  max_output_chars = coerceStringifiedNumber(max_output_chars, {
    handler: "use_tool",
    field: "max_output_chars",
  }) as typeof max_output_chars;

  // Handle namespaced tool IDs for backward compatibility and Claude Code subagent support
  // Tool IDs now follow the format: "PackageName__tool_name"
  // This ensures global uniqueness when multiple packages have identically named tools

  // Case 1: tool_id is namespaced but package_id not provided (e.g., "filesystem__read_file")
  if (tool_id.includes('__') && !package_id) {
    const parts = tool_id.split('__');
    if (parts.length >= 2) {
      package_id = parts[0];
      tool_id = parts.slice(1).join('__');
      logger.debug("Extracted package from namespaced tool_id", {
        original_tool_id: input.tool_id,
        extracted_package_id: package_id,
        extracted_tool_id: tool_id,
      });
    }
  }
  // Case 2: Both package_id provided AND tool_id is namespaced (strip namespace prefix)
  else if (package_id && tool_id.startsWith(`${package_id}__`)) {
    const originalToolId = tool_id;
    tool_id = tool_id.substring(package_id.length + 2);
    logger.debug("Stripped namespace prefix from tool_id", {
      original_tool_id: originalToolId,
      stripped_tool_id: tool_id,
      package_id,
    });
  }

  // R5 — bare tool-name resolver. When the agent omits both package_id and the
  // `Package__` prefix, search every loaded package for a tool registered under
  // this bare name. Unique match wins (breadcrumb); ambiguous match surfaces a
  // structured AMBIGUOUS_TOOL error listing every candidate.
  //
  // Evidence: 58 calls in the 2-week corpus (2026-05-03 -> 2026-05-16) had a
  // bare tool name (search_workspace_emails, get_workspace_email_thread, etc.)
  // without package prefix and hit `client.callTool` against an empty package.
  let toolResolution: { from: string; to: string; packageId: string } | undefined;
  if (!package_id && !tool_id.includes("__")) {
    const matches = catalog.findToolByName(tool_id);
    if (matches.length === 1) {
      const match = matches[0];
      toolResolution = { from: tool_id, to: match.toolId, packageId: match.packageId };
      package_id = match.packageId;
      logger.debug("Resolved bare tool name to single package", {
        tool_id,
        resolved_package_id: match.packageId,
      });
    } else if (matches.length > 1) {
      throw {
        code: ERROR_CODES.TOOL_NOT_FOUND,
        message: `Bare tool name '${tool_id}' matches ${matches.length} loaded packages. Provide an explicit \`package_id\` to disambiguate, or use the \`Package__${tool_id}\` form.`,
        data: {
          tool_id,
          ambiguous: true,
          candidates: matches.map(m => ({ package_id: m.packageId, tool_id: m.toolId })),
        },
      };
    }
  }

  // R2 — bare package-alias resolver. When the agent passes the base server
  // name (e.g. "GoogleWorkspace") instead of a multi-instance package id
  // (e.g. "GoogleWorkspace-greg-work-com"), recover by querying the registry
  // for every package whose id starts with `${alias}-`. Unique match wins
  // (breadcrumb); ambiguous match surfaces ACCOUNT_SELECTION_REQUIRED with
  // the candidate list so the agent can ask the user which account to use.
  //
  // Evidence: 66 `Package not found: GoogleWorkspace` errors in the corpus.
  let packageResolution: { from: string; to: string } | undefined;
  if (package_id && !registry.getPackage(package_id)) {
    const matches = registry.findPackagesByAlias(package_id);
    if (matches.length === 1) {
      const resolved = matches[0];
      packageResolution = { from: package_id, to: resolved.id };
      logger.debug("Resolved bare package alias to single instance", {
        original_package_id: package_id,
        resolved_package_id: resolved.id,
      });
      package_id = resolved.id;
    } else if (matches.length > 1) {
      throw {
        code: ERROR_CODES.PACKAGE_NOT_FOUND,
        message: `Package alias '${package_id}' matches ${matches.length} active accounts. Specify the full package_id (e.g. ${matches.map(m => `'${m.id}'`).join(", ")}).`,
        data: {
          package_id,
          ambiguous: true,
          candidates: matches.map(m => ({ package_id: m.id, name: m.name })),
        },
      };
    }
  }

  // Check if tool is blocked by security policy
  const securityPolicy = getSecurityPolicy();
  const blockCheck = securityPolicy.isToolBlocked(package_id, tool_id);
  if (blockCheck.blocked) {
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: blockCheck.reason || `Tool '${package_id}__${tool_id}' is blocked by security policy`,
      data: { package_id, tool_id, blocked_reason: blockCheck.reason, reason: "security-policy" satisfies ToolBlockedReason },
    };
  }

  // Check if tool is disabled by admin (takes precedence over user preference)
  const packageConfig = registry.getPackage(package_id);
  const catalogId = packageConfig?.catalogId;
  if (securityPolicy.isAdminDisabled(catalogId, tool_id)) {
    logger.warn("Blocked attempt to use admin-disabled tool", {
      package_id,
      tool_id,
      catalog_id: catalogId,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by your organization's administrator`,
      data: { package_id, tool_id, blocked_reason: "Disabled by administrator", admin_disabled: true, reason: "admin-disabled" satisfies ToolBlockedReason },
    };
  }

  // Check if tool is disabled by user preference (separate from security policy)
  if (securityPolicy.isUserDisabled(package_id, tool_id)) {
    logger.warn("Blocked attempt to use user-disabled tool", {
      package_id,
      tool_id,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by user preference. Re-enable it in Settings to use.`,
      data: { package_id, tool_id, blocked_reason: "Disabled by user", user_disabled: true, reason: "user-disabled" satisfies ToolBlockedReason },
    };
  }
  if (!packageConfig) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${package_id}`,
      data: { package_id },
    };
  }

  await catalog.ensurePackageLoaded(package_id);
  const packageStatus = catalog.getPackageStatus(package_id);
  if (packageStatus === "auth_required") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' requires authentication. Run 'authenticate(package_id: "${package_id}")'.`,
      data: { package_id, status: packageStatus },
    };
  }
  if (packageStatus === "setup_incomplete") {
    const reason = catalog.getPackageError(package_id) || "setup_incomplete";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is not set up on this instance. Signing in again will not fix it.`,
      data: { package_id, status: packageStatus, reason },
    };
  }
  if (packageStatus === "error") {
    const reason = catalog.getPackageError(package_id) || "See logs for details";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is unavailable: ${reason}`,
      data: { package_id, status: packageStatus },
    };
  }

  const catalogWithGetTool = catalog as Catalog & {
    getTool?: (packageId: string, toolId: string) => Promise<{ tool?: { inputSchema?: unknown }; schemaHash?: string } | undefined>;
  };
  const cachedTool = typeof catalogWithGetTool.getTool === "function"
    ? await catalogWithGetTool.getTool(package_id, tool_id)
    : undefined;
  const schema = cachedTool?.tool?.inputSchema ?? await catalog.getToolSchema(package_id, tool_id);
  if (!schema) {
    throw {
      code: ERROR_CODES.TOOL_NOT_FOUND,
      message: `Tool not found: ${tool_id} in package ${package_id}`,
      data: { package_id, tool_id },
    };
  }

  // schema_hash handshake (Phase 1: permissive — validate when present, pass through when absent)
  if (schema_hash && cachedTool?.schemaHash) {
    if (schema_hash !== cachedTool.schemaHash) {
      logger.warn(
        "schema_hash mismatch — tool schema may have changed since get_tool_details was called",
        { tool_id, expected: cachedTool.schemaHash, got: schema_hash },
      );
    }
  }

  // R3 — per-tool top-level key-alias normalisation. Rewrites the agent's
  // mistaken key into the canonical key the schema accepts. Post-Stage-0 the
  // alias map holds ONLY the irreducible entries the schema-driven auto-repair
  // below cannot reproduce: true synonyms (limit→count for Slack search/history
  // tools) and nested-target renames (body→properties.hs_note_body for HubSpot).
  // Pure camelCase↔snake_case casing is now handled by canonicalKeyNormalize in
  // the validate-before-send auto-repair seam (see below). Runs after R1/R2/R5 so
  // we know the final package/tool id. Target-wins on collision. See
  // super-mcp/src/config/paramAliasMap.ts for the (shrunk) map and rationale.
  {
    const { args: rewritten, breadcrumbs } = normalizeArgKeys(args, {
      handler: "use_tool",
      package_id,
      tool_id,
    });
    args = rewritten as typeof args;
    for (const entry of breadcrumbs) {
      normalisations.push(formatKeyAliasBreadcrumb(entry));
    }
  }

  // Validate arguments unconditionally (before checking dry_run).
  //
  // Snapshot the args BEFORE validating: `validator.validate` strips unknown
  // top-level keys IN PLACE (documented + tested contract — see validator.ts
  // and test/validator.test.ts), so the pre-strip values must be captured first
  // for the auto-repair pass below. We keep the snapshot approach rather than
  // making the validator non-mutating because in-place stripping is a contract
  // existing callers/tests rely on (MA0b).
  const validationAttemptKey = getValidationAttemptKey(package_id, tool_id);
  const downstreamValidationAttemptKey = `${validationAttemptKey}::downstream`;
  const preValidationSnapshot =
    args && typeof args === "object" && !Array.isArray(args)
      ? (structuredClone(args) as Record<string, unknown>)
      : null;
  const validationResult = validator.validate(schema, args, { package_id, tool_id });
  let strippedArgs = validationResult.strippedArgs;
  let isValid = validationResult.valid;

  // REBEL-7JD observability warn (i) — the COLLISION detector, in two arms:
  // LITERAL (the tool declares a property named exactly like a meta-param) and
  // CANONICAL TWIN (it declares `dryRun` and the call nested `dry_run`; DA F4).
  // Distinct messages so telemetry can tell the two apart; both share the once-set.
  //
  // Reads `preValidationSnapshot`, because `validator.validate` strips unknown keys
  // from `args` IN PLACE. This is the wake-up signal the deferred residue items are
  // conditioned on (PLAN.md § Explicitly out of scope).
  //
  // Warn (ii) (the non-stripping-schema PASSTHROUGH detector) was deleted with the
  // declared-property gate below: for the soft pair the passthrough it warned about
  // is now structurally impossible (the gate throws instead of dispatching), so the
  // warn could only ever have fired on a hard-reject param sneaking in via the
  // envelope escape hatch — which is exactly the case warn (i) already covers.
  //
  // NOTE super-mcp's logger is MESSAGE-FIRST — `warn(msg, data)` (src/logging.ts).
  // This is NOT the superproject's pino `({ data }, msg)` convention.
  if (preValidationSnapshot) {
    const declaredProperties =
      isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
    const declaredKeys = declaredProperties ? Object.keys(declaredProperties) : [];
    for (const param of USE_TOOL_META_PARAMS) {
      if (!(param in preValidationSnapshot)) continue;
      if (!declaredProperties) continue;
      const isLiteralCollision = param in declaredProperties;
      // CANONICAL-TWIN arm (DA F4): the tool declares `dryRun` and the call nested
      // `dry_run`. Not a literal collision, but it IS the twin path the gate below
      // now renames before dispatch — so it must be observable too, and
      // distinguishable from the literal case (different message + declared_property).
      const canonicalTwins = isLiteralCollision
        ? []
        : declaredKeys.filter((key) => canonicalKey(key) === canonicalKey(param));
      if (!isLiteralCollision && canonicalTwins.length === 0) continue;
      // (i) Collision detector: the tool legitimately declares a property whose
      // name equals a use_tool meta-param, so the misplacement teaching would be
      // WRONG for this tool. If this fires for a hard-rejected param, that param
      // must leave USE_TOOL_HARD_REJECT_META_PARAMS.
      //
      // Coverage caveat for a HARD-REJECTED param: a call that nests it WITHOUT a
      // top-level twin is rejected at the envelope guard (rejectMisplacedMetaParams,
      // useToolInput.ts) before this validation seam ever runs — that guard is
      // deliberately schema-independent, so it cannot know about the collision. So
      // for hard-rejected params this warn surfaces collisions ONLY via escape-hatch
      // calls (the top-level twin present, which the guard skips).
      //
      // Once per tool+param (residue R8): a hot tool would otherwise emit this on
      // every call, drowning the signal it exists to raise.
      const collisionKey = `${package_id}:${tool_id}:${param}`;
      if (metaParamCollisionWarned.has(collisionKey)) continue;
      metaParamCollisionWarned.add(collisionKey);
      if (isLiteralCollision) {
        logger.warn("use_tool meta-param name collides with legitimate schema property", {
          handler: "use_tool",
          package_id,
          tool_id,
          param,
        });
      } else {
        logger.warn("use_tool meta-param collides with a CANONICAL TWIN of a schema property", {
          handler: "use_tool",
          package_id,
          tool_id,
          param,
          declared_property: canonicalTwins.length === 1 ? canonicalTwins[0] : canonicalTwins,
        });
      }
    }
  }

  // Stage 0 — deterministic, schema-driven validate-before-send auto-repair.
  // Triggered ONLY when validation fails because of (a) camelCase↔snake_case
  // key casing or (b) stringified scalars. We repair a snapshot, re-validate,
  // and adopt the repaired args ONLY if they now pass cleanly
  // (`valid && strippedArgs.length === 0`). Otherwise we fall through unchanged
  // to the existing -33003 repair-ticket. See normalizeInput.ts (S6 spike).
  if ((!isValid || strippedArgs.length > 0) && preValidationSnapshot) {
    const repaired = structuredClone(preValidationSnapshot) as Record<string, unknown>;
    const repairCrumbs: AutoRepairBreadcrumb[] = [];
    const { breadcrumbs: keyCrumbs } = canonicalKeyNormalize(repaired, schema);
    repairCrumbs.push(...keyCrumbs);
    const { breadcrumbs: coerceCrumbs } = coerceArgsToSchema(repaired, schema);
    repairCrumbs.push(...coerceCrumbs);

    if (repairCrumbs.length > 0) {
      const reValidation = validator.validate(schema, repaired, { package_id, tool_id });
      if (reValidation.valid && reValidation.strippedArgs.length === 0) {
        // Accept the repair: dispatch with the repaired args and record breadcrumbs.
        args = repaired as typeof args;
        isValid = true;
        strippedArgs = [];
        for (const crumb of repairCrumbs) {
          normalisations.push(formatAutoRepairBreadcrumb(crumb));
        }
        logger.info("Auto-repaired tool args (schema-driven validate-before-send)", {
          handler: "use_tool",
          package_id,
          tool_id,
          repairs: repairCrumbs.map(formatAutoRepairBreadcrumb),
        });
      }
    }
  }

  if (!isValid || strippedArgs.length > 0) {
    resetValidationAttempt(downstreamValidationAttemptKey);
    const attempt = incrementValidationAttempt(validationAttemptKey);
    // REBEL-7JD: classify misplaced meta-params ONCE and share the result between
    // the ticket object and the prose, so the two can't disagree. Top-level
    // presence is read from `input` (the parsed envelope) rather than the
    // destructured locals, because `dry_run` is destructured with a `= false`
    // default that would misreport an omitted param as present.
    const misplacedParams = classifyMisplacedMetaParams(
      strippedArgs,
      getTopLevelMetaParamPresence(input),
    );
    const repairTicket = buildRepairTicket(
      schema,
      validationResult.errors,
      strippedArgs,
      attempt,
      misplacedParams,
    );
    const shouldStopRetrying = attempt >= STOP_RETRYING_THRESHOLD;

    throw {
      code: ERROR_CODES.ARG_VALIDATION_FAILED,
      message: summarizeRepairTicket(
        package_id,
        tool_id,
        repairTicket,
        shouldStopRetrying,
        misplacedParams,
      ),
      data: {
        package_id,
        tool_id,
        errors: validationResult.errors,
        provided_args: args ? Object.keys(args) : [],
        repair_ticket: repairTicket,
      },
    };
  }

  // REBEL-7JD residue R1 — DECLARED-PROPERTY misplacement gate.
  //
  // Unconditional seam, deliberately OUTSIDE the teaching branch above: that
  // branch's condition (`!isValid || strippedArgs.length > 0`) is false on exactly
  // the hole path — a nested soft meta-param on a permissive schema validates
  // clean, so nothing was ever taught and the call dispatched (a real mutation for
  // a model that asked for a dry run).
  //
  // Ordering is load-bearing: AFTER validation and the auto-repair seam (so a
  // canonical rename like `dry_run`→declared `dryRun` performed THERE has already
  // happened and this sees the effective args), and BEFORE both the top-level
  // `dry_run` short-circuit and dispatch (so neither a misplacement nor a
  // verbatim canonical twin can ever reach the downstream tool).
  const softParamGate = classifySoftMetaParamsForDispatch(args, schema);

  // DA F1 — normalize-before-dispatch. A decidable canonical twin is RENAMED into
  // the tool's declared spelling here, because on a permissive schema the
  // auto-repair seam above never ran (validation passed clean) and dispatching the
  // literal `dry_run` would let a "dry run" request execute a real mutation.
  //
  // R10 — RE-VALIDATE the renamed shape before committing it. The rename fixes the
  // SPELLING; it cannot prove the VALUE. `{result_id: 42}` against a declared
  // `resultId: {type: "string"}` renames into a type-invalid `{resultId: 42}` that
  // used to be dispatched (on a permissive schema the validation above passed clean,
  // so nothing else could catch it) and then failed differently — and unhelpfully —
  // downstream. So: apply the renames to ONE clone, validate the clone, and adopt it
  // only if it proves clean. Same accept condition as the auto-repair seam above
  // (`valid && strippedArgs.length === 0`).
  //
  // ATOMIC on purpose (kimi F2): all renames are committed together or none are. A
  // per-rename commit would leave `args` partially renamed when a later rename
  // fails, so the ticket's `provided_args` would list keys the model never sent.
  //
  // A CLONE because `validator.validate` strips unknown top-level keys IN PLACE, and
  // the seam ordering invariants depend on `args` mutating exactly once, here.
  //
  // INVARIANT: the pre-rename `args` already validated clean with zero strips —
  // otherwise the teaching branch above threw — so ANY failure of this
  // re-validation is rename-attributable.
  let renameValidationErrors: any[] = [];
  if (softParamGate.renames.length > 0 && isRecord(args)) {
    const candidate = structuredClone(args) as Record<string, unknown>;
    for (const { from, to } of softParamGate.renames) {
      candidate[to] = candidate[from];
      delete candidate[from];
    }
    const renameValidation = validator.validate(schema, candidate, { package_id, tool_id });
    if (renameValidation.valid && renameValidation.strippedArgs.length === 0) {
      args = candidate as typeof args;
      for (const { from, to } of softParamGate.renames) {
        normalisations.push(formatAutoRepairBreadcrumb({ kind: "key", from, to }));
        // NOTE message-first logger (src/logging.ts), NOT pino's ({data}, msg).
        logger.info("Renamed nested soft meta-param to its declared canonical twin", {
          handler: "use_tool",
          package_id,
          tool_id,
          from,
          to,
        });
      }
    } else {
      // The declared property rejects the supplied value, so the twin reading is not a
      // decidable rename after all. `args` stays UNTOUCHED and the affected keys are
      // taught through the established misplacement ticket below — carrying THIS
      // re-validation's Ajv errors, so the ticket names the declared property and its
      // expected type. An empty-errors ticket would teach only 'move it outside
      // "args"', the wrong correction for a type mismatch (opus F4).
      renameValidationErrors = renameValidation.errors;
      for (const { from } of softParamGate.renames) {
        softParamGate.misplaced.push(from);
      }
      logger.warn("Canonical-twin rename rejected by the declared property — teaching, not dispatching", {
        handler: "use_tool",
        package_id,
        tool_id,
        renames: softParamGate.renames.map(({ from, to }) => `${from}->${to}`),
        stripped: renameValidation.strippedArgs,
      });
    }
  }

  const misplacedSoftParams = softParamGate.misplaced;
  if (misplacedSoftParams.length > 0) {
    resetValidationAttempt(downstreamValidationAttemptKey);
    // Same counter as the teaching branch (invariant 6): threshold and terminal
    // behaviour apply to gate-injected failures unchanged.
    const attempt = incrementValidationAttempt(validationAttemptKey);
    // Top-level presence is read from `input` (the parsed envelope) rather than the
    // destructured locals, because `dry_run` is destructured with a `= false`
    // default that would misreport an omitted param as present.
    const misplacedParams = classifyMisplacedMetaParams(
      misplacedSoftParams,
      getTopLevelMetaParamPresence(input),
    );
    // Normally there are no validation ERRORS to report — validation passed and the
    // fault is purely the call shape, so the ticket carries only the misplacement
    // teaching. The one exception is a canonical twin whose renamed value the declared
    // property rejects (R10): those Ajv errors are carried through so the ticket names
    // the declared property and its expected type alongside the misplacement teaching
    // (both readings of the call get the exact corrected shape).
    const repairTicket = buildRepairTicket(
      schema,
      renameValidationErrors,
      [],
      attempt,
      misplacedParams,
    );

    throw {
      code: ERROR_CODES.ARG_VALIDATION_FAILED,
      message: summarizeRepairTicket(
        package_id,
        tool_id,
        repairTicket,
        attempt >= STOP_RETRYING_THRESHOLD,
        misplacedParams,
      ),
      data: {
        package_id,
        tool_id,
        errors: renameValidationErrors,
        provided_args: isRecord(args) ? Object.keys(args) : [],
        repair_ticket: repairTicket,
      },
    };
  }

  resetValidationAttempt(validationAttemptKey);

  if (dry_run) {
    resetValidationAttempt(downstreamValidationAttemptKey);
    const result: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: { dry_run: true },
      telemetry: { duration_ms: 0, status: "ok" },
      ...(cachedTool?.tool?.annotations ? { annotations: cachedTool.tool.annotations } : {}),
    };

    let dryRunJson = JSON.stringify(result, null, 2);

    return buildOuter({
      content: [
        {
          type: "text",
          text: dryRunJson,
        },
      ],
      isError: false,
      superMcp: {
        packageId: package_id,
        toolId: tool_id,
        durationMs: 0,
        dryRun: true,
        ...(normalisations.length > 0 ? { normalisations: [...normalisations] } : {}),
        ...(packageResolution ? { packageResolution } : {}),
        ...(toolResolution ? { toolResolution } : {}),
      },
    });
  }

  const startTime = Date.now();
  try {
    // Stage 6: route through the liveness-gated `registry.callTool` so the idle
    // reaper cannot close the client mid-flight and a transport that closed
    // before any bytes were sent is re-established (no auto-retry on mid-call
    // close). Replaces the separate `getClient` + `client.callTool` seam.
    let toolResult = await registry.callTool(package_id, tool_id, args);
    const downstreamIsError = isRecord(toolResult) && toolResult.isError === true;
    // Capture spec-passthrough fields off the inner tool_result BEFORE any
    // truncation/safety-net/materialisation rewrites. See
    // docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md.
    const innerPassthrough = extractInnerPassthroughMeta(toolResult);
    registry.notifyActivity(package_id);
    const duration = Date.now() - startTime;

    // effectiveLimit: drives truncation + continuation chunk size (100K default)
    const effectiveLimit = max_output_chars === null
      ? undefined
      : (max_output_chars ?? DEFAULT_MAX_OUTPUT_CHARS);

    // materializationLimit: drives when to save large outputs to file (20K default).
    // When caller passes explicit max_output_chars, use that for both (caller knows their budget).
    const materializationLimit = max_output_chars === null
      ? undefined
      : (max_output_chars ?? MATERIALIZATION_THRESHOLD_CHARS);

    if (materializationLimit !== undefined && process.env.REBEL_WORKSPACE_PATH) {
      try {
        const matResult = await materializeOutput(
          package_id,
          tool_id,
          args,
          toolResult,
          duration,
          process.env.REBEL_WORKSPACE_PATH,
          materializationLimit
        );
        if (matResult) {
          // Forward connector tool annotations into materialized response
          if (cachedTool?.tool?.annotations) {
            matResult.annotations = cachedTool.tool.annotations;
          }

          const imageBlocks = extractImageContentBlocks(toolResult);

          if (typeof matResult.result?.preserved_text === "string" && effectiveLimit !== undefined) {
            const preservedText = matResult.result.preserved_text;
            if (preservedText.length > effectiveLimit) {
              matResult.result.preserved_text = `${preservedText.slice(0, effectiveLimit)}\n\n[Preserved text truncated to ${effectiveLimit} chars]`;
            }
          }

          const envelopeJson = JSON.stringify(matResult, null, 2);
          const matResultPayload = isRecord(matResult.result) ? matResult.result as Record<string, unknown> : {};
          const matStatus = matResultPayload.status === "oversized_output" ? "oversized_output" : "materialized";
          const materializationMeta: MaterializationMeta = {
            status: matStatus,
            ...(typeof matResultPayload.size_chars === "number" ? { originalChars: matResultPayload.size_chars } : {}),
            ...(typeof matResultPayload.file_path === "string" ? { filePath: matResultPayload.file_path } : {}),
            ...(Array.isArray(matResultPayload.image_files) ? { imageFiles: matResultPayload.image_files as string[] } : {}),
          };
          return buildOuter({
            content: [
              { type: "text", text: envelopeJson },
              ...imageBlocks,
            ],
            isError: downstreamIsError,
            passthrough: innerPassthrough,
            superMcp: {
              packageId: package_id,
              toolId: tool_id,
              durationMs: duration,
              outputChars: envelopeJson.length,
              ...(normalisations.length > 0 ? { normalisations: [...normalisations] } : {}),
              ...(packageResolution ? { packageResolution } : {}),
              ...(toolResolution ? { toolResolution } : {}),
            },
            materialization: materializationMeta,
          });
        }
      } catch (err: any) {
        logger.warn("Materialization failed, falling back to continuation", {
          error: err.message,
          package_id,
          tool_id
        });
      }
    }

    // Strip image blocks from tool results before JSON serialization.
    // Always strip (even errors) to prevent base64 inflation of outputJson.
    // Only pass images through to response for successful results.
    let passthroughImages: ReturnType<typeof extractImageContentBlocks> = [];
    if (isRecord(toolResult) && Array.isArray(toolResult.content)) {
      const extracted = extractImageContentBlocks(toolResult);
      if (extracted.length > 0) {
        if (toolResult.isError !== true) {
          passthroughImages = extracted;
        }
        toolResult = {
          ...toolResult,
          content: toolResult.content.filter(
            (block) => {
              if (!isRecord(block)) return true;
              // Strip direct image blocks
              if (block.type === "image") return false;
              // Strip resource blocks whose image blob was extracted
              if (block.type === "resource" && isRecord(block.resource)) {
                const r = block.resource as Record<string, unknown>;
                if (typeof r.blob === "string" && r.blob && typeof r.mimeType === "string"
                  && SUPPORTED_IMAGE_MIME_TYPES.has((r.mimeType as string).toLowerCase())) {
                  return false;
                }
              }
              return true;
            },
          ),
        };
      }
    }

    let finalToolResult: unknown = toolResult;
    let wasTruncated = false;
    if (effectiveLimit !== undefined) {
      const truncationResult = truncateToolResultTextContent(toolResult, effectiveLimit);
      finalToolResult = truncationResult.toolResult;
      wasTruncated = truncationResult.truncated;
    }

    const untruncatedResult: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: toolResult,
      telemetry: { duration_ms: duration, status: "ok" },
      ...(cachedTool?.tool?.annotations ? { annotations: cachedTool.tool.annotations } : {}),
    };
    const originalOutputChars = JSON.stringify(untruncatedResult, null, 2).length;
    const estimatedTokens = Math.ceil(originalOutputChars / 4);

    const result: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: finalToolResult,
      telemetry: { duration_ms: duration, status: "ok" },
      ...(cachedTool?.tool?.annotations ? { annotations: cachedTool.tool.annotations } : {}),
    };

    let outputJson = JSON.stringify(result, null, 2);

    if (wasTruncated && effectiveLimit !== undefined) {
      const resultId = randomUUID();

      // Cache the full untruncated output for continuation
      const fullSerializedOutput = JSON.stringify(untruncatedResult, null, 2);
      cacheResult(resultId, fullSerializedOutput);

      result.telemetry.output_truncated = true;
      result.telemetry.original_output_chars = originalOutputChars;
      result.telemetry.result_id = resultId;
      outputJson = JSON.stringify(result, null, 2);
      result.telemetry.output_chars = outputJson.length;
      outputJson = JSON.stringify(result, null, 2);

      // Continuation hint — offset 0 returns the full untruncated output from the start
      outputJson += `\n\n[To retrieve the full untruncated result: use_tool({ package_id: "${package_id}", tool_id: "${tool_id}", args: {}, result_id: "${resultId}", output_offset: 0 })]`;

      logger.warn("Tool output truncated", {
        package_id,
        tool_id,
        original_chars: originalOutputChars,
        truncated_to: effectiveLimit,
        estimated_tokens: estimatedTokens,
        result_id: resultId,
      });
    }
    else if (effectiveLimit === undefined && originalOutputChars > LARGE_OUTPUT_WARNING_THRESHOLD) {
      result.telemetry.output_chars = originalOutputChars;
      
      outputJson = JSON.stringify(result, null, 2);
      outputJson += `\n\n---\n⚠️ LARGE OUTPUT WARNING: This response contains ${originalOutputChars.toLocaleString()} characters (~${estimatedTokens.toLocaleString()} tokens).\nIf this causes context overflow errors, you can retry with the max_output_chars parameter to limit the output size.\nExample: use_tool({ package_id: "${package_id}", tool_id: "${tool_id}", args: {...}, max_output_chars: 50000 })`;
      
      logger.info("Large tool output detected", {
        package_id,
        tool_id,
        output_chars: originalOutputChars,
        estimated_tokens: estimatedTokens,
        warning_threshold: LARGE_OUTPUT_WARNING_THRESHOLD,
      });
    } else {
      result.telemetry.output_chars = outputJson.length;
      outputJson = JSON.stringify(result, null, 2);
    }

    // Final safety net: if serialized output is still oversized after all truncation
    // (e.g., non-text content blocks with large base64 data survived text truncation),
    // replace result with compact placeholder and trigger continuation. The JSON envelope
    // must remain valid (parseable) — downstream consumers parse the leading JSON.
    const safetyNetThreshold = Math.max(effectiveLimit !== undefined ? effectiveLimit + effectiveLimit : 0, SERIALIZED_OUTPUT_SAFETY_NET_FLOOR);
    let safetyNetFired = false;
    let safetyNetOriginalChars: number | undefined;
    if (effectiveLimit !== undefined && outputJson.length > safetyNetThreshold) {
      const originalOutputLength = outputJson.length;

      // If wasTruncated already cached the full untruncated output, reuse that result_id
      // to avoid orphan cache entries and enable direct one-hop recovery.
      const existingResultId = wasTruncated ? result.telemetry.result_id as string : undefined;
      const continuationResultId = existingResultId ?? randomUUID();
      if (!existingResultId) {
        cacheResult(continuationResultId, outputJson);
      }

      // Replace oversized result content with compact placeholder (keeps envelope parseable)
      result.result = {
        status: "oversized_output",
        message: `Output (${originalOutputLength.toLocaleString()} chars) exceeds context budget. Use continuation to retrieve.`,
        original_chars: originalOutputLength,
        result_id: continuationResultId,
      };
      result.telemetry.output_truncated = true;
      result.telemetry.original_output_chars = originalOutputLength;
      result.telemetry.result_id = continuationResultId;

      outputJson = JSON.stringify(result, null, 2);
      result.telemetry.output_chars = outputJson.length;
      outputJson = JSON.stringify(result, null, 2);
      outputJson += `\n\n[Output too large for context (${originalOutputLength.toLocaleString()} chars). To retrieve the full result: use_tool({ package_id: "${package_id}", tool_id: "${tool_id}", args: {}, result_id: "${continuationResultId}", output_offset: 0 })]`;

      safetyNetFired = true;
      safetyNetOriginalChars = originalOutputLength;

      logger.warn("Serialized output exceeded context budget — replaced with placeholder", {
        event: "serialized_output_safety_net",
        package_id,
        tool_id,
        original_chars: originalOutputLength,
        effective_limit: effectiveLimit,
        reused_truncation_id: !!existingResultId,
      });
    }

    resetValidationAttempt(downstreamValidationAttemptKey);

    return buildOuter({
      content: [
        {
          type: "text",
          text: outputJson,
        },
        ...passthroughImages,
      ],
      isError: downstreamIsError,
      passthrough: innerPassthrough,
      superMcp: {
        packageId: package_id,
        toolId: tool_id,
        durationMs: duration,
        outputChars: typeof result.telemetry.output_chars === "number"
          ? result.telemetry.output_chars
          : outputJson.length,
        ...(typeof result.telemetry.output_truncated === "boolean" ? { truncated: result.telemetry.output_truncated } : {}),
        ...(typeof result.telemetry.result_id === "string" ? { resultId: result.telemetry.result_id } : {}),
        ...(normalisations.length > 0 ? { normalisations: [...normalisations] } : {}),
        ...(packageResolution ? { packageResolution } : {}),
        ...(toolResolution ? { toolResolution } : {}),
      },
      ...(safetyNetFired
        ? {
            materialization: {
              status: "oversized_output" as const,
              ...(safetyNetOriginalChars !== undefined ? { originalChars: safetyNetOriginalChars } : {}),
            } satisfies MaterializationMeta,
          }
        : {}),
    });
  } catch (error) {
    registry.notifyActivity(package_id);
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const connectDiagnostics = deriveAllowlistedConnectDiagnostics(
      error,
      errorMessage,
    );

    if (
      error instanceof McpError
      && error.code === SdkErrorCode.InvalidParams
      && isDownstreamOutputValidationError(error)
    ) {
      resetValidationAttempt(downstreamValidationAttemptKey);
      const providedArgs = isRecord(args) ? Object.keys(args) : [];

      throw {
        code: ERROR_CODES.DOWNSTREAM_ERROR,
        message: `Downstream output validation failed for tool '${tool_id}': ${error.message}`,
        data: {
          package_id,
          tool_id,
          duration_ms: duration,
          args_provided: providedArgs,
          mcp_error_code: error.code,
          mcp_error_data: error.data,
          validation_direction: "output",
        },
      };
    }

    if (error instanceof McpError && error.code === SdkErrorCode.InvalidParams) {
      const attempt = incrementValidationAttempt(downstreamValidationAttemptKey);
      const shouldStopRetrying = attempt >= STOP_RETRYING_THRESHOLD;
      const includeFullSchema = attempt >= FULL_SCHEMA_THRESHOLD;
      const providedArgs = isRecord(args) ? Object.keys(args) : [];
      const schemaFragments = buildSchemaFragments(schema, new Set(providedArgs), includeFullSchema);
      const validFields = isRecord(schema) && isRecord(schema.properties)
        ? Object.keys(schema.properties)
        : [];

      throw {
        code: ERROR_CODES.ARG_VALIDATION_FAILED,
        message: `Downstream validation failed for tool '${tool_id}': ${error.message}${shouldStopRetrying ? ` ${STOP_RETRYING_MESSAGE}` : ""}`,
        data: {
          package_id,
          tool_id,
          duration_ms: duration,
          args_provided: providedArgs,
          mcp_error_code: error.code,
          mcp_error_data: error.data,
          repair_ticket: {
            missing_required: [],
            type_errors: [],
            enum_violations: [],
            format_errors: [],
            range_errors: [],
            pattern_errors: [],
            length_errors: [],
            unknown_fields: [],
            did_you_mean: {},
            schema_fragments: schemaFragments,
            valid_fields: validFields,
            attempt,
            downstream_error: error.message,
          },
        },
      };
    }

    resetValidationAttempt(downstreamValidationAttemptKey);
    
    let diagnosticMessage = `Tool execution failed in package '${package_id}', tool '${tool_id}'.\n`;
    
    if (errorMessage.includes("not found") || errorMessage.includes("undefined")) {
      diagnosticMessage += `\n❌ Tool might not exist or package not properly connected`;
      diagnosticMessage += `\nTroubleshooting:`;
      diagnosticMessage += `\n  1. Run 'health_check_all()' to verify package status`;
      diagnosticMessage += `\n  2. Run 'list_tools(package_id: "${package_id}")' to see available tools`;
      diagnosticMessage += `\n  3. Check if the tool name is correct (case-sensitive)`;
    } else if (errorMessage.includes("timeout")) {
      diagnosticMessage += `\n❌ Tool execution timed out after ${duration}ms`;
      diagnosticMessage += `\nThis might indicate:`;
      diagnosticMessage += `\n  1. The operation is taking longer than expected`;
      diagnosticMessage += `\n  2. The MCP server is not responding`;
      diagnosticMessage += `\n  3. Network issues (for HTTP-based MCPs)`;
    } else if (errorMessage.includes("permission") || errorMessage.includes("denied")) {
      diagnosticMessage += `\n❌ Permission denied`;
      diagnosticMessage += `\nPossible causes:`;
      diagnosticMessage += `\n  1. Insufficient permissions for the requested operation`;
      diagnosticMessage += `\n  2. API key/token lacks required scopes`;
      diagnosticMessage += `\n  3. File system permissions (for filesystem MCPs)`;
    } else if (errorMessage.includes("auth") || errorMessage.includes("401") || errorMessage.includes("403")) {
      diagnosticMessage += `\n❌ Authentication/Authorization error`;
      diagnosticMessage += `\nTroubleshooting:`;
      diagnosticMessage += `\n  1. Check if API keys/tokens are valid`;
      diagnosticMessage += `\n  2. Run 'authenticate(package_id: "${package_id}")' if OAuth-based`;
      diagnosticMessage += `\n  3. If authenticate() says 'already_authenticated' but tools still fail, use 'authenticate(package_id: "${package_id}", force: true)' to force re-authentication`;
      diagnosticMessage += `\n  4. Verify credentials have required permissions`;
    } else {
      diagnosticMessage += `\n❌ ${errorMessage}`;
    }
    
    diagnosticMessage += `\n\nExecution context:`;
    diagnosticMessage += `\n  Package: ${package_id}`;
    diagnosticMessage += `\n  Tool: ${tool_id}`;
    diagnosticMessage += `\n  Duration: ${duration}ms`;
    if (args && Object.keys(args).length > 0) {
      diagnosticMessage += `\n  Arguments provided: ${Object.keys(args).join(", ")}`;
    }
    
    throw {
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      message: diagnosticMessage,
      data: {
        package_id,
        tool_id,
        duration_ms: duration,
        original_error: errorMessage,
        args_provided: args ? Object.keys(args) : [],
        ...connectDiagnostics,
      },
    };
  }
}
