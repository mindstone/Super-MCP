// The JSON-RPC error a failed tools/call answers with: the code-specific recovery
// advice and the error's wire shape, kept apart from the server so they can be
// tested on their own.
import { ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES, type PackageConfig } from "./types.js";
import { homeFailureOf } from "./clients/packageHomeClient.js";
import { redactConnectorSecretsDeep } from "./connectorLabels.js";
import { formatError } from "./utils/formatError.js";

// This predicate is duplicated in `src/core/rebelCore/mcpClient.ts`; the two
// copies must stay identical. Both tests use the shared case fixture at
// `super-mcp/test/fixtures/connector-answered-cases.json`.
function downstreamConnectorAnswered(data: unknown): data is Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record.validation_direction === "output") return true;
  const code = record.mcp_error_code;
  return typeof code === "number" && code !== SdkErrorCode.ConnectionClosed && code !== SdkErrorCode.RequestTimeout;
}

/**
 * Append the code-specific recovery advice super-mcp adds to a thrown handler error
 * before it leaves the CallToolRequest handler.
 *
 * Extracted from the handler's catch block so the suppression gate below is unit
 * testable: every other test drives the handlers directly, well below this layer, so
 * the gate was previously an untested inline closure (reviewer-opus F2 / kimi F3 /
 * planner F7).
 */
export function appendErrorAdvice(code: unknown, message: string, data?: unknown): string {
  switch (code) {
    case ERROR_CODES.PACKAGE_NOT_FOUND:
      return message + ". Run 'list_tool_packages()' to see available packages.";
    case ERROR_CODES.TOOL_NOT_FOUND:
      return message + ". Try 'search_tools(query: \"...\")' to find tools by intent, or 'list_tools(package_id: \"...\", detail: \"lite\")' to browse.";
    case ERROR_CODES.ARG_VALIDATION_FAILED: {
      // Dispatch-stage failures (parseUseToolInput) already carry their own recovery
      // guidance and, for misplaced meta-params, the exact corrected call shape. The
      // generic schema advice contradicts or dilutes that, so suppress it for the
      // whole dispatch stage. See handlers/useToolInput.ts.
      if ((data as { validation_stage?: unknown } | undefined)?.validation_stage === "dispatch") {
        return message;
      }
      // REBEL-7JD residue R9: same reasoning, stage-independent. A repair ticket
      // that teaches a MISPLACEMENT already names the exact corrected call shape, so
      // ". Use 'get_tool_details' … or 'dry_run: true' to test arguments" is at best
      // noise and at worst self-contradictory — the misplaced param is often
      // `dry_run` itself. Keyed on the ticket, not the stage, so the validation-stage
      // declared-property gate (handlers/useTool.ts) is covered too. Plain validation
      // failures with no misplacement keep the advice.
      const misplacedParams = (
        data as { repair_ticket?: { misplaced_params?: unknown } } | undefined
      )?.repair_ticket?.misplaced_params;
      if (Array.isArray(misplacedParams) && misplacedParams.length > 0) {
        return message;
      }
      return message + ". Use 'get_tool_details' to review the schema, or 'dry_run: true' to test arguments.";
    }
    case ERROR_CODES.AUTH_REQUIRED:
      return message + ". Run 'authenticate(package_id: \"...\")' to connect this package.";
    case ERROR_CODES.PACKAGE_UNAVAILABLE:
      return message + ". Run 'health_check_all()' to diagnose the issue.";
    case ERROR_CODES.DOWNSTREAM_ERROR:
      if (downstreamConnectorAnswered(data)) {
        if (data.validation_direction === "output") {
          return message + ". The connector replied, but its reply did not match the tool's declared output. Do not restart the connector or repeat the call; the action may already have happened.";
        }
        return message + ". The connector answered with its own error. Do not restart the connector for this error. Read its message. If it rejected the input, use 'get_tool_details' to check the arguments and retry with corrected arguments; if the action may already have happened, check before retrying.";
      }
      return message + ". Check the error details above. If the error persists, try 'restart_package(package_id: \"...\")' to reconnect.";
    case ERROR_CODES.TOOL_BLOCKED:
      return message + ". This tool has been blocked by the security policy.";
    default:
      return message;
  }
}

/**
 * The JSON-RPC error the CallToolRequest handler throws for a failed tool call.
 *
 * A structured error keeps its own code and data and gets the code's advice. Any other
 * error becomes INTERNAL_ERROR with its message and `{ tool_name }`; a package home
 * that could not be reached adds only `home_failure: "unreachable"` to that data, so
 * the host can count the pause (FOX-11451) while the code and message stay the same.
 * A connector's error may quote its address, command or arguments, and so a key, so
 * both are redacted against the connector configs.
 */
function buildToolCallFailure(name: string, error: unknown, connectorConfigs: readonly PackageConfig[]): unknown {
  if (error && typeof error === "object" && "code" in error) {
    return redactConnectorSecretsDeep({
      ...error,
      message: appendErrorAdvice(
        (error as any).code,
        (error as any).message,
        (error as any).data,
      ),
    }, connectorConfigs);
  }
  const homeFailure = homeFailureOf(error);
  return redactConnectorSecretsDeep({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: `${formatError(error)}. Try 'get_help(topic: "error_handling")' for general troubleshooting.`,
    data: { tool_name: name, ...(homeFailure && { home_failure: homeFailure }) },
  }, connectorConfigs);
}

export function toolCallFailure(name: string, error: unknown, connectorConfigs: readonly PackageConfig[], neverDispatched = false): unknown {
  const failure = buildToolCallFailure(name, error, connectorConfigs) as { data?: unknown };
  const key = 'superMcp/neverDispatched';
  // Reserve the wire key even on failures supplied by a connector. Only the
  // server's invocation-local tracker can establish that no send started.
  if (typeof failure.data === 'object' && failure.data !== null && !Array.isArray(failure.data)) {
    const { [key]: _, ...rest } = failure.data as Record<string, unknown>;
    failure.data = rest;
  }
  if (neverDispatched) {
    failure.data = { ...(failure.data as Record<string, unknown> | undefined), [key]: true };
  }
  return failure;
}
