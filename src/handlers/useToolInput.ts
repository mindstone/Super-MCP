import { z } from "zod";
import { ERROR_CODES, type UseToolInput } from "../types.js";
import { coerceStringifiedJson } from "../utils/normalizeInput.js";

type UseToolHandlerInput = UseToolInput & {
  _rebel_staged?: boolean;
  _rebel_staged_message?: string;
};

const RECOVERY_GUIDANCE =
  'Use search_tools(query: "...") to find a tool by intent, list_tools(package_id: "...", detail: "lite") to browse tools, or get_tool_details(tool_ids: ["Package__tool"]) to inspect the argument schema.';

const useToolEnvelopeSchema = z.object({
  package_id: z.unknown().optional(),
  tool_id: z.unknown().optional(),
  args: z.unknown().optional(),
  dry_run: z.unknown().optional(),
  max_output_chars: z.unknown().optional(),
  result_id: z.unknown().optional(),
  output_offset: z.unknown().optional(),
  schema_hash: z.unknown().optional(),
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

  return {
    ...parsed,
    args: parseArgsContainer(parsed),
  } as UseToolHandlerInput;
}
