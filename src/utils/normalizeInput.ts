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

/* ------------------------------------------------------------------------- *
 * Schema-driven validate-before-send auto-repair (Stage 0).
 *
 * These two pure functions are the generalised, drift-free replacement for the
 * casing/coercion entries that used to live in `paramAliasMap.ts`. They map the
 * agent's args TOWARD the tool's own JSON schema — never via a hand-maintained
 * table — and the caller (`useTool.ts`) re-validates and only accepts the repair
 * when it now passes cleanly. See the deterministic spike in
 * `evals/spikes/arg-repair/{run,strategies}.ts` (strategy S6) which proved this
 * shape fixes the casing/typing -33003 class with 0 corruption / 0 regression.
 *
 * What is intentionally NOT done here (kept in `paramAliasMap.ts`): true
 * synonyms (e.g. Slack `limit`→`count`) and nested-target renames (e.g. HubSpot
 * `body`→`properties.hs_note_body`) — a schema-shape match provably cannot
 * reproduce those, so they stay as explicit aliases.
 * ------------------------------------------------------------------------- */

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  type?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  enum?: unknown;
  const?: unknown;
} & Record<string, unknown>;

/** Mirrors `super-mcp/src/utils/fuzzyMatch.ts` `canonicalize()`. */
function canonicalKey(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") {
    const props = (schema as JsonSchemaLike).properties;
    if (props && typeof props === "object") return props as Record<string, unknown>;
  }
  return {};
}

/**
 * A repair breadcrumb for `_meta.superMcp.normalisations`. Distinct prefixes
 * from the alias-map breadcrumbs so telemetry can tell the two apart.
 */
export type AutoRepairBreadcrumb =
  | { kind: "key"; from: string; to: string }
  | { kind: "coerce"; field: string };

/** Format an auto-repair breadcrumb into the `normalisations` string shape. */
export function formatAutoRepairBreadcrumb(entry: AutoRepairBreadcrumb): string {
  if (entry.kind === "key") return `auto_repair_key:${entry.from}→${entry.to}`;
  return `auto_repair_coerce:${entry.field}`;
}

/**
 * Canonical (case/separator-insensitive) key normalisation — UNAMBIGUOUS only.
 *
 * For each top-level key not present in `schema.properties`, if EXACTLY ONE
 * schema property shares its canonical form (lowercased, `-`/`_` stripped),
 * rename the key to that property. Refuses ambiguous matches (>1 candidate) and
 * never clobbers a target that already holds a value. Catches camelCase↔
 * snake_case bleed by construction. NO Levenshtein / fuzzy matching.
 *
 * Mutates and returns a *new* object is NOT done here — the function mutates the
 * passed object in place and returns the breadcrumbs, mirroring `normalizeArgKeys`'s
 * ergonomics. Callers pass a snapshot they own (see `useTool.ts`).
 */
export function canonicalKeyNormalize(
  args: Record<string, unknown>,
  schema: unknown,
): { breadcrumbs: AutoRepairBreadcrumb[] } {
  const props = schemaProperties(schema);
  const propKeys = Object.keys(props);
  if (propKeys.length === 0) return { breadcrumbs: [] };

  const breadcrumbs: AutoRepairBreadcrumb[] = [];
  // Snapshot the keys up front: we mutate `args` while iterating.
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(props, key)) continue; // already a valid key
    const target = canonicalKey(key);
    const matches = propKeys.filter((p) => canonicalKey(p) === target);
    if (matches.length !== 1) continue; // unknown or ambiguous → leave for the validator
    const to = matches[0]!;
    if (to === key) continue;
    // Never clobber an existing value at the target.
    if (Object.prototype.hasOwnProperty.call(args, to)) continue;
    args[to] = args[key];
    delete args[key];
    breadcrumbs.push({ kind: "key", from: key, to });
  }
  return { breadcrumbs };
}

const CANONICAL_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/**
 * Resolve the set of scalar primitive types a property schema declares,
 * threading through `anyOf`/`oneOf` and array-form `type` (e.g.
 * `type: ["integer", "null"]`). A `nullable: true` keyword adds `"null"`.
 *
 * Returns the union of declared types. The caller decides whether coercion is
 * safe (it is NOT when `string`, an `enum`, or a `const` is among the allowed
 * shapes — those mean a string / a fixed value is legitimately accepted).
 */
function resolveDeclaredTypes(propSchema: unknown): {
  types: Set<string>;
  hasStringOrLiteral: boolean;
} {
  const types = new Set<string>();
  let hasStringOrLiteral = false;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const s = node as JsonSchemaLike;

    // `enum` / `const` mean a fixed value (often a string) is allowed → never coerce.
    if (s.enum !== undefined || s.const !== undefined) hasStringOrLiteral = true;

    const t = s.type;
    if (typeof t === "string") {
      types.add(t);
      if (t === "string") hasStringOrLiteral = true;
    } else if (Array.isArray(t)) {
      for (const entry of t) {
        if (typeof entry === "string") {
          types.add(entry);
          if (entry === "string") hasStringOrLiteral = true;
        }
      }
    }

    if ((s as Record<string, unknown>).nullable === true) types.add("null");

    for (const branchKey of ["anyOf", "oneOf"] as const) {
      const branch = s[branchKey];
      if (Array.isArray(branch)) for (const sub of branch) visit(sub);
    }
  };

  visit(propSchema);
  return { types, hasStringOrLiteral };
}

/**
 * Coerce a single string scalar to number/integer/boolean ONLY when the
 * property's declared type is exactly that and string/enum/const is NOT also
 * allowed. Uses a canonical-number regex (no hex / whitespace / leading-zero
 * ambiguity) and a `Number.isSafeInteger` guard so large id-like strings (e.g.
 * "12345678901234567890") stay strings rather than coercing lossily.
 */
function coerceScalarToSchema(
  value: unknown,
  propSchema: unknown,
): { value: unknown; changed: boolean } {
  if (typeof value !== "string") return { value, changed: false };
  const { types, hasStringOrLiteral } = resolveDeclaredTypes(propSchema);
  if (types.size === 0) return { value, changed: false };
  // If a string / enum / const is legitimately accepted, never coerce.
  if (hasStringOrLiteral) return { value, changed: false };

  const trimmed = value.trim();

  if ((types.has("number") || types.has("integer")) && CANONICAL_NUMBER.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      const wantsIntegerOnly = types.has("integer") && !types.has("number");
      if (wantsIntegerOnly && !Number.isInteger(n)) return { value, changed: false };
      // Guard against lossy coercion of large id-like strings: only coerce when
      // the numeric value round-trips safely as an integer. Genuine fractional
      // numbers (which contain a '.') are unaffected by the safe-integer check.
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) return { value, changed: false };
      return { value: n, changed: true };
    }
  }

  if (types.has("boolean")) {
    if (trimmed === "true") return { value: true, changed: true };
    if (trimmed === "false") return { value: false, changed: true };
  }

  return { value, changed: false };
}

/**
 * Schema-aware type coercion of stringified scalars. For each top-level key
 * present in `schema.properties`, coerce a string value to number/integer/
 * boolean when (and only when) the property's declared type is exactly that
 * (see `coerceScalarToSchema` for the union/nullable/enum/safe-integer rules).
 *
 * Mutates the passed object in place; returns the breadcrumbs.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  schema: unknown,
): { breadcrumbs: AutoRepairBreadcrumb[] } {
  const props = schemaProperties(schema);
  if (Object.keys(props).length === 0) return { breadcrumbs: [] };

  const breadcrumbs: AutoRepairBreadcrumb[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const { value: coerced, changed } = coerceScalarToSchema(value, props[key]);
    if (changed) {
      args[key] = coerced;
      breadcrumbs.push({ kind: "coerce", field: key });
    }
  }
  return { breadcrumbs };
}
