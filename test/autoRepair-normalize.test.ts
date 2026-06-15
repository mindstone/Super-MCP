// Stage 0 — unit tests for the schema-driven validate-before-send auto-repair
// pure functions (canonicalKeyNormalize + coerceArgsToSchema).
//
// See: super-mcp/src/utils/normalizeInput.ts
//      evals/spikes/arg-repair/{run,strategies}.ts (the S6 spike these mirror)

import { describe, it, expect } from "vitest";
import {
  canonicalKeyNormalize,
  coerceArgsToSchema,
  formatAutoRepairBreadcrumb,
} from "../src/utils/normalizeInput.js";

describe("canonicalKeyNormalize", () => {
  it("renames camelCase → snake_case schema property (unambiguous casing)", () => {
    const schema = {
      type: "object",
      properties: {
        device_timezone: { type: "string" },
        max_results: { type: "integer" },
      },
    };
    const args: Record<string, unknown> = { deviceTimezone: "Europe/London", maxResults: 25 };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ device_timezone: "Europe/London", max_results: 25 });
    expect(breadcrumbs.map(formatAutoRepairBreadcrumb)).toEqual([
      "auto_repair_key:deviceTimezone→device_timezone",
      "auto_repair_key:maxResults→max_results",
    ]);
  });

  it("renames snake_case → camelCase schema property (reverse direction)", () => {
    const schema = {
      type: "object",
      properties: { startDateTime: { type: "string" } },
    };
    const args: Record<string, unknown> = { start_datetime: "2026-05-17T00:00:00Z" };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ startDateTime: "2026-05-17T00:00:00Z" });
    expect(breadcrumbs).toEqual([{ kind: "key", from: "start_datetime", to: "startDateTime" }]);
  });

  it("refuses ambiguous matches (>1 schema property shares the canonical form)", () => {
    // Pathological schema with two props that canonicalise identically.
    const schema = {
      type: "object",
      properties: { user_id: { type: "string" }, userid: { type: "string" } },
    };
    const args: Record<string, unknown> = { userId: "abc" };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ userId: "abc" }); // untouched
    expect(breadcrumbs).toEqual([]);
  });

  it("never clobbers an existing value at the target", () => {
    const schema = { type: "object", properties: { count: { type: "integer" } } };
    const args: Record<string, unknown> = { count: 50, Count: 99 };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    // `Count` canonicalises to the existing `count` which already has a value → leave both.
    expect(args).toEqual({ count: 50, Count: 99 });
    expect(breadcrumbs).toEqual([]);
  });

  it("leaves keys already present in the schema untouched", () => {
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const args: Record<string, unknown> = { query: "hi" };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ query: "hi" });
    expect(breadcrumbs).toEqual([]);
  });

  it("leaves genuinely unknown keys (no canonical match) for the validator", () => {
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const args: Record<string, unknown> = { limit: 10 };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ limit: 10 });
    expect(breadcrumbs).toEqual([]);
  });
});

describe("coerceArgsToSchema", () => {
  it("coerces stringified number when the property type is exactly number/integer", () => {
    const schema = {
      type: "object",
      properties: { max_results: { type: "integer" }, score: { type: "number" } },
    };
    const args: Record<string, unknown> = { max_results: "20", score: "0.5" };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ max_results: 20, score: 0.5 });
    expect(breadcrumbs.map(formatAutoRepairBreadcrumb)).toEqual([
      "auto_repair_coerce:max_results",
      "auto_repair_coerce:score",
    ]);
  });

  it("coerces stringified boolean", () => {
    const schema = {
      type: "object",
      properties: { dry: { type: "boolean" }, wet: { type: "boolean" } },
    };
    const args: Record<string, unknown> = { dry: "true", wet: "false" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ dry: true, wet: false });
  });

  it("resolves declared type through anyOf (union)", () => {
    const schema = {
      type: "object",
      properties: { n: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    };
    const args: Record<string, unknown> = { n: "42" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ n: 42 });
  });

  it("resolves declared type through array-form type with null (nullable)", () => {
    const schema = {
      type: "object",
      properties: { n: { type: ["integer", "null"] } },
    };
    const args: Record<string, unknown> = { n: "7" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ n: 7 });
  });

  it("respects `nullable: true` keyword (still coerces the integer arm)", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer", nullable: true } },
    };
    const args: Record<string, unknown> = { n: "9" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ n: 9 });
  });

  it("NEVER coerces when string is also an allowed type (anyOf string|number)", () => {
    const schema = {
      type: "object",
      properties: { id: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const args: Record<string, unknown> = { id: "123" };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ id: "123" }); // stays a string
    expect(breadcrumbs).toEqual([]);
  });

  it("NEVER coerces an enum (fixed values, often strings)", () => {
    const schema = {
      type: "object",
      properties: { mode: { enum: ["1", "2", "3"] } },
    };
    const args: Record<string, unknown> = { mode: "2" };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ mode: "2" });
    expect(breadcrumbs).toEqual([]);
  });

  it("NEVER coerces a plain string property", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const args: Record<string, unknown> = { name: "42" };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ name: "42" });
    expect(breadcrumbs).toEqual([]);
  });

  it("does NOT coerce a large id-like string lossily (Number.isSafeInteger guard)", () => {
    const schema = { type: "object", properties: { id: { type: "integer" } } };
    const big = "12345678901234567890"; // > Number.MAX_SAFE_INTEGER
    const args: Record<string, unknown> = { id: big };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ id: big }); // stays a string
    expect(breadcrumbs).toEqual([]);
  });

  it("rejects non-canonical numeric strings (leading zero / hex / whitespace)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "number" }, c: { type: "integer" } },
    };
    const args: Record<string, unknown> = { a: "007", b: "0x10", c: " 5 " };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    // "007" leading-zero rejected; "0x10" hex rejected; " 5 " whitespace rejected — all
    // fall through to the repair-ticket rather than being silently reshaped.
    expect(args).toEqual({ a: "007", b: "0x10", c: " 5 " });
    expect(breadcrumbs).toEqual([]);
  });

  it("does not coerce a fractional string for an integer-only property", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } } };
    const args: Record<string, unknown> = { n: "1.5" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ n: "1.5" });
  });

  // Cross-family GPT review (Stage 0): integer-only fields must reject non-canonical
  // spellings that Number() would otherwise silently accept as equivalent integers.
  it("does NOT coerce non-canonical integer spellings for an integer-only field (-0, 1.0, 1e3, whitespace)", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "integer" },
        b: { type: "integer" },
        c: { type: "integer" },
        d: { type: "integer" },
      },
    };
    const args: Record<string, unknown> = { a: "-0", b: "1.0", c: "1e3", d: " 5 " };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ a: "-0", b: "1.0", c: "1e3", d: " 5 " }); // all left as strings
    expect(breadcrumbs).toEqual([]);
  });

  it("DOES coerce canonical integers (0, positive, negative) for an integer-only field", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" }, c: { type: "integer" } },
    };
    const args: Record<string, unknown> = { a: "0", b: "40", c: "-7" };
    const { breadcrumbs } = coerceArgsToSchema(args, schema);
    expect(args).toEqual({ a: 0, b: 40, c: -7 });
    expect(breadcrumbs.map(formatAutoRepairBreadcrumb)).toEqual([
      "auto_repair_coerce:a",
      "auto_repair_coerce:b",
      "auto_repair_coerce:c",
    ]);
  });

  it("still accepts fractional/exponent forms for a `number` (non-integer) field", () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    const args: Record<string, unknown> = { x: "1.5" };
    coerceArgsToSchema(args, schema);
    expect(args).toEqual({ x: 1.5 });
  });
});

describe("canonicalKeyNormalize — reserved keys", () => {
  it("never rewrites reserved top-level keys (_meta / structuredContent)", () => {
    const schema = { type: "object", properties: { meta: { type: "object" } } };
    // `_meta` canonicalizes to `meta` which IS a schema prop, but it must be left alone.
    const args: Record<string, unknown> = { _meta: { x: 1 } };
    const { breadcrumbs } = canonicalKeyNormalize(args, schema);
    expect(args).toEqual({ _meta: { x: 1 } });
    expect(breadcrumbs).toEqual([]);
  });
});
