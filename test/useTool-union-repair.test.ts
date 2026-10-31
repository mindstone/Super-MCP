import { describe, expect, it, vi } from "vitest";
import { diagnosticDisplayPath, handleUseTool } from "../src/handlers/useTool.js";
import { Validator } from "../src/validator.js";
import { getLogger } from "../src/logging.js";
import * as fuzzyMatch from "../src/utils/fuzzyMatch.js";
import inboxReferenceSchema from "./fixtures/inbox-reference-schema.json";
import displayCases from "./fixtures/display-path-cases.json";
import schemas from "./fixtures/union-connector-schemas.json";

// Full inputSchema copies from union-boundary/schemas-*.json; canvas from the
// runtime inventory. No branch is simplified, so local $refs retain their targets.
const nullable = { type: "object", properties: { obj: { anyOf: [
  { type: "object", properties: { b: { type: "string" }, c: { type: "string" } }, required: ["b", "c"] },
  { type: "null" },
] } } };
const overlap = { type: "object", properties: { value: { oneOf: [{ type: "number" }, { type: "integer" }] } } };
const fixed = { type: "object", properties: { value: { const: "fixed" } } };
const references = { type: "object", properties: { references: { type: "array", items: { anyOf: [
  { type: "object", properties: { kind: { const: "url" }, url: { type: "string" } }, required: ["kind", "url"] },
  { type: "object", properties: { kind: { const: "file" }, path: { type: "string" } }, required: ["kind", "path"] },
] } } } };
let sequence = 0;
function dependencies(schema: any, validator = new Validator()) {
  return [
    { getPackage: () => ({ id: "fixture" }), notifyActivity: () => {} },
    { ensurePackageLoaded: async () => {}, getPackageStatus: () => "ready",
      getRefreshInFlight: () => false, getPackageError: () => undefined,
      getRetryHint: () => ({ retryAt: null, retryInMs: null, schedule: "none" }),
      getTool: (packageId: string, name: string) => ({ packageId, tool: { name, inputSchema: schema }, schemaHash: "fixture" }),
      getToolSchema: () => schema },
    validator,
  ] as const;
}
async function call(schema: any, args: any, options: { scope?: string; validator?: Validator } = {}) {
  const [registry, catalog, validator] = dependencies(schema, options.validator);
  return handleUseTool({ package_id: "fixture", tool_id: "union", args: structuredClone(args), dry_run: true,
    _rebel_attempt_scope: options.scope ?? `union-${++sequence}` }, registry as any, catalog as any, validator);
}
async function failure(schema: any, args: any, options?: Parameters<typeof call>[2]) {
  const error = await call(schema, args, options).then(() => { throw Error("Expected rejection"); }, e => e);
  expect(error.code).toBe(-33003);
  expect(error.message).toContain("Argument validation failed for tool 'union' in package 'fixture'.");
  expect(error.message.length).toBeLessThan(2000);
  return { error, ticket: error.data.repair_ticket, message: error.message as string };
}
const rule = { type: "alias", string_to_replace: "demo", alias: "dem-oh" };
const pronunciation = (value: any) => ({ name: "Demo", rules: [value] });
const panda = (value: any) => ({ template_uuid: "template", recipients: [{ email: "jane@example.com" }],
  pricing_tables: [{ name: "Pricing", sections: [{ title: "Items", rows: [{ data: { Discount: { type: "percent", value } } }] }] }] });

describe("union rejection repair tickets", () => {
  it.each([undefined, "https://json-schema.org/draft/2020-12/schema"])(
    "masks nested resource scopes with dialect %s", async ($schema) => {
      const entry = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
      const schema = { ...($schema ? { $schema } : {}), $id: "https://example.com/root.json", type: "object",
        $defs: { entry }, properties: { data: { $id: "local.json", type: "object",
          $defs: { entry: { ...entry, patternProperties: { "^entry_": { type: "string" } } } },
          properties: { payload: { $ref: "#/$defs/entry" } } } } };
      const { error, ticket, message } = await failure(schema, { data: { payload: { "value_private@example.com": "demo" } } });
      expect(ticket.unknown_fields).toEqual(["data.*.*"]);
      expect(ticket.did_you_mean).toEqual({});
      expect(message).not.toContain("value_private@example.com");
      expect(error.data.errors.some((e: any) => e.params.additionalProperty === "value_private@example.com")).toBe(true);
    });
  it.each(["$id", "id", "$anchor", "$dynamicAnchor", "if", "x-vendor"])(
    "scans unused definitions and sibling branches for %s", async (keyword) => {
      const entry = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
      const schema = { type: "object", properties: { data: entry, sibling: { allOf: [{}], $defs: {
        unused: { [keyword]: keyword.startsWith("$") || keyword === "id" ? "local" : {} },
      } } } };
      const { ticket, message } = await failure(schema, { data: { vaule: "demo" } });
      expect(ticket.unknown_fields).toEqual(["data.*"]);
      expect(ticket.did_you_mean).toEqual({});
      expect(message).not.toContain("vaule");
    });
  it("keeps root resource ids and annotation data readable", () => {
    const schema = { $id: "https://example.com/root.json", type: "object", properties: {
      data: { type: "object", properties: { value: { type: "string", default: "demo",
        examples: ["demo"], enum: ["demo"] } } },
    } };
    expect(diagnosticDisplayPath(schema, { data: { value: 1 } })("/data/value")).toBe("data.value");
  });
  it.each(["default", "examples", "enum", "const"])("scans object-valued %s too, including possible local ref targets", async (keyword) => {
    const schema = { properties: { data: { properties: { value: {} }, additionalProperties: false } },
      $defs: { unused: { [keyword]: ["enum", "examples"].includes(keyword) ? [{ if: {} }] : { if: {} } } } };
    const { ticket } = await failure(schema, { data: { vaule: "demo" } });
    expect(ticket.unknown_fields).toEqual(["data.*"]);
    expect(ticket.did_you_mean).toEqual({});
  });
  it("keeps propertyNames validation readable without treating names as value paths", () => {
    const schema = { properties: { data: { propertyNames: { type: "string" }, properties: { value: {} } } } };
    expect(diagnosticDisplayPath(schema, {})("/data/value")).toBe("data.value");
  });
  it("makes no budget-escaping Object.keys pass across 200 real validation errors", async () => {
    const data: Record<string, unknown> = { type: "object", additionalProperties: { type: "object", maxProperties: 1 } };
    for (let i = 0; i < 100_000; i++) data[`x-${i}`] = true;
    const schema = { type: "object", properties: { data } };
    const validator = new Validator();
    expect(validator.validate(schema, { data: {} }).valid).toBe(true);
    const args = { data: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`entry_${i}`, { a: 1, b: 2 }])) };
    const keys = vi.spyOn(Object, "keys");
    try {
      const error = await call(schema, args, { validator }).catch(e => e);
      expect(error.code).toBe(-33003);
      expect(error.data.errors).toHaveLength(200);
      const enumerated = keys.mock.calls.reduce((sum, [node], index) =>
        sum + (node === data ? keys.mock.results[index].value.length : 0), 0);
      expect(enumerated).toBeLessThanOrEqual(2_000);
      expect(error.data.repair_ticket.other_errors).toEqual([
        { field: "data.*", constraint: "maxProperties", expected: "must NOT have more than 1 properties" },
      ]);
      expect(error.data.repair_ticket.did_you_mean).toEqual({});
    } finally { keys.mockRestore(); }
  });
  it("charges every enumerated schema and property-map key to one scan budget", () => {
    let enumerated = 0;
    const countKeys = (object: object) => {
      let previous: string | symbol | undefined;
      return new Proxy(object, {
        getOwnPropertyDescriptor(target, key) {
          // for-in and hasOwn inspect the same key consecutively; count it once.
          if (key !== previous) enumerated++;
          previous = key;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    };
    const properties = countKeys(Object.fromEntries(Array.from({ length: 25_000 }, (_, i) => [`field_${i}`, {}])));
    const schema = { type: "object", properties: { data: { properties: { value: {} } } }, $defs: { unused: { properties } } };
    const display = diagnosticDisplayPath(schema, {});
    const afterScan = enumerated;
    for (let i = 0; i < 200; i++) expect(display("/data/value")).toBe("data.*");
    expect(afterScan).toBeGreaterThan(0);
    expect(afterScan).toBeLessThanOrEqual(20_001);
    expect(enumerated).toBe(afterScan);
  });
  it("masks all nested paths when the scan budget runs out on schema keywords", () => {
    let enumerated = 0;
    const nodes = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => {
      let previous: string | symbol | undefined;
      return [i, new Proxy({ type: "object", title: "Entry", description: "Entry", deprecated: false }, {
        getOwnPropertyDescriptor(target, key) {
          if (key !== previous) enumerated++;
          previous = key;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      })];
    }));
    const schema = { properties: { data: { properties: { value: {} } } }, $defs: nodes };
    const display = diagnosticDisplayPath(schema, {});
    for (let i = 0; i < 200; i++) expect(display("/data/value")).toBe("data.*");
    expect(enumerated).toBeGreaterThan(0);
    expect(enumerated).toBeLessThanOrEqual(20_001);
    expect(display("/data")).toBe("data");
    expect(display("", "vaule", true, { properties: { value: {} } })).toBe("vaule");
  });
  it.each([
    ["unsupported_schema_keyword", { properties: { data: {} }, "x-vendor": true }],
    ["scan_incomplete", { properties: { data: {} }, $defs: { many: { properties: Object.fromEntries(Array.from({ length: 25_000 }, (_, i) => [`field_${i}`, {}])) } } }],
  ])("logs why nested paths were masked, without schema or argument text: %s", (reason, schema) => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      diagnosticDisplayPath(schema, { data: "private@example.com" })("/data");
      expect(warn.mock.calls).toEqual([["Nested diagnostic paths masked", { reason }]]);
    } finally { warn.mockRestore(); }
  });
  it("keeps nested paths readable on a schema over the old 2,000 key budget", () => {
    const schema = { properties: { data: { properties: { value: {} } } }, $defs: { many: { properties: Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`field_${i}`, {}])) } } };
    expect(diagnosticDisplayPath(schema, {})("/data/value")).toBe("data.value");
  });
  it("never executes a skipped schema regex during display traversal", async () => {
    const schema = { type: "object", properties: { data: { allOf: [
      { anyOf: [{ type: "object" }, { type: "object", patternProperties: { "^(a+)+$": {} } }] },
      { type: "object", additionalProperties: { type: "object", maxProperties: 1 } },
    ] } } };
    const test = vi.spyOn(RegExp.prototype, "test");
    try {
      const { ticket } = await failure(schema, { data: { ["a".repeat(8) + "!"]: { a: 1, b: 2 } } });
      expect(ticket.other_errors[0].field).toBe("data.*");
      expect(test.mock.contexts.filter(regex => regex.source === "^(a+)+$")).toHaveLength(0);
    } finally { test.mockRestore(); }
  });
  it.each(["direct", "allOf", "ref"])("masks conditional pattern maps reached through %s", async (route) => {
    const conditional = {
      if: { type: "object" }, then: { type: "object", properties: { value: { type: "string" } },
        patternProperties: { "^entry_": { type: "string" } }, additionalProperties: false },
    };
    const schema = { type: "object", properties: { data: route === "direct" ? conditional
      : route === "allOf" ? { allOf: [conditional] } : { $ref: "#/$defs/conditional" } },
      $defs: { conditional } };
    const { ticket, message } = await failure(schema, { data: { "value_private@example.com": "demo" } });
    expect(ticket.unknown_fields).toEqual(["data.*"]);
    expect(ticket.did_you_mean).toEqual({});
    expect(message).not.toContain("value_private@example.com");
  });
  it.each(["if", "then", "else", "not", "dependentSchemas", "propertyNames", "unevaluatedProperties", "x-vendor"])(
    "masks the entire remaining path at an unsupported schema under %s", async (keyword) => {
      const fixed = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
      const schema = { type: "object", properties: { data: { ...fixed, [keyword]: keyword === "propertyNames" ? { if: {} } : {} } } };
      const errors = [{ keyword: "additionalProperties", instancePath: "/data/child", schemaPath: "#/additionalProperties",
        params: { additionalProperty: "vaule" }, parentSchema: fixed, data: { vaule: "demo" } }];
      const validator = { validate: () => ({ valid: false, errors, strippedArgs: [] }) } as unknown as Validator;
      const { ticket, message } = await failure(schema, { data: { child: { vaule: "demo" } } }, { validator });
      expect(ticket.unknown_fields).toEqual(["data.*.*"]);
      expect(ticket.did_you_mean).toEqual({});
      expect(message).not.toContain("child");
      expect(message).not.toContain("vaule");
    });
  it("does not expose unknown fields or suggestions beside a vendor extension", async () => {
    const schema = { type: "object", properties: { data: { type: "object", properties: { value: { type: "string" } },
      additionalProperties: false, "x-vendor": {} } } };
    const { ticket, message } = await failure(schema, { data: { vaule: "demo" } });
    expect(ticket.unknown_fields).toEqual(["data.*"]);
    expect(ticket.did_you_mean).toEqual({});
    expect(message).not.toContain("vaule");
  });
  it.each([false, true])("requires proof of a fixed parent for a final unknown field (AJV parent: %s)", async (fixedParent) => {
    const schema = { type: "object", properties: { data: {} } };
    const errors = [{ keyword: "additionalProperties", instancePath: "/data", schemaPath: "#/additionalProperties",
      params: { additionalProperty: "vaule" }, data: { vaule: "demo" },
      ...(fixedParent ? { parentSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false } } : {}) }];
    const validator = { validate: () => ({ valid: false, errors, strippedArgs: [] }) } as unknown as Validator;
    const { ticket } = await failure(schema, { data: { vaule: "demo" } }, { validator });
    expect(ticket.unknown_fields).toEqual([fixedParent ? "data.vaule" : "data.*"]);
    expect(ticket.did_you_mean).toEqual(fixedParent ? { "data.vaule": "value" } : {});
  });
  it("continues through every pattern schema and additionalProperties without matching", async () => {
    const schema = { type: "object", properties: { data: { type: "object",
      patternProperties: { "^one": { properties: { first: {} } }, "^two": { properties: { second: {} } } },
      additionalProperties: { properties: { third: {} } },
    } } };
    const errors = ["first", "second", "third"].map(key => ({ keyword: "type", instancePath: `/data/private/${key}`,
      schemaPath: "#/type", params: { type: "string" }, data: 1 }));
    const validator = { validate: () => ({ valid: false, errors, strippedArgs: [] }) } as unknown as Validator;
    const { ticket } = await failure(schema, { data: { private: { first: 1, second: 1, third: 1 } } }, { validator });
    expect(ticket.type_errors.map((error: any) => error.field)).toEqual(["data.*.first", "data.*.second", "data.*.third"]);
  });
  it.each(displayCases)("location-aware display: $name", async (fixture) => {
    const { error, ticket, message } = await failure(fixture.schema, fixture.args);
    const entries = ticket[fixture.list];
    expect(entries.map((entry: any) => typeof entry === "string" ? entry : entry.field)).toEqual([fixture.field]);
    expect(ticket.did_you_mean).toEqual(fixture.suggestions);
    expect(message).toContain(fixture.field);
    if (fixture.hidden) {
      expect(message).not.toContain(fixture.hidden);
      // Schema fragments are schema-derived and may include the unrelated declaration.
      const { schema_fragments, ...display } = ticket;
      expect(JSON.stringify(display)).not.toContain(fixture.hidden);
      expect(JSON.stringify(error.data.errors)).toContain(fixture.hidden);
    }
  });
  it.each(["unresolved", "inherited", "cyclic", "budget"])("masks incomplete display traversal: %s", async (reason) => {
    const schema = reason === "budget"
      ? { type: "object", properties: { data: { type: "string" } }, allOf: Array.from({ length: 2100 }, () => ({})) }
      : { type: "object", properties: { data: { $ref: reason === "inherited" ? "#/constructor/prototype" : reason === "cyclic" ? "#/$defs/loop" : "#/$defs/missing" } }, $defs: { loop: { $ref: "#/$defs/loop" } } };
    const errors = [{ keyword: "type", instancePath: "/data/value", schemaPath: "#/type", params: { type: "string" }, data: 1 }];
    const validator = { validate: () => ({ valid: false, errors, strippedArgs: [] }) } as unknown as Validator;
    const { ticket, message, error } = await failure(schema, { data: { value: 1 } }, { validator });
    expect(ticket.type_errors).toEqual([{ field: "*.*", expected: "string", got: "number", value: 1 }]);
    expect(message).toContain("*.* (expected string");
    expect(error.data.errors).toBe(errors);
  });
  it("removes a synthetic discriminator owned by an excluded enclosing branch", async () => {
    const schema = { type: "object", properties: { obj: { anyOf: [
      { type: "object", properties: { kind: { const: "a" }, payload: { anyOf: [
        { type: "object", properties: { mode: { const: "x" } }, required: ["mode"] },
        { type: "object", properties: { mode: { const: "y" } }, required: ["mode"] },
      ] } }, required: ["kind", "payload"] },
      { type: "object", properties: { kind: { const: "b" }, name: { type: "string" } }, required: ["kind", "name"], additionalProperties: true },
    ] } } };
    const args = { obj: { kind: "b", payload: { mode: "irrelevant" } } };
    const { ticket, message, error } = await failure(schema, args);
    expect(ticket.missing_required).toEqual(["obj.name"]);
    expect(ticket.enum_violations).toEqual([]);
    expect(ticket.other_errors).toBeUndefined();
    expect(message).not.toContain("payload");
    expect(error.data.errors.some((e: any) => e.instancePath.includes("payload"))).toBe(true);
    await expect(call(schema, { obj: { ...args.obj, name: "name" } })).resolves.toBeDefined();
  });
  it("does not suggest an already supplied ElevenLabs alias for alais", async () => {
    const { ticket, message } = await failure(schemas.add_pronunciation_dictionary, pronunciation({ ...rule, alais: "replace-this" }));
    expect(ticket.unknown_fields).toEqual(["rules.0.alais"]);
    expect(ticket.did_you_mean).toEqual({});
    expect(message).not.toContain("did you mean");
  });

  it("masks caller map keys in nested unknown-field prose and ticket paths", async () => {
    const { ticket, message, error } = await failure(schemas.create_document_from_template, {
      template_uuid: "template", recipients: [{ email: "jane@example.com" }],
      fields: { "private@example.com": { value: "demo", extra: true } },
    });
    expect(ticket.unknown_fields).toEqual(["fields.*.extra"]);
    expect(message).toContain("Unknown fields: fields.*.extra");
    expect(message).not.toContain("private@example.com");
    expect(JSON.stringify(ticket.unknown_fields)).not.toContain("private@example.com");
    expect(error.data.errors.some((e: any) => e.instancePath.includes("private@example.com"))).toBe(true);
  });
  it("masks caller map keys in other-error prose and ticket paths", async () => {
    const schema = { type: "object", properties: { data: { type: "object", additionalProperties: { type: "object", maxProperties: 1 } } } };
    const { ticket, message, error } = await failure(schema, { data: { "private@example.com": { a: 1, b: 2 } } });
    expect(ticket.other_errors).toEqual([{ field: "data.*", constraint: "maxProperties", expected: "must NOT have more than 1 properties" }]);
    expect(message).toContain("Other errors: data.* (maxProperties:");
    expect(message).not.toContain("private@example.com");
    expect(JSON.stringify(ticket.other_errors)).not.toContain("private@example.com");
    expect(error.data.errors[0].instancePath).toBe("/data/private@example.com");
  });
  it("masks numeric map keys while preserving real array indices", async () => {
    const schema = { type: "object", properties: { rows: { type: "array", items: { type: "object", additionalProperties: { type: "object", maxProperties: 1 } } } } };
    const { ticket, message } = await failure(schema, { rows: [{ "123456789": { a: 1, b: 2 } }] });
    expect(ticket.other_errors).toEqual([{ field: "rows.0.*", constraint: "maxProperties", expected: "must NOT have more than 1 properties" }]);
    expect(message).not.toContain("123456789");
  });
  it("skips suggestion work for 32,000-character names", async () => {
    const key = "b".repeat(32000);
    const schema = { type: "object", properties: { obj: { type: "object", properties: { ["a".repeat(32000)]: { type: "string" } }, additionalProperties: false } } };
    const lower = vi.spyOn(String.prototype, "toLowerCase");
    try {
      const error = await call(schema, { obj: { [key]: 1 } }).catch(e => e);
      expect(error.code).toBe(-33003);
      expect(error.data.repair_ticket.did_you_mean).toEqual({});
      expect(lower.mock.contexts.filter(value => String(value).length >= 32000)).toHaveLength(0);
    } finally { lower.mockRestore(); }
  });
  it("bounds suggestions across nested and top-level unknown fields per rejection", async () => {
    const match = vi.spyOn(fuzzyMatch, "findBestMatch");
    const obj = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`qurey_${i}`, true]));
    try {
      const error = await call({ type: "object", additionalProperties: false, properties: {
        query: { type: "string" }, obj: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      } }, { ...obj, obj }).catch(e => e);
      expect(error.code).toBe(-33003);
      const ticket = error.data.repair_ticket;
      expect(ticket.unknown_fields).toHaveLength(80);
      expect(match.mock.calls.length).toBeLessThanOrEqual(16);
    } finally { match.mockRestore(); }
  });
  it("rules out nested scalar wrappers on the real inbox references array schema", async () => {
    // Exact references subtree exported by rebel_inbox_add, including its nested union wrapper.
    const schema = { type: "object", properties: { title: { type: "string" }, references: inboxReferenceSchema } };
    const { ticket, message } = await failure(schema, { title: "Demo", references: [{ kind: "bogus", url: "https://example.com" }] });
    expect(ticket.type_errors).toEqual([]);
    expect(ticket.other_errors).toBeUndefined();
    expect(ticket.enum_violations).toEqual([expect.objectContaining({ field: "references.0.kind" })]);
    expect(message).not.toContain("expected object|string, got array");
  });

  it("names only the selected pronunciation rule's missing field", async () => {
    const { ticket, message, error } = await failure(schemas.add_pronunciation_dictionary, pronunciation({ ...rule, alias: undefined }));
    expect(ticket.missing_required).toEqual(["rules.0.alias"]);
    expect(message).not.toMatch(/phoneme|alphabet/);
    expect(error.data.errors.some((e: any) => e.params.missingProperty === "alphabet")).toBe(true);
  });
  it("teaches the discriminator's allowed values, without repeating the private mistake in prose", async () => {
    const { ticket, message } = await failure(schemas.add_pronunciation_dictionary, pronunciation({ ...rule, type: "private@example.com" }));
    expect(ticket.enum_violations).toEqual([{ field: "rules.0.type", allowed: ["alias", "phoneme"], got: "private@example.com" }]);
    expect(ticket.missing_required).toEqual([]);
    expect(message).not.toContain("private@example.com");
    expect(message).toContain("allowed alias, phoneme");
  });
  it("reports a nested forbidden field without top-level argument advice", async () => {
    const { ticket, message } = await failure(schemas.add_pronunciation_dictionary, pronunciation({ ...rule, phoneme: "demo" }));
    expect(ticket.unknown_fields).toEqual(["rules.0.phoneme"]);
    expect(message).not.toMatch(/Missing required|takes no arguments|Valid arguments/);
  });
  it("selects the external proxy inside the boolean-or-array wrapper", async () => {
    const { ticket, message } = await failure(schemas.create_session, { proxies: [{ type: "external" }] });
    expect(ticket.missing_required).toEqual(["proxies.0.server"]);
    expect(ticket.type_errors).toEqual([]);
    expect(message).not.toContain("expected boolean");
  });
  it("maps boolean const to enum, without the incompatible array branch", async () => {
    const { ticket, message } = await failure(schemas.create_session, { proxies: false });
    expect(ticket.enum_violations).toEqual([{ field: "proxies", allowed: [true], got: false }]);
    expect(ticket.type_errors).toEqual([]);
    expect(message).not.toMatch(/expected array|got false/);
  });
  it("joins primitive type alternatives into one error", async () => {
    const { ticket } = await failure(schemas.list_agents, { start_at: true });
    expect(ticket.type_errors).toEqual([{ field: "start_at", expected: "integer|string", got: "boolean", value: true }]);
  });
  it("reports the array member instead of the scalar alternative", async () => {
    const { ticket } = await failure(schemas.ga_run_report, { dimensions: [123] });
    expect(ticket.type_errors).toEqual([{ field: "dimensions.0", expected: "string", got: "number", value: 123 }]);
  });
  it.each([
    [["jane@example.com", "bad"], "to.1"],
    ["bad", "to"],
  ])("projects the Microsoft Mail scalar-or-array ref for %j", async (to, field) => {
    const { ticket, message } = await failure(schemas.send_email, { to, subject: "Demo", body: "Hello" });
    expect(ticket.format_errors).toEqual([{ field, expected: "email", got: "bad" }]);
    expect(ticket.type_errors).toEqual([]);
    expect(ticket.other_errors).toBeUndefined();
    expect(message).not.toContain("Other errors:");
  });
  it("attributes PandaDoc errors to local $ref branches", async () => {
    const { ticket, message, error } = await failure(schemas.create_document_from_template, panda("wrong"));
    expect(ticket.type_errors).toEqual([{ field: "pricing_tables.0.sections.0.rows.0.data.*.value", expected: "number", got: "string", value: "wrong" }]);
    expect(ticket.other_errors).toBeUndefined();
    expect(message).not.toContain("Other errors:");
    expect(message).not.toContain("Discount");
    expect(error.data.errors.some((e: any) => e.instancePath.endsWith("/data/Discount/value"))).toBe(true);
  });
  it("keeps compatible preset and format errors and labels them as alternatives", async () => {
    const { ticket, message } = await failure(schemas.generate_speech, { text: "Hello", voice: "unlisted-voice" });
    expect(ticket.enum_violations).toHaveLength(1);
    expect(ticket.format_errors).toEqual([{ field: "voice", expected: "uuid", got: "unlisted-voice" }]);
    expect(ticket.other_errors).toHaveLength(1);
    expect(message).toMatch(/Other errors:.*alternatives/);
    expect(message.indexOf("Other errors:")).toBeGreaterThan(message.indexOf("Format errors:"));
    // Existing plain-enum prose is unchanged.
    expect(message).toContain("got unlisted-voice");
  });
  it("selects a nullable object from decisive AJV type evidence", async () => {
    const { ticket } = await failure(nullable, { obj: {} });
    expect(ticket.missing_required).toEqual(["obj.b", "obj.c"]);
    expect(ticket.type_errors).toEqual([]);
  });
  it("does not choose the compatible alternative with fewer errors", async () => {
    const schema = { type: "object", properties: { obj: { anyOf: [
      nullable.properties.obj.anyOf[0],
      { type: "object", properties: { d: { type: "string" } }, required: ["d"] },
    ] } } };
    const { ticket } = await failure(schema, { obj: {} });
    expect(ticket.missing_required).toEqual(["obj.b", "obj.c", "obj.d"]);
    expect(ticket.other_errors).toEqual([{ field: "obj", constraint: "anyOf", expected: "listed errors describe alternatives" }]);
  });
  it("explains a oneOf overlap with no child errors", async () => {
    const { ticket, message } = await failure(overlap, { value: 1 });
    expect(ticket.other_errors).toEqual([{ field: "value", constraint: "oneOf", expected: "matches more than one alternative; exactly one is allowed" }]);
    expect(message).toContain("exactly one is allowed");
  });
  it("reports a non-union const without repeating the private mistake", async () => {
    const { ticket, message } = await failure(fixed, { value: "private@example.com" });
    expect(ticket.enum_violations).toEqual([{ field: "value", allowed: ["fixed"], got: "private@example.com" }]);
    expect(message).toContain("allowed fixed");
    expect(message).not.toContain("private@example.com");
  });
  it("preserves the missing-discriminator replay contract", async () => {
    const { ticket, message } = await failure(references, { references: [{ url: "https://example.com" }] });
    expect(ticket.missing_required).toEqual(["references.0.kind"]);
    expect(ticket.unknown_fields).toEqual([]);
    expect(message).toContain("Missing required: references.0.kind");
  });
  it.each([false, true])("does not invent a required discriminator when some candidates leave it optional (%s)", async (mixed) => {
    const schema = { type: "object", properties: { obj: { anyOf: [
      { type: "object", properties: { mode: { const: "a" }, name: { type: "string" } }, ...(mixed ? { required: ["mode"] } : {}) },
      { type: "object", properties: { mode: { const: "b" }, name: { type: "string" } } },
    ] } } };
    const { ticket, message } = await failure(schema, { obj: { name: 5 } });
    expect(ticket.type_errors).toEqual([{ field: "obj.name", expected: "string", got: "number", value: 5 }]);
    expect(ticket.missing_required).toEqual(mixed ? ["obj.mode"] : []);
    expect(message).toContain("expected string");
    // An optional discriminator still selects its branch when supplied; the
    // other branch's const failure must not distract from the invalid name.
    const selected = await failure(schema, { obj: { mode: "a", name: 5 } });
    expect(selected.ticket.type_errors).toEqual([{ field: "obj.name", expected: "string", got: "number", value: 5 }]);
    expect(selected.ticket.enum_violations).toEqual([]);
    expect(selected.ticket.missing_required).toEqual([]);
    expect(selected.ticket.other_errors).toBeUndefined();
  });
  it("keeps a real error when a ruled-out branch schema is reused deeper in the selected branch", async () => {
    const schema = { type: "object", properties: { obj: { anyOf: [
      { type: "object", properties: { kind: { const: "leaf" }, name: { type: "string" } }, required: ["kind", "name"] },
      { type: "object", properties: { kind: { const: "group" }, children: { type: "array", items: { $ref: "#/properties/obj/anyOf/0" } } }, required: ["kind", "children"] },
    ] } } };
    const { ticket } = await failure(schema, { obj: { kind: "group", children: [{ kind: "leaf", name: 5 }] } });
    expect(ticket.type_errors).toEqual([{ field: "obj.children.0.name", expected: "string", got: "number", value: 5 }]);
    expect(ticket.missing_required).toEqual([]);
    expect(ticket.enum_violations).toEqual([]);
  });
  it("suggests nested field names from the selected branch's parent schema", async () => {
    const { ticket, message } = await failure(schemas.add_pronunciation_dictionary, pronunciation({ type: rule.type, string_to_replace: rule.string_to_replace, alais: "demo" }));
    expect(ticket.unknown_fields).toEqual(["rules.0.alais"]);
    expect(ticket.did_you_mean).toEqual({ "rules.0.alais": "alias" });
    expect(message).toContain("rules.0.alais (did you mean: alias?)");
    expect(message).not.toContain("Valid arguments:");
  });
  it("does not confuse canvas branch 1 with branches 10–13", async () => {
    expect(schemas.rebel_canvas_form.properties.fields.items.oneOf).toHaveLength(14);
    const { ticket, message } = await failure(schemas.rebel_canvas_form, { title: "Demo", actionId: "demo", fields: [{ id: "note", type: "longtext", default: 42 }] });
    expect(ticket.missing_required).toEqual(["fields.0.label"]);
    expect(ticket.type_errors).toEqual([{ field: "fields.0.default", expected: "string", got: "number", value: 42 }]);
    expect(ticket.enum_violations).toEqual([]);
    expect(ticket.other_errors).toBeUndefined();
    expect(message).not.toContain("Other errors:");
  });
  it("projects a bulk canvas form without exhausting the budget on sibling errors", async () => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      const fields = Array.from({ length: 20 }, (_, i) => ({ id: `note-${i}`, type: "longtext", default: 42 }));
      const { ticket } = await call(schemas.rebel_canvas_form, { title: "Demo", actionId: "demo", fields }).then(() => { throw Error("Expected rejection"); }, error => ({ ticket: error.data.repair_ticket }));
      expect(ticket.missing_required).toEqual(fields.map((_, i) => `fields.${i}.label`));
      expect(ticket.type_errors).toHaveLength(fields.length);
      expect(ticket.enum_violations).toEqual([]);
      expect(ticket.other_errors).toBeUndefined();
      expect(warn.mock.calls.some(c => JSON.stringify(c).includes("projection"))).toBe(false);
    } finally { warn.mockRestore(); }
  });
  it("projects 60 invalid spreadsheet cells without falling back to raw alternatives", async () => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      const args = { spreadsheet_id: "demo", range: "A1", values: [Array(60).fill({ invalid: true })] };
      const { error } = await call(schemas.append_to_workspace_spreadsheet, args).then(() => { throw Error("Expected rejection"); }, error => ({ error }));
      expect(error.code).toBe(-33003);
      expect(error.data.repair_ticket.type_errors).toHaveLength(60);
      expect(error.data.repair_ticket.other_errors).toBeUndefined();
      expect(warn.mock.calls.some(c => JSON.stringify(c).includes("projection"))).toBe(false);
    } finally { warn.mockRestore(); }
  });
  it.each([
    [schemas.add_pronunciation_dictionary, pronunciation(rule)],
    [schemas.create_session, { proxies: [{ type: "external", server: "http://proxy.example.com:8080" }] }],
    [schemas.list_agents, { start_at: 1 }], [schemas.ga_run_report, { dimensions: ["country"] }],
    [schemas.create_document_from_template, panda(10)], [schemas.generate_speech, { text: "Hello", voice: "Maya" }],
    [schemas.send_email, { to: ["jane@example.com"], subject: "Demo", body: "Hello" }],
    [schemas.send_email, { to: "jane@example.com", subject: "Demo", body: "Hello" }],
    [schemas.append_to_workspace_spreadsheet, { spreadsheet_id: "demo", range: "A1", values: [["demo", 1, true, null]] }],
    [nullable, { obj: { b: "b", c: "c" } }], [nullable, { obj: null }],
    [overlap, { value: 1.5 }], [fixed, { value: "fixed" }],
    [references, { references: [{ kind: "url", url: "https://example.com" }] }],
    [schemas.rebel_canvas_form, { title: "Demo", actionId: "demo", fields: [{ id: "note", label: "Note", type: "longtext" }] }],
  ])("still accepts valid fixture %#", async (schema, args) => {
    expect(await call(schema, args)).toMatchObject({
      isError: false,
      _meta: { superMcp: { dryRun: true } },
    });
  });
  it("preserves existing ticket keys and the third-attempt stop guidance", async () => {
    const scope = `contract-${++sequence}`;
    let result;
    for (let i = 0; i < 3; i++) result = await failure(references, { references: [{ kind: "wrong", url: "https://example.com" }] }, { scope });
    expect(result!.message).toContain("These arguments have failed validation several times. Stop re-sending the same call shape — change the call or report what failed.");
    expect(Object.keys(result!.ticket).sort()).toEqual(["attempt", "did_you_mean", "enum_violations", "format_errors", "missing_required", "schema_fragments", "type_errors", "unknown_fields", "valid_fields"]);
    expect(result!.ticket.attempt).toBe(3);
    expect(result!.ticket.enum_violations).toEqual([{ field: "references.0.kind", allowed: ["url", "file"], got: "wrong" }]);
    expect(result!.ticket.missing_required).toEqual([]);
  });
  it("falls back to raw errors on cyclic local refs and logs no submitted values", async () => {
    const schema = { type: "object", $defs: { loop: { $ref: "#/$defs/loop" } } };
    const errors = [{ keyword: "anyOf", instancePath: "/value/instance-path-private-sentinel", schemaPath: "#/properties/value/anyOf", params: {}, schema: [{ $ref: "#/$defs/loop" }], data: "private@example.com", message: "must match a schema in anyOf" }];
    const warn = vi.spyOn(getLogger(), "warn");
    const validator = { validate: () => ({ valid: false, errors, strippedArgs: [] }) } as unknown as Validator;
    try {
      const { error, ticket } = await failure(schema, {}, { validator });
      expect(error.data.errors).toEqual(errors);
      expect(ticket.other_errors).toEqual([{ field: "*.*", constraint: "anyOf", expected: "must match a schema in anyOf" }]);
      const warning = warn.mock.calls.find(c => JSON.stringify(c).includes("projection"));
      expect(warning).toBeDefined();
      expect(JSON.stringify(warning)).not.toContain("private@example.com");
      expect(JSON.stringify(warning)).not.toContain("instance-path-private-sentinel");
      expect(warning?.[1]).toEqual({ errorCount: 1, errors: [{ keyword: "anyOf", schemaPath: "#/properties/value/anyOf" }] });
    } finally { warn.mockRestore(); }
  });
  it("bounds projection work on a 1,000-cell spreadsheet append", async () => {
    const warn = vi.spyOn(getLogger(), "warn");
    try {
      const args = { spreadsheet_id: "demo", range: "A1", values: [Array(1000).fill({ invalid: true })] };
      const { error } = await call(schemas.append_to_workspace_spreadsheet, args).then(() => { throw Error("Expected rejection"); }, error => ({ error }));
      expect(error.code).toBe(-33003);
      expect(error.data.errors).toHaveLength(5000);
      const ticket = error.data.repair_ticket;
      const raw = error.data.errors;
      const field = (path: string) => path.slice(1).split("/").join(".");
      expect(ticket.type_errors).toEqual(raw.filter((e: any) => e.keyword === "type").map((e: any) => ({
        field: field(e.instancePath), expected: e.params.type, got: "object", value: { invalid: true },
      })));
      expect(ticket.other_errors).toEqual(raw.filter((e: any) => ["anyOf", "oneOf"].includes(e.keyword)).map((e: any) => ({
        field: field(e.instancePath), constraint: e.keyword, expected: e.message,
      })));
      expect(ticket.missing_required).toEqual([]);
      expect(ticket.enum_violations).toEqual([]);
      expect(ticket.format_errors).toEqual([]);
      expect(ticket.unknown_fields).toEqual([]);
      expect(warn.mock.calls.some(c => JSON.stringify(c).includes("projection"))).toBe(true);
      // Without verbose branch lists there is nothing to project: this is the
      // ordinary raw-error ticket, including fragments and optional fields.
      const rawErrors = raw.map(({ schema: _schema, ...error }: any) => error);
      const validator = { validate: () => ({ valid: false, errors: rawErrors, strippedArgs: [] }) } as unknown as Validator;
      warn.mockClear();
      const rawError = await call(schemas.append_to_workspace_spreadsheet, args, { validator }).then(() => { throw Error("Expected rejection"); }, error => error);
      expect(ticket).toEqual(rawError.data.repair_ticket);
      expect(warn.mock.calls.some(c => JSON.stringify(c).includes("projection"))).toBe(false);
    } finally { warn.mockRestore(); }
  });
});
