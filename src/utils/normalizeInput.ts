/**
 * Input normalization for Super-MCP meta-tool handlers.
 *
 * Defends against a known upstream Claude model bug where tool arguments are
 * serialized as JSON strings instead of native objects/arrays/booleans.
 * See: anthropics/claude-code#25865, docs/investigations/260330_slow_turn_brute_force_search.md
 *
 * Every coercion is logged so the upstream issue remains visible.
 */

import { getLogger } from "../logging.js";
import {
  getAliasesForTool,
  RESERVED_TOP_LEVEL_KEYS,
  type AliasEntry,
} from "../config/paramAliasMap.js";

const logger = getLogger();

/**
 * If `value` is a JSON string whose parsed result matches `expectedType`,
 * return the parsed value. Otherwise return the original value unchanged.
 *
 * Logs every successful coercion at warn level for upstream-bug visibility.
 */
export function coerceStringifiedJson<T>(
  value: unknown,
  expectedType: "object" | "array",
  context: { handler: string; field: string; package_id?: string; tool_id?: string },
): T | unknown {
  if (typeof value !== "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }

  if (expectedType === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    logger.warn("Coerced stringified JSON to object (upstream model bug)", {
      handler: context.handler,
      field: context.field,
      package_id: context.package_id,
      tool_id: context.tool_id,
    });
    return parsed as T;
  }

  if (expectedType === "array" && Array.isArray(parsed)) {
    logger.warn("Coerced stringified JSON to array (upstream model bug)", {
      handler: context.handler,
      field: context.field,
    });
    return parsed as T;
  }

  return value;
}

/**
 * Coerce string "true"/"false" to boolean. Returns the original value
 * if it's already a boolean or not a recognized string.
 */
export function coerceStringifiedBoolean(
  value: unknown,
  context: { handler: string; field: string },
): boolean | unknown {
  if (typeof value === "boolean") return value;
  if (value === "true") {
    logger.warn("Coerced string 'true' to boolean (upstream model bug)", context);
    return true;
  }
  if (value === "false") {
    logger.warn("Coerced string 'false' to boolean (upstream model bug)", context);
    return false;
  }
  return value;
}

/**
 * Coerce numeric strings to numbers. Returns the original value if it's already
 * a number, not a string, empty/whitespace-only, or does not parse to a finite
 * number.
 */
export function coerceStringifiedNumber(
  value: unknown,
  context: { handler: string; field: string },
): number | unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  if (value.trim() === "") return value;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;

  logger.warn("Coerced stringified number (upstream model bug)", context);
  return parsed;
}

/**
 * Result of a single key-alias rewrite call. Caller appends entries to its
 * `_meta.superMcp.normalisations` breadcrumb array (e.g. `key_alias:limit→count`
 * or `key_alias_skipped:body→properties.hs_note_body:target_exists`).
 */
export type KeyAliasBreadcrumb =
  | { kind: "applied"; from: string; to: string }
  | { kind: "skipped"; from: string; to: string; reason: "target_exists" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNestedTarget(
  args: Record<string, unknown>,
  to: string,
): { container: Record<string, unknown>; key: string; existingNonEmpty: boolean } | null {
  if (!to.includes(".")) {
    const existing = args[to];
    return {
      container: args,
      key: to,
      existingNonEmpty: existing !== undefined && existing !== null && existing !== "",
    };
  }
  const segments = to.split(".");
  const lastKey = segments.pop()!;
  let container: Record<string, unknown> = args;
  for (const segment of segments) {
    const current = container[segment];
    if (current === undefined || current === null) {
      const created: Record<string, unknown> = {};
      container[segment] = created;
      container = created;
      continue;
    }
    if (!isPlainObject(current)) return null;
    container = current;
  }
  const existing = container[lastKey];
  return {
    container,
    key: lastKey,
    existingNonEmpty: existing !== undefined && existing !== null && existing !== "",
  };
}

/**
 * Rewrite the **agent's mistaken top-level keys** in `args` into the canonical
 * keys the downstream tool's schema accepts. See
 * `super-mcp/src/config/paramAliasMap.ts` for the per-tool map and design
 * notes.
 *
 * Semantics summary:
 *   • Matches top-level keys only — never recurses into nested objects.
 *   • Reserved keys (`_meta`, `structuredContent`) are skipped, even if a
 *     future alias entry mentions them.
 *   • Replace — not duplicate. The source key is removed from `args`.
 *   • Target-wins collision: if the target (dotted-path supported) already
 *     holds a non-empty value, the source key is silently dropped and a
 *     `skipped` breadcrumb is emitted so we can spot recurring drift.
 *   • Mutates `args` in place and returns the same reference for ergonomics.
 *
 * `aliases` is injected to keep this function pure and unit-testable; in
 * `useTool.ts` it's resolved via `getAliasesForTool(packageId, toolId)`.
 */
export function normalizeArgKeys(
  args: unknown,
  context: { handler: string; package_id: string; tool_id: string },
  aliases?: ReadonlyArray<AliasEntry>,
): { args: unknown; breadcrumbs: KeyAliasBreadcrumb[] } {
  const resolved = aliases ?? getAliasesForTool(context.package_id, context.tool_id);
  if (resolved.length === 0 || !isPlainObject(args)) {
    return { args, breadcrumbs: [] };
  }

  const breadcrumbs: KeyAliasBreadcrumb[] = [];
  for (const { from, to } of resolved) {
    if (RESERVED_TOP_LEVEL_KEYS.has(from) || RESERVED_TOP_LEVEL_KEYS.has(to.split(".")[0]!)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(args, from)) {
      continue;
    }
    const sourceValue = args[from];
    const slot = pickNestedTarget(args, to);
    if (!slot) {
      // Dotted target collided with a non-object intermediate. Leave alone;
      // validator will surface the real error.
      continue;
    }
    if (slot.existingNonEmpty) {
      delete args[from];
      breadcrumbs.push({ kind: "skipped", from, to, reason: "target_exists" });
      logger.warn("Key-alias skipped — target already present (R3 target-wins)", {
        handler: context.handler,
        package_id: context.package_id,
        tool_id: context.tool_id,
        from,
        to,
      });
      continue;
    }
    slot.container[slot.key] = sourceValue;
    delete args[from];
    breadcrumbs.push({ kind: "applied", from, to });
    logger.debug("Key-alias applied (R3)", {
      handler: context.handler,
      package_id: context.package_id,
      tool_id: context.tool_id,
      from,
      to,
    });
  }
  return { args, breadcrumbs };
}

/** Format a key-alias breadcrumb into the `_meta.superMcp.normalisations` shape. */
export function formatKeyAliasBreadcrumb(entry: KeyAliasBreadcrumb): string {
  if (entry.kind === "applied") return `key_alias:${entry.from}→${entry.to}`;
  return `key_alias_skipped:${entry.from}→${entry.to}:${entry.reason}`;
}
