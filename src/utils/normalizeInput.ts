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
import { ERROR_CODES } from "../types.js";
import {
  getAliasesForTool,
  RESERVED_TOP_LEVEL_KEYS,
  type AliasEntry,
} from "../config/paramAliasMap.js";

const logger = getLogger();

export type ArgsContainerShape =
  | "array"
  | "number"
  | "boolean"
  | "empty_string"
  | "json_array_string"
  | "fenced_json_object"
  | "double_encoded_json_object"
  | "other_string"
  | "other"
  | "missing";

type RepairedArgsContainerShape =
  | "fenced_json_object"
  | "double_encoded_json_object";

// Carry a repair breadcrumb by object identity until `normalizeArgKeys`, the existing
// response-normalisation chokepoint. A WeakMap keeps the marker out of downstream args.
const repairedArgsContainerShapes = new WeakMap<object, RepairedArgsContainerShape>();

function unwrapWholeValueJsonFence(value: string): string | null {
  const match = value.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
  return match?.[1] ?? null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseBoundedObjectContainer(value: string): {
  value: Record<string, unknown>;
  repairedShape?: RepairedArgsContainerShape;
} | null {
  const fencedValue = unwrapWholeValueJsonFence(value);
  if (fencedValue !== null) {
    const parsedFence = parseJson(fencedValue);
    return isPlainObject(parsedFence)
      ? { value: parsedFence, repairedShape: "fenced_json_object" }
      : null;
  }

  const firstParse = parseJson(value);
  if (isPlainObject(firstParse)) return { value: firstParse };
  if (typeof firstParse !== "string") return null;

  const secondParse = parseJson(firstParse);
  return isPlainObject(secondParse)
    ? { value: secondParse, repairedShape: "double_encoded_json_object" }
    : null;
}

/** Closed, low-cardinality classifier for the `use_tool.args` container boundary. */
export function classifyArgsContainerShape(value: unknown): ArgsContainerShape {
  if (value === undefined || value === null) return "missing";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "string") return "other";
  if (value.trim() === "") return "empty_string";

  const boundedObject = parseBoundedObjectContainer(value);
  if (boundedObject?.repairedShape) return boundedObject.repairedShape;

  const firstParse = parseJson(value);
  if (Array.isArray(firstParse)) return "json_array_string";
  return "other_string";
}

/**
 * If `value` is a JSON string whose parsed result matches `expectedType`,
 * return the parsed value. Otherwise return the original value unchanged.
 * `boundedObjectContainerRepair` additionally accepts only the two proven
 * `use_tool.args` wrapper shapes; other callers retain the one-decode contract.
 *
 * Logs every successful coercion at warn level for upstream-bug visibility.
 */
export function coerceStringifiedJson<T>(
  value: unknown,
  expectedType: "object" | "array",
  context: {
    handler: string;
    field: string;
    package_id?: string;
    tool_id?: string;
    boundedObjectContainerRepair?: boolean;
  },
): T | unknown {
  if (typeof value !== "string") return value;

  let parsed: unknown;
  let repairedShape: RepairedArgsContainerShape | undefined;
  if (expectedType === "object" && context.boundedObjectContainerRepair) {
    const boundedObject = parseBoundedObjectContainer(value);
    if (!boundedObject) return value;
    parsed = boundedObject.value;
    repairedShape = boundedObject.repairedShape;
  } else {
    parsed = parseJson(value);
    if (parsed === undefined) return value;
  }

  if (expectedType === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    if (repairedShape) repairedArgsContainerShapes.set(parsed, repairedShape);
    logger.warn("Coerced stringified JSON to object (upstream model bug)", {
      handler: context.handler,
      field: context.field,
      package_id: context.package_id,
      tool_id: context.tool_id,
      ...(repairedShape ? { args_shape: repairedShape } : {}),
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

/* ------------------------------------------------------------------------- *
 * package_id presence validation (residue-chunk9 item 3, origin
 * 260811_degenerate-output-handling#R4 / diagnosis-B F3).
 *
 * When a model calls a package-scoped meta-tool with a missing/empty/
 * `"undefined"` package_id, the handlers used to fall through to opaque errors
 * like "Package 'undefined' is unavailable: …" that taught the caller nothing.
 * These helpers give every handler ONE definition of "the package_id never
 * arrived" and ONE recovery message that names the discovery tool, so the
 * model can self-correct in a single step.
 *
 * Deliberately INVALID_PARAMS (-32602), the code these handlers already use
 * for malformed envelope input — NOT ARG_VALIDATION_FAILED (-33003), which is
 * the tool-argument repair-ticket machinery (and, on the host side,
 * substring-classified + retry-counted; see handlers/useToolInput.ts).
 * ------------------------------------------------------------------------- */

/** Recovery clause shared by every package-scoped error message below. */
export const PACKAGE_DISCOVERY_HINT =
  "Call 'list_tool_packages()' to see available packages.";

function describeReceivedValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined || typeof value !== "object") {
    return String(value);
  }
  return Array.isArray(value) ? "array" : "object";
}

/**
 * True when `packageId` cannot name a package: missing, non-string,
 * empty/whitespace-only, or the stringified JS `undefined`/`null` the model
 * sometimes sends when it meant to omit the argument entirely (the exact
 * shape behind the original "Package 'undefined' is unavailable" reports).
 */
export function isMissingPackageId(packageId: unknown): boolean {
  if (typeof packageId !== "string") return true;
  const trimmed = packageId.trim();
  return trimmed === "" || trimmed === "undefined" || trimmed === "null";
}

/** Actionable message for a package_id that never usefully arrived. */
export function packageIdRequiredMessage(toolName: string, received: unknown): string {
  return `"package_id" is required for ${toolName} (received ${describeReceivedValue(received)}). ${PACKAGE_DISCOVERY_HINT}`;
}

/**
 * Validate the `package_id` envelope field of a package-scoped meta-tool call.
 * Throws INVALID_PARAMS (-32602) with a message naming the discovery tool;
 * returns the trimmed package_id. Callers that resolve a package_id through
 * fallbacks (use_tool's namespaced/bare-tool_id resolvers) must call this only
 * AFTER those fallbacks, so the supported no-package_id call shapes keep
 * working.
 */
export function requirePackageId(
  packageId: unknown,
  context: { handler: string },
): string {
  if (isMissingPackageId(packageId)) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: packageIdRequiredMessage(context.handler, packageId),
      data: {
        field: "package_id",
        handler: context.handler,
        received: describeReceivedValue(packageId),
      },
    };
  }
  return (packageId as string).trim();
}

/**
 * Result of a single key-alias rewrite call. Caller appends entries to its
 * `_meta.superMcp.normalisations` breadcrumb array (e.g. `key_alias:limit→count`
 * or `key_alias_skipped:body→properties.hs_note_body:target_exists`).
 */
export type KeyAliasBreadcrumb =
  | { kind: "applied"; from: string; to: string }
  | { kind: "skipped"; from: string; to: string; reason: "target_exists" }
  | { kind: "args_container"; shape: RepairedArgsContainerShape };

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
  if (!isPlainObject(args)) return { args, breadcrumbs: [] };

  const repairedShape = repairedArgsContainerShapes.get(args);
  if (repairedShape) repairedArgsContainerShapes.delete(args);
  const breadcrumbs: KeyAliasBreadcrumb[] = repairedShape
    ? [{ kind: "args_container", shape: repairedShape }]
    : [];

  const resolved = aliases ?? getAliasesForTool(context.package_id, context.tool_id);
  if (resolved.length === 0) return { args, breadcrumbs };

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
  if (entry.kind === "args_container") return `args_container:${entry.shape}`;
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

/**
 * Mirrors `super-mcp/src/utils/fuzzyMatch.ts` `canonicalize()`.
 *
 * Exported because the declared-property misplacement gate (handlers/useTool.ts
 * `classifySoftMetaParamsForDispatch`) resolves the CANONICAL twins of the schema's
 * declared properties — a tool declaring `dryRun` legitimises a nested `dry_run`,
 * which the gate then RENAMES into the declared spelling before dispatch (it cannot
 * rely on `canonicalKeyNormalize` doing it: on a permissive schema validation passes
 * clean and the auto-repair seam never fires — DA F1). The gate and the auto-repair
 * rename must agree on what "same key" means, so they share this one definition
 * (REBEL-7JD / plan Amendment A).
 */
export function canonicalKey(name: string): string {
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
  | { kind: "coerce"; field: string }
  | { kind: "envelope_echo" };

/** Format an auto-repair breadcrumb into the `normalisations` string shape. */
export function formatAutoRepairBreadcrumb(entry: AutoRepairBreadcrumb): string {
  if (entry.kind === "key") return `auto_repair_key:${entry.from}→${entry.to}`;
  if (entry.kind === "envelope_echo") return "auto_repair_envelope_echo";
  return `auto_repair_coerce:${entry.field}`;
}

/**
 * Undo an echoed `use_tool` envelope inside `args` (FOX-9491).
 *
 * The model sometimes repeats the call's own envelope in the tool arguments:
 * `args: { package_id, tool_id, args: {...} }`, or `package_id` / `tool_id` beside
 * the real arguments. When the tool's schema could not possibly mean those keys,
 * and every one present names this very call, they carry no information: drop
 * them, and if what is left is exactly one `args` object, use it as the arguments.
 *
 * "Could not possibly mean" is strict, so a real argument is never dropped:
 * - the schema is closed: `additionalProperties` is `false` or absent, and there
 *   is no composition or `patternProperties` that could accept the key (stricter
 *   than the validator's own unknown-field test in `validator.ts`);
 * - no declared property shares an envelope key's canonical form (a schema with
 *   `toolId` or `Args` keeps the key for the canonical-key repair to map).
 *
 * Mutates `args` in place, like the other Stage 0 repairs; the caller adopts the
 * result only if it then validates cleanly.
 */
const ENVELOPE_KEYS = ["package_id", "tool_id", "args"] as const;

function isClosedSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  if (!s.properties || typeof s.properties !== "object") return false;
  if ("additionalProperties" in s && s.additionalProperties !== false) return false;
  return !s.oneOf && !s.allOf && !s.anyOf && !s.patternProperties;
}

export function unwrapEchoedEnvelope(
  args: Record<string, unknown>,
  schema: unknown,
  call: { packageId: string; toolId: string },
): { breadcrumbs: AutoRepairBreadcrumb[] } {
  const none = { breadcrumbs: [] };
  if (!isClosedSchema(schema)) return none;
  const declared = Object.keys(schemaProperties(schema)).map(canonicalKey);
  if (ENVELOPE_KEYS.some((key) => declared.includes(canonicalKey(key)))) return none;

  const hasPackage = Object.prototype.hasOwnProperty.call(args, "package_id");
  const hasTool = Object.prototype.hasOwnProperty.call(args, "tool_id");
  if (!hasPackage && !hasTool) return none;
  const packageAgrees =
    typeof args.package_id === "string" &&
    args.package_id.toLowerCase() === call.packageId.toLowerCase();
  const toolAgrees =
    args.tool_id === call.toolId || args.tool_id === `${call.packageId}__${call.toolId}`;
  if ((hasPackage && !packageAgrees) || (hasTool && !toolAgrees)) return none;

  delete args.package_id;
  delete args.tool_id;
  const inner = args.args;
  if (
    Object.keys(args).length === 1 &&
    inner !== null &&
    typeof inner === "object" &&
    !Array.isArray(inner)
  ) {
    delete args.args;
    // Copy own properties without setters: an inner `__proto__` key must stay data.
    Object.defineProperties(args, Object.getOwnPropertyDescriptors(inner));
  }
  return { breadcrumbs: [{ kind: "envelope_echo" }] };
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
    if (RESERVED_TOP_LEVEL_KEYS.has(key)) continue; // never rewrite _meta / structuredContent
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
// Strict integer grammar for integer-only fields: no whitespace, no `-0`, no leading
// zeros, no decimal/exponent forms. `"1.0"`, `"1e3"`, `" 5 "`, `"-0"` are intentionally
// NOT auto-coerced — they fall through to the -33003 repair-ticket so the model corrects
// explicitly rather than being silently reshaped (cross-family GPT review, Stage 0).
const STRICT_INTEGER = /^(0|-?[1-9][0-9]*)$/;

/**
 * Resolve the set of scalar primitive types a property schema declares,
 * threading through `anyOf`/`oneOf` and array-form `type` (e.g.
 * `type: ["integer", "null"]`). A `nullable: true` keyword adds `"null"`.
 *
 * Returns the union of declared types. The caller decides whether coercion is
 * safe (it is NOT when `string`, an `enum`, a `const` or an untyped union branch
 * is among the allowed shapes — those mean a string / a fixed value is
 * legitimately accepted).
 */
function resolveDeclaredTypes(propSchema: unknown): {
  types: Set<string>;
  hasStringOrLiteral: boolean;
} {
  const types = new Set<string>();
  let hasStringOrLiteral = false;

  // `typed`: an enclosing node declares a `type`, which still applies to an untyped branch.
  const visit = (node: unknown, typed: boolean): void => {
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
      if (!Array.isArray(branch)) continue;
      const branchTyped = typed || t !== undefined;
      for (const sub of branch) {
        // A branch that names no type, value or further union, under no enclosing
        // type, accepts any type, strings included: a string may already be valid.
        const b = (sub ?? {}) as JsonSchemaLike;
        if (!branchTyped && b.type === undefined && b.enum === undefined && b.const === undefined && b.anyOf === undefined && b.oneOf === undefined) {
          hasStringOrLiteral = true;
        }
        visit(sub, branchTyped);
      }
    }
  };

  visit(propSchema, false);
  return { types, hasStringOrLiteral };
}

/**
 * Coerce a single string to number/integer/boolean, or parse it to an array or
 * object (the same upstream model bug, FOX-7659), ONLY when the property's
 * declared type is exactly that and string/enum/const is NOT also allowed.
 * Uses a canonical-number regex (no hex / whitespace / leading-zero
 * ambiguity) and a `Number.isSafeInteger` guard so large id-like strings (e.g.
 * "12345678901234567890") stay strings rather than coercing lossily.
 */
function coerceValueToSchema(
  value: unknown,
  propSchema: unknown,
): { value: unknown; changed: boolean } {
  if (typeof value !== "string") return { value, changed: false };
  const { types, hasStringOrLiteral } = resolveDeclaredTypes(propSchema);
  if (types.size === 0) return { value, changed: false };
  // If a string / enum / const is legitimately accepted, never coerce.
  if (hasStringOrLiteral) return { value, changed: false };

  // A stringified array or object: use the parsed value only when it is a container
  // type the schema declares. The caller re-validates before adopting it.
  if (types.has("array") || types.has("object")) {
    const parsed = parseJson(value);
    const parsedType = Array.isArray(parsed)
      ? "array"
      : parsed !== null && typeof parsed === "object"
        ? "object"
        : undefined;
    if (parsedType && types.has(parsedType)) return { value: parsed, changed: true };
  }

  // Match against the ORIGINAL string (no trim): leading/trailing whitespace is sloppy
  // input we leave for the repair-ticket rather than silently accepting.
  const wantsIntegerOnly = types.has("integer") && !types.has("number");
  if (wantsIntegerOnly) {
    // Integer-only: strict integer grammar (rejects `-0`, `1.0`, `1e3`, whitespace).
    if (STRICT_INTEGER.test(value)) {
      const n = Number(value);
      if (Number.isSafeInteger(n)) return { value: n, changed: true };
    }
  } else if (types.has("number") || types.has("integer")) {
    // `number` (may be fractional/exponent): canonical JSON number on the original string.
    if (CANONICAL_NUMBER.test(value)) {
      const n = Number(value);
      // Guard against lossy coercion of large id-like strings: only coerce when an
      // integer value round-trips safely. Genuine fractional numbers are unaffected.
      if (Number.isFinite(n) && !(Number.isInteger(n) && !Number.isSafeInteger(n))) {
        return { value: n, changed: true };
      }
    }
  }

  if (types.has("boolean")) {
    if (value === "true") return { value: true, changed: true };
    if (value === "false") return { value: false, changed: true };
  }

  return { value, changed: false };
}

/**
 * Schema-aware type coercion of stringified values. For each top-level key
 * present in `schema.properties`, coerce a string value to number/integer/
 * boolean/array/object when (and only when) the property's declared type is
 * exactly that (see `coerceValueToSchema` for the union/nullable/enum/safe-integer rules).
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
    const { value: coerced, changed } = coerceValueToSchema(value, props[key]);
    if (changed) {
      args[key] = coerced;
      breadcrumbs.push({ kind: "coerce", field: key });
    }
  }
  return { breadcrumbs };
}
