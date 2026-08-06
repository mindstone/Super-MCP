import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  USE_TOOL_HARD_REJECT_META_PARAMS,
  USE_TOOL_INPUT_FIELD_CLASSIFICATION,
  USE_TOOL_META_PARAMS,
} from "../src/types.js";
import { appendErrorAdvice } from "../src/server.js";

/**
 * REBEL-7JD drift guards (planner F6 / reviewer-opus F1, F2 / reviewer-kimi F3).
 *
 * The misplacement guard's correctness rests on two facts that `satisfies` alone does
 * NOT prove, and on one branch that no other test reaches:
 *   1. every `use_tool` envelope field is CLASSIFIED — either a meta-param in the SSOT
 *      or a structural field of the envelope itself. `satisfies readonly (keyof
 *      UseToolInput)[]` proves membership, not exhaustiveness, so a sixth optional
 *      field added to `UseToolInput` would silently go unguarded and unTAUGHT.
 *   2. the hard-reject subset is exactly {max_output_chars, output_offset, schema_hash}.
 *      Silently dropping one (e.g. schema_hash) resurrects the incident's loop class for
 *      that param with no failing test.
 *   3. the server-level advice-suffix suppression gate: every other test drives the
 *      handlers directly, below the CallToolRequest catch block.
 */

/**
 * The envelope's own structural fields, mirroring the explicit literals in
 * handlers/useToolInput.ts. The `_rebel_staged*` pair is host-internal and not part of
 * `UseToolInput`, so it is asserted separately.
 */
const ENVELOPE_STRUCTURAL_KEYS = ["package_id", "tool_id", "args"] as const;
const HOST_INTERNAL_KEYS = ["_rebel_staged", "_rebel_staged_message"] as const;

describe("use_tool meta-param SSOT contract", () => {
  it("classifies every UseToolInput field, and the meta ones are exactly the SSOT", () => {
    // USE_TOOL_INPUT_FIELD_CLASSIFICATION is typed `Record<keyof UseToolInput, ...>`,
    // so a new field on UseToolInput fails `npm run build` until it is classified; this
    // assertion closes the other half — a field classified 'meta' but never added to
    // USE_TOOL_META_PARAMS (so unguarded and untaught) fails here.
    const metaFields = Object.entries(USE_TOOL_INPUT_FIELD_CLASSIFICATION)
      .filter(([, kind]) => kind === "meta")
      .map(([field]) => field)
      .sort();
    const structuralFields = Object.entries(USE_TOOL_INPUT_FIELD_CLASSIFICATION)
      .filter(([, kind]) => kind === "structural")
      .map(([field]) => field)
      .sort();

    expect(metaFields).toEqual([...USE_TOOL_META_PARAMS].sort());
    expect(structuralFields).toEqual([...ENVELOPE_STRUCTURAL_KEYS].sort());
    // Host-internal keys stay out of the SSOT entirely — they are never misplaceable.
    expect(
      HOST_INTERNAL_KEYS.filter((key) =>
        (USE_TOOL_META_PARAMS as readonly string[]).includes(key),
      ),
    ).toEqual([]);
  });

  it("pins the hard-reject subset to exactly max_output_chars, output_offset, schema_hash", () => {
    expect([...USE_TOOL_HARD_REJECT_META_PARAMS].sort()).toEqual([
      "max_output_chars",
      "output_offset",
      "schema_hash",
    ]);
    // dry_run and result_id are deliberately excluded (see types.ts rationale comments):
    // dry_run is a plausible real third-party argument; the guard is unreachable for
    // result_id and hoisting it would hijack the call into the continuation branch.
    expect(USE_TOOL_HARD_REJECT_META_PARAMS).not.toContain("dry_run");
    expect(USE_TOOL_HARD_REJECT_META_PARAMS).not.toContain("result_id");
  });
});

describe("appendErrorAdvice suffix gate", () => {
  const ADVICE = ". Use 'get_tool_details' to review the schema, or 'dry_run: true' to test arguments.";

  it("suppresses the generic schema advice for dispatch-stage -33003 errors", () => {
    const message = "Argument validation failed for tool 'tool1' in package 'pkg1'. …";

    expect(
      appendErrorAdvice(ERROR_CODES.ARG_VALIDATION_FAILED, message, {
        validation_stage: "dispatch",
        misplaced_param: "max_output_chars",
      }),
    ).toBe(message);
  });

  it("keeps the generic schema advice for validation-stage -33003 errors", () => {
    const message = "Argument validation failed for tool 'tool1' in package 'pkg1'.";

    // Validation-stage errors carry no validation_stage field at all.
    expect(appendErrorAdvice(ERROR_CODES.ARG_VALIDATION_FAILED, message, {})).toBe(
      message + ADVICE,
    );
    expect(appendErrorAdvice(ERROR_CODES.ARG_VALIDATION_FAILED, message, undefined)).toBe(
      message + ADVICE,
    );
    expect(
      appendErrorAdvice(ERROR_CODES.ARG_VALIDATION_FAILED, message, {
        validation_stage: "validation",
      }),
    ).toBe(message + ADVICE);
  });

  it("leaves other error codes' advice untouched", () => {
    expect(appendErrorAdvice(ERROR_CODES.PACKAGE_NOT_FOUND, "nope")).toContain(
      "list_tool_packages()",
    );
    expect(appendErrorAdvice(ERROR_CODES.TOOL_NOT_FOUND, "nope")).toContain("search_tools");
    expect(appendErrorAdvice(ERROR_CODES.INTERNAL_ERROR, "nope")).toBe("nope");
  });
});
