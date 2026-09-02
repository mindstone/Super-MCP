import { describe, expect, it } from "vitest";
import { Validator } from "../src/validator.js";

// Regression: Linear's MCP tools declare `$schema: draft/2020-12`. A draft-07
// Ajv cannot resolve that meta-schema and `compile` throws
// `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`,
// which surfaced to users as "Approved, but the action failed: no schema with
// key or ref …" on every Linear tool call. Tool input schemas arrive in
// whatever dialect the upstream server chose, so the validator must accept
// draft-07, 2020-12 and undeclared schemas alike.
const shape = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
  required: ["query"],
} as const;

describe("Validator — JSON Schema dialects declared by upstream tools", () => {
  it("accepts a schema declaring draft 2020-12 (Linear MCP)", () => {
    const validator = new Validator();
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", ...shape };
    expect(validator.validate(schema, { query: "yesterday" }).valid).toBe(true);
    expect(validator.validate(schema, { limit: 0 }).valid).toBe(false);
  });

  it("still accepts a schema declaring draft-07", () => {
    const validator = new Validator();
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", ...shape };
    expect(validator.validate(schema, { query: "x" }).valid).toBe(true);
    expect(validator.validate(schema, { limit: 0 }).valid).toBe(false);
  });

  it("still accepts a schema with no $schema at all", () => {
    const validator = new Validator();
    expect(new Validator().validate({ ...shape }, { query: "x" }).valid).toBe(true);
    expect(validator.validate({ ...shape }, {}).valid).toBe(false);
  });

  it("keeps draft-07 tuple-form `items: [...]` compiling for draft-07 and undeclared schemas (review F1)", () => {
    // The 2020-12 class rejects array-form `items`; routing draft-07/undeclared
    // schemas to a draft-07 instance preserves the historical behaviour.
    const validator = new Validator();
    const tuple = {
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "integer" }] } },
      required: ["pair"],
    };
    expect(validator.validate({ $schema: "http://json-schema.org/draft-07/schema#", ...tuple }, { pair: ["a", 1] }).valid).toBe(true);
    expect(validator.validate({ ...tuple }, { pair: ["a", 1] }).valid).toBe(true);
    expect(validator.validate({ ...tuple }, { pair: [1, "a"] }).valid).toBe(false);
  });

  it("applies 2020-12 semantics (prefixItems) when the schema declares 2020-12 (review F3)", () => {
    const validator = new Validator();
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false } },
      required: ["pair"],
    };
    expect(validator.validate(schema, { pair: ["a", 1] }).valid).toBe(true);
    expect(validator.validate(schema, { pair: [1, "a"] }).valid).toBe(false);
    expect(validator.validate(schema, { pair: ["a", 1, "extra"] }).valid).toBe(false);
  });

  it("accepts 2020-12 keywords ($defs/$ref) used by upstream tool schemas", () => {
    const validator = new Validator();
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { id: { type: "string", minLength: 1 } },
      properties: { issueId: { $ref: "#/$defs/id" } },
      required: ["issueId"],
    };
    expect(validator.validate(schema, { issueId: "LIN-1" }).valid).toBe(true);
    expect(validator.validate(schema, { issueId: "" }).valid).toBe(false);
  });
});
