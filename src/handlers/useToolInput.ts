import { z } from "zod";
import {
  ERROR_CODES,
  USE_TOOL_HARD_REJECT_META_PARAMS,
  USE_TOOL_META_PARAMS,
  type UseToolInput,
  type UseToolMetaParam,
} from "../types.js";
import { coerceStringifiedJson } from "../utils/normalizeInput.js";

type UseToolHandlerInput = UseToolInput & {
  _rebel_staged?: boolean;
  _rebel_staged_message?: string;
};

const RECOVERY_GUIDANCE =
  'Use search_tools(query: "...") to find a tool by intent, list_tools(package_id: "...", detail: "lite") to browse tools, or get_tool_details(tool_ids: ["Package__tool"]) to inspect the argument schema.';

/**
 * Cap for the misplaced value echoed back inside the retry instruction. The whole
 * message competes for the host's 2000-char error-data budget
 * (superproject src/core/rebelCore/mcpClient.ts MCP_ERROR_DATA_MAX_LEN), which
 * truncates tail-first — so a pathological nested value (a megabyte of text parked
 * under `max_output_chars`) must not be able to push the leading classifier clause
 * or the teaching text out of the budget (reviewer-kimi F4).
 */
const MAX_ECHOED_VALUE_CHARS = 200;

function echoValue(value: unknown): string {
  const stringified = JSON.stringify(value) ?? String(value);
  return stringified.length > MAX_ECHOED_VALUE_CHARS
    ? `${stringified.slice(0, MAX_ECHOED_VALUE_CHARS)}… (truncated)`
    : stringified;
}

// Meta-param entries derive from the SSOT (types.ts USE_TOOL_META_PARAMS) so the
// envelope and the misplacement guard can never drift apart: adding a meta-param there
// adds it here. package_id/tool_id/args and the _rebel_staged* internals stay explicit
// literals — they are the envelope's own structural fields and must never be
// classified as misplaceable meta-params.
const metaParamShape = Object.fromEntries(
  USE_TOOL_META_PARAMS.map((param) => [param, z.unknown().optional()]),
) as { [K in UseToolMetaParam]: z.ZodOptional<z.ZodUnknown> };

const useToolEnvelopeSchema = z.object({
  package_id: z.unknown().optional(),
  tool_id: z.unknown().optional(),
  args: z.unknown().optional(),
  ...metaParamShape,
  _rebel_staged: z.unknown().optional(),
  _rebel_staged_message: z.unknown().optional(),
}).passthrough();

function getValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getProvidedArgs(value: unknown): string[] {
  return isArgsObject(value) ? Object.keys(value) : [];
}

function throwDispatchArgValidation(
  message: string,
  data: {
    field: string;
    expected: string;
    got: string;
    package_id?: unknown;
    tool_id?: unknown;
    provided_args?: string[];
    /** Set when the failure is a use_tool meta-param nested inside `args` (REBEL-7JD). */
    misplaced_param?: string;
  },
): never {
  throw {
    code: ERROR_CODES.ARG_VALIDATION_FAILED,
    message,
    data: {
      validation_stage: "dispatch",
      field: data.field,
      expected: data.expected,
      got: data.got,
      package_id: data.package_id ?? null,
      tool_id: data.tool_id ?? null,
      provided_args: data.provided_args ?? [],
      ...(data.misplaced_param ? { misplaced_param: data.misplaced_param } : {}),
    },
  };
}

function parseArgsContainer(input: {
  package_id?: unknown;
  tool_id?: unknown;
  args?: unknown;
}): unknown {
  const { package_id, tool_id } = input;

  if (input.args === undefined || input.args === null) {
    return input.args;
  }

  const coerced = coerceStringifiedJson<Record<string, unknown>>(input.args, "object", {
    handler: "use_tool",
    field: "args",
    package_id: optionalString(package_id),
    tool_id: optionalString(tool_id),
  });

  if (isArgsObject(coerced)) {
    return coerced;
  }

  throwDispatchArgValidation(
    `use_tool "args" must be an object, null/omitted, or a JSON string that parses to an object. ${RECOVERY_GUIDANCE}`,
    {
      field: "args",
      expected: "object|null|undefined|stringified JSON object",
      got: getValueKind(input.args),
      package_id,
      tool_id,
      provided_args: getProvidedArgs(input.args),
    },
  );
}

function isContinuationCall(input: { result_id?: unknown }): boolean {
  return Boolean(input.result_id);
}

/**
 * REBEL-7JD: reject a `use_tool` meta-param that the model nested inside `args`.
 *
 * The old failure path was indirect: the downstream schema rejected the key as an
 * unknown field ("This tool takes no arguments"), which never told the model that
 * the key is a legitimate TOP-LEVEL `use_tool` parameter that was merely misplaced —
 * so it re-sent the same shape and looped. Rejecting here is deterministic on the
 * first attempt and independent of the downstream schema.
 *
 * Only fires when the key is absent at top level, so passing the param top-level as
 * well remains a working escape hatch for a tool that genuinely declares it.
 *
 * Called ONCE, on the normal path, after `parseArgsContainer`. Continuation calls
 * early-return above and ignore `args` entirely, so there is nothing to guard there
 * (a pre-continuation call site would be dead code that invites relaxing the
 * top-level-absence check — which is what keeps legitimate tools callable).
 */
function rejectMisplacedMetaParams(input: {
  package_id?: unknown;
  tool_id?: unknown;
  args?: unknown;
  [key: string]: unknown;
}): void {
  const args = input.args;
  if (!isArgsObject(args)) return;

  for (const param of USE_TOOL_HARD_REJECT_META_PARAMS) {
    if (!(param in args)) continue;
    // Escape hatch: the model also passed it top-level, so the meta-param is being
    // honoured and the nested copy is (at worst) a redundant tool argument.
    //
    // "At worst" is schema-dependent: on a non-stripping schema
    // (additionalProperties: true) the nested key is forwarded downstream VERBATIM as
    // a real tool argument; on a stripping schema the validator strips-and-throws
    // instead. That non-stripping passthrough is deliberately NOT blocked here —
    // blocking it would break the tools this escape hatch exists to keep callable.
    //
    // Note the asymmetry with the SOFT pair (dry_run, result_id), which never reaches
    // this guard: for those the validation seam's declared-property gate
    // (useTool.ts findMisplacedSoftMetaParams) now BLOCKS the equivalent passthrough
    // outright — there the escape hatch is "declare the property in your schema"
    // (literal or canonical twin), not "pass it top-level too". REBEL-7JD residue R1.
    if (input[param] !== undefined) continue;

    const suppliedPackageId = optionalString(input.package_id);
    const toolId = optionalString(input.tool_id) ?? "<unknown>";
    const nestedValue = echoValue(args[param]);
    // Echo back only what the caller actually supplied. A namespaced tool_id
    // ("pkg__tool") with no package_id is a supported call shape (useTool.ts case 1),
    // so emitting `package_id: "<unknown>"` would teach a retry shape that itself
    // fails package lookup — the very failure class this guard exists to end
    // (reviewer-kimi F2). For the prose clause, fall back to the namespace prefix;
    // if there is no prefix either, drop the package clause rather than invent one.
    const namespacePrefix = toolId.includes("__") ? toolId.split("__")[0] : undefined;
    const packageLabel = suppliedPackageId ?? namespacePrefix;
    const packageClause = packageLabel ? ` in package '${packageLabel}'` : "";
    const packageIdClause = suppliedPackageId ? `package_id: "${suppliedPackageId}", ` : "";
    throwDispatchArgValidation(
      // The leading clause is classifier-stable: the host app substring-matches
      // "Argument validation failed for tool" to render this as a calm recoverable
      // arg-validation failure rather than a raw error toast. Keep it first.
      `Argument validation failed for tool '${toolId}'${packageClause}. ` +
        `use_tool parameter "${param}" was nested inside "args". It is a top-level ` +
        `use_tool parameter, not a tool argument. Retry with: use_tool({ ${packageIdClause}` +
        `tool_id: "${toolId}", args: { ...tool arguments only... }, ` +
        `${param}: ${nestedValue} }). ${RECOVERY_GUIDANCE}`,
      {
        field: `args.${param}`,
        expected: "top-level use_tool parameter",
        got: "nested inside args",
        package_id: input.package_id,
        tool_id: input.tool_id,
        provided_args: getProvidedArgs(args),
        misplaced_param: param,
      },
    );
  }
}

export function parseUseToolInput(input: unknown): UseToolHandlerInput {
  const envelope = useToolEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    throwDispatchArgValidation(
      `use_tool input must be an object. ${RECOVERY_GUIDANCE}`,
      {
        field: "input",
        expected: "object",
        got: getValueKind(input),
      },
    );
  }

  const parsed = envelope.data;

  if (isContinuationCall(parsed)) {
    return parsed as UseToolHandlerInput;
  }

  if (typeof parsed.tool_id !== "string" || parsed.tool_id.trim().length === 0) {
    throwDispatchArgValidation(
      `use_tool requires a non-empty string "tool_id" for normal calls. ${RECOVERY_GUIDANCE}`,
      {
        field: "tool_id",
        expected: "non-empty string",
        got: getValueKind(parsed.tool_id),
        package_id: parsed.package_id,
        tool_id: parsed.tool_id,
        provided_args: getProvidedArgs(parsed.args),
      },
    );
  }

  const normalized = {
    ...parsed,
    args: parseArgsContainer(parsed),
  };

  rejectMisplacedMetaParams(normalized);

  return normalized as UseToolHandlerInput;
}
