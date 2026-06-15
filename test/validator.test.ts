import { describe, it, expect, vi } from "vitest";
import { Validator, ValidationError } from "../src/validator.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES } from "../src/types.js";
import { McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../src/logging.js";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function createUseToolDeps(
  schema: any,
  options?: {
    callTool?: (toolId: string, args: any) => Promise<any>;
    schemaHash?: string;
  },
) {
  const callTool = options?.callTool ?? (async () => ({ ok: true }));
  const schemaHash = options?.schemaHash ?? "sha256:current-schema";

  const registry = {
    getPackage: () => ({ id: "mock" }),
    getClient: async () => ({
      callTool: async (toolId: string, args: any) => callTool(toolId, args),
    }),
    notifyActivity: () => {},
  };

  const catalog = {
    ensurePackageLoaded: async () => {},
    getPackageStatus: () => "ready",
    getPackageError: () => null,
    getTool: async () => ({
      tool: {
        inputSchema: schema,
      },
      schemaHash,
    }),
    getToolSchema: async () => schema,
  };

  return {
    registry,
    catalog,
    validator: new Validator(),
  };
}

async function runValidationFailure(options: {
  schema: any;
  args: any;
  packageId?: string;
  toolId?: string;
}) {
  const packageId = options.packageId ?? nextId("pkg");
  const toolId = options.toolId ?? nextId("tool");
  const { registry, catalog, validator } = createUseToolDeps(options.schema);

  try {
    await handleUseTool(
      {
        package_id: packageId,
        tool_id: toolId,
        args: options.args,
        dry_run: true,
      },
      registry as any,
      catalog as any,
      validator,
    );
    throw new Error("Expected validation failure");
  } catch (error) {
    return error as any;
  }
}

async function runDownstreamInvalidParams(options: {
  schema: any;
  args: any;
  packageId?: string;
  toolId?: string;
  message?: string;
  data?: unknown;
}) {
  const packageId = options.packageId ?? nextId("pkg");
  const toolId = options.toolId ?? nextId("tool");
  const { registry, catalog, validator } = createUseToolDeps(options.schema, {
    callTool: async () => {
      throw new McpError(
        SdkErrorCode.InvalidParams,
        options.message ?? "Downstream rejected params",
        options.data,
      );
    },
  });

  try {
    await handleUseTool(
      {
        package_id: packageId,
        tool_id: toolId,
        args: options.args,
        dry_run: false,
      },
      registry as any,
      catalog as any,
      validator,
    );
    throw new Error("Expected downstream invalid params failure");
  } catch (error) {
    return error as any;
  }
}

function expectRepairTicket(error: any): any {
  expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
  expect(typeof error.message).toBe("string");
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.data).toBeDefined();
  expect(error.data.repair_ticket).toBeDefined();
  return error.data.repair_ticket;
}

describe("Validator", () => {
  it("returns valid=true for valid data", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const result = validator.validate(schema, { name: "test", age: 25 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.strippedArgs).toEqual([]);
  });

  it("returns valid=false for missing required field", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };

    const result = validator.validate(schema, {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid=false for invalid type", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        age: { type: "number" },
      },
    };

    const result = validator.validate(schema, { age: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("throws ValidationError when schema is missing", () => {
    const validator = new Validator();
    expect(() => validator.validate(null, {})).toThrow(ValidationError);
  });

  describe("arg stripping (additionalProperties: false)", () => {
    it("strips unknown top-level properties and returns their names", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      };
      const data = { query: "test", limit: 10, mode: "fast" };
      const result = validator.validate(schema, data);
      expect(result.valid).toBe(true);
      expect(result.strippedArgs).toEqual(["limit", "mode"]);
      expect(data).toEqual({ query: "test" });
    });

    it("returns empty array when no unknown properties", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        additionalProperties: false,
      };
      const result = validator.validate(schema, { query: "test" });
      expect(result.strippedArgs).toEqual([]);
    });

    it("does not strip when additionalProperties is true", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        additionalProperties: true,
      };
      const data = { query: "test", extra: "value" };
      const result = validator.validate(schema, data);
      expect(result.strippedArgs).toEqual([]);
      expect(data).toHaveProperty("extra");
    });

    it("handles null and non-object data gracefully", () => {
      const validator = new Validator();
      const schema = { type: "string" };
      const result = validator.validate(schema, "hello");
      expect(result.strippedArgs).toEqual([]);
    });
  });
});

describe("use_tool repair tickets", () => {
  it("includes missing required fields in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: {} });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.missing_required).toContain("name");
    expect(repairTicket.schema_fragments).toHaveProperty("name");
  });

  it("includes type errors in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: { age: { type: "number" } },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { age: "twenty" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.type_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "age",
          expected: "number",
          got: "string",
        }),
      ]),
    );
  });

  it("includes enum violations in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed"],
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { status: "active" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.enum_violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "status",
          got: "active",
        }),
      ]),
    );
    expect(repairTicket.enum_violations[0].allowed).toEqual(["open", "closed"]);
  });

  it("includes format errors in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        start: {
          type: "string",
          format: "date-time",
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { start: "next Tuesday" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.format_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "start",
          expected: "date-time",
          got: "next Tuesday",
        }),
      ]),
    );
  });

  it("includes range errors in repair_ticket for maximum violations", async () => {
    const schema = {
      type: "object",
      properties: {
        amount: {
          type: "number",
          maximum: 50,
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { amount: 1000 } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.range_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "amount",
          constraint: "maximum",
          limit: 50,
          got: 1000,
        }),
      ]),
    );
  });

  it("includes pattern errors in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { date: "not-a-date" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.pattern_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          got: "not-a-date",
        }),
      ]),
    );
  });

  it("includes length errors in repair_ticket for maxLength violations", async () => {
    const schema = {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: 10,
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { title: "x".repeat(50) } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.length_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "title",
          constraint: "maxLength",
          limit: 10,
          got: "x".repeat(50),
        }),
      ]),
    );
  });

  it("omits new constraint arrays when no matching keyword errors are present", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: {} });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.range_errors).toBeUndefined();
    expect(repairTicket.pattern_errors).toBeUndefined();
    expect(repairTicket.length_errors).toBeUndefined();
  });

  it("includes range/pattern/length sections in summarized repair message", async () => {
    const schema = {
      type: "object",
      properties: {
        amount: { type: "number", maximum: 50 },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        title: { type: "string", maxLength: 5 },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: {
        amount: 1000,
        date: "next Tuesday",
        title: "this title is too long",
      },
    });

    expect(error.message).toContain("Range errors:");
    expect(error.message).toContain("Pattern errors:");
    expect(error.message).toContain("Length errors:");
  });

  it("uses stripped args as unknown_fields", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { qurey: "hello" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.unknown_fields).toContain("qurey");
  });

  it("Stage 0: snake/camel variant is now AUTO-REPAIRED (no repair ticket)", async () => {
    // Previously this produced a repair ticket with a `did_you_mean` hint.
    // The Stage 0 schema-driven auto-repair now renames the unambiguous
    // camelCase key to its canonical snake_case schema property and the call
    // succeeds, so no -33003 ticket is raised. See useTool.ts auto-repair seam.
    const schema = {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    };

    const { registry, catalog, validator } = createUseToolDeps(schema);
    const response = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { channelId: "123" },
        dry_run: true,
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual(["auto_repair_key:channelId→channel_id"]);
  });

  it("matches close typos via Levenshtein fallback", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { qurey: "test" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.did_you_mean).toEqual({ qurey: "query" });
  });

  it("rejects distant fuzzy matches", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { zzzzz: "test" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.did_you_mean).toEqual({});
  });

  it("aggregates multiple error categories in one repair ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["name"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: {
        age: "old",
        status: "active",
        emial: "test@example.com",
      },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.missing_required).toContain("name");
    expect(repairTicket.type_errors.length).toBeGreaterThan(0);
    expect(repairTicket.enum_violations.length).toBeGreaterThan(0);
    expect(repairTicket.unknown_fields).toContain("emial");
  });

  it("escalates on repeated failures with circuit breaker behavior", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const first = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const firstTicket = expectRepairTicket(first);
    expect(firstTicket.attempt).toBe(1);
    expect(firstTicket.schema_fragments).not.toHaveProperty("__full_schema");

    const second = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const secondTicket = expectRepairTicket(second);
    expect(secondTicket.attempt).toBe(2);
    expect(secondTicket.schema_fragments).toHaveProperty("__full_schema");

    const third = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const thirdTicket = expectRepairTicket(third);
    expect(thirdTicket.attempt).toBe(3);
    expect(thirdTicket.schema_fragments).toHaveProperty("__full_schema");
    expect(third.message).toContain("Arguments may require user clarification");
  });

  it("caps schema_fragments to 5 entries for surgical tickets", async () => {
    const properties: Record<string, { type: string }> = {};
    const args: Record<string, string> = {};

    for (let i = 0; i < 10; i += 1) {
      const key = `field_${i}`;
      properties[key] = { type: "number" };
      args[key] = "bad";
    }

    const schema = {
      type: "object",
      properties,
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args });
    const repairTicket = expectRepairTicket(error);
    expect(Object.keys(repairTicket.schema_fragments).length).toBeLessThanOrEqual(5);
  });

  it("enriches downstream InvalidParams with field schema fragments on attempt 1", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 3 },
        limit: { type: "number", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runDownstreamInvalidParams({
      schema,
      args: { query: "hello" },
      packageId,
      toolId,
      message: "query must include tenant context",
      data: { source: "mock-server" },
    });

    const repairTicket = expectRepairTicket(error);
    expect(error.message).toContain(`Downstream validation failed for tool '${toolId}'`);
    expect(repairTicket.attempt).toBe(1);
    expect(repairTicket.schema_fragments).toHaveProperty("query");
    expect(repairTicket.schema_fragments).not.toHaveProperty("__full_schema");
    expect(repairTicket.range_errors).toEqual([]);
    expect(repairTicket.pattern_errors).toEqual([]);
    expect(repairTicket.length_errors).toEqual([]);
    expect(repairTicket.downstream_error).toContain("query must include tenant context");
  });

  it("classifies downstream output validation without an argument repair ticket", async () => {
    const error = await runDownstreamInvalidParams({
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      args: { query: "events" },
      message: "Output validation failed: startDate must be string, received Date",
      data: { path: ["events", 0, "startDate"], expected: "string", received: "Date" },
    });

    expect(error.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(error.message).toContain("Downstream output validation failed");
    expect(error.data.validation_direction).toBe("output");
    expect(error.data.repair_ticket).toBeUndefined();
  });

  it("classifies SDK structured content output-schema failures as downstream output validation", async () => {
    const error = await runDownstreamInvalidParams({
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      args: { query: "events" },
      message: "Structured content does not match the tool's output schema: startDate must be string",
    });

    expect(error.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(error.message).toContain("Downstream output validation failed");
    expect(error.data.validation_direction).toBe("output");
    expect(error.data.repair_ticket).toBeUndefined();
  });

  it("does not classify input validation for an output argument as output validation", async () => {
    const schema = {
      type: "object",
      properties: {
        output: { type: "string" },
      },
      required: ["output"],
    };

    const error = await runDownstreamInvalidParams({
      schema,
      args: { output: "not-a-url" },
      message: "Input validation error: output must be a URL",
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.attempt).toBe(1);
    expect(repairTicket.downstream_error).toContain("output must be a URL");
  });

  it("does not classify input validation for a result argument as output validation", async () => {
    const schema = {
      type: "object",
      properties: {
        result: { type: "string" },
      },
      required: ["result"],
    };

    const error = await runDownstreamInvalidParams({
      schema,
      args: { result: "draft" },
      message: "Input validation error: result validation failed",
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.attempt).toBe(1);
    expect(repairTicket.downstream_error).toContain("result validation failed");
  });

  it("resets downstream validation attempts after output validation failures", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    };

    const first = await runDownstreamInvalidParams({
      schema,
      args: { query: "events" },
      packageId,
      toolId,
      message: "query must include tenant context",
    });
    expect(expectRepairTicket(first).attempt).toBe(1);

    const outputFailure = await runDownstreamInvalidParams({
      schema,
      args: { query: "events" },
      packageId,
      toolId,
      message: "Structured content does not match the tool's output schema: startDate must be string",
    });
    expect(outputFailure.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);

    const nextInputFailure = await runDownstreamInvalidParams({
      schema,
      args: { query: "events" },
      packageId,
      toolId,
      message: "query must include tenant context",
    });
    expect(expectRepairTicket(nextInputFailure).attempt).toBe(1);
  });

  it("escalates downstream InvalidParams to full schema on attempt 2", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 3 },
        region: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const first = await runDownstreamInvalidParams({
      schema,
      args: { query: "hello" },
      packageId,
      toolId,
      message: "still invalid",
    });
    const firstTicket = expectRepairTicket(first);
    expect(firstTicket.attempt).toBe(1);
    expect(firstTicket.schema_fragments).not.toHaveProperty("__full_schema");

    const second = await runDownstreamInvalidParams({
      schema,
      args: { query: "hello" },
      packageId,
      toolId,
      message: "still invalid",
    });
    const secondTicket = expectRepairTicket(second);
    expect(secondTicket.attempt).toBe(2);
    expect(secondTicket.schema_fragments).toHaveProperty("__full_schema");
  });
});

describe("use_tool schema_hash handshake", () => {
  it("allows calls when schema_hash is absent without warning", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {},
      },
      {
        callTool,
        schemaHash: "sha256:current",
      },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: {},
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      expect(callTool).toHaveBeenCalledOnce();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("allows calls when schema_hash matches without warning", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const schemaHash = "sha256:current";
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {},
      },
      {
        callTool,
        schemaHash,
      },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: {},
          schema_hash: schemaHash,
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      expect(callTool).toHaveBeenCalledOnce();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns on schema_hash mismatch but still proceeds", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const currentSchemaHash = "sha256:current";
    const providedSchemaHash = "sha256:stale";
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {},
      },
      {
        callTool,
        schemaHash: currentSchemaHash,
      },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: toolId,
          args: {},
          schema_hash: providedSchemaHash,
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      expect(callTool).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        "schema_hash mismatch — tool schema may have changed since get_tool_details was called",
        expect.objectContaining({
          tool_id: toolId,
          expected: currentSchemaHash,
          got: providedSchemaHash,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("FOX-2753: enforce additionalProperties", () => {
  it("rejects strip-only unknown args when additionalProperties is false", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: { query: "test", unknown: "value" },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.unknown_fields).toContain("unknown");
    expect(repairTicket.missing_required).toEqual([]);
  });

  it("injects additionalProperties=false when omitted and rejects unknown args", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    };

    const error = await runValidationFailure({
      schema,
      args: { query: "test", unknown: "value" },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.unknown_fields).toContain("unknown");
    expect(repairTicket.missing_required).toEqual([]);
  });

  it("skips injection when top-level schema uses oneOf", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      oneOf: [{ required: ["query"] }],
    };

    const { registry, catalog, validator } = createUseToolDeps(schema);
    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { query: "test", unknown: "value" },
        dry_run: true,
      },
      registry as any,
      catalog as any,
      validator,
    );

    const dryRunPayload = JSON.parse(result.content[0].text);
    expect(dryRunPayload.args_used).toHaveProperty("unknown", "value");
  });

  it("includes valid params in error summary when unknown fields are present", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: { query: "test", qurey: "value" },
    });

    expect(error.message).toContain("Unknown fields:");
    expect(error.message).toContain("Valid arguments: query");
  });

  it("lists valid params even when unknown field has no fuzzy match", async () => {
    const schema = {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    };
    const error = await runValidationFailure({
      schema,
      args: { to: ["a@b.com"], subject: "hi", body: "hello", zzz_totally_fake: true },
    });
    expect(error.message).toContain("Unknown fields: zzz_totally_fake");
    expect(error.message).toContain("Valid arguments: to, subject, body");
    const ticket = error.data.repair_ticket;
    expect(ticket.valid_fields).toEqual(["to", "subject", "body"]);
    expect(ticket.unknown_fields).toEqual(["zzz_totally_fake"]);
    expect(ticket.missing_required).toEqual([]);
  });
});

describe("FOX-2753: ticket scenario verification", () => {
  // S2: send_workspace_email with fabricated priority — schema omits additionalProperties
  it("S2: rejects send_email with hallucinated priority field", async () => {
    const schema = {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        replyTo: { type: "string" },
        inReplyTo: { type: "string" },
      },
      required: ["to", "subject", "body"],
    };
    const error = await runValidationFailure({
      schema,
      args: { to: ["harry@mindstone.com"], subject: "test", body: "test", priority: "high" },
    });
    const ticket = error.data.repair_ticket;
    expect(ticket.unknown_fields).toContain("priority");
    expect(ticket.missing_required).toEqual([]);
    expect(error.message).toContain("priority");
    expect(error.message).toContain("Valid arguments:");
  });

  // S4b: search_workspace_emails with fabricated q param — rejected as unknown
  // Note: "q" is too short/distant from "query" for Levenshtein to suggest it
  it("S4b: rejects search_emails with hallucinated q param", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        labelIds: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    };
    const error = await runValidationFailure({
      schema,
      args: { q: "invoices" },
    });
    const ticket = error.data.repair_ticket;
    expect(ticket.unknown_fields).toContain("q");
    expect(ticket.missing_required).toContain("query");
  });

  // S4c: search_workspace_emails with complete nonsense param
  it("S4c: rejects search_emails with zzz_totally_fake_param", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
    };
    const error = await runValidationFailure({
      schema,
      args: { zzz_totally_fake_param: "invoices" },
    });
    const ticket = error.data.repair_ticket;
    expect(ticket.unknown_fields).toContain("zzz_totally_fake_param");
    expect(ticket.did_you_mean["zzz_totally_fake_param"]).toBeUndefined();
    expect(ticket.missing_required).toContain("query");
  });

  // S5: create_event with reminder instead of reminders — should suggest reminders
  it("S5: rejects create_event with reminder, suggests reminders", async () => {
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        reminders: { type: "array", items: { type: "object" } },
        attendees: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "start", "end"],
    };
    const error = await runValidationFailure({
      schema,
      args: { summary: "Meeting", start: "2026-03-10T10:00:00Z", end: "2026-03-10T11:00:00Z", reminder: 15 },
    });
    const ticket = error.data.repair_ticket;
    expect(ticket.unknown_fields).toContain("reminder");
    expect(ticket.did_you_mean["reminder"]).toBe("reminders");
    expect(ticket.missing_required).toEqual([]);
  });

  // S1: valid tool call should pass — meetingType is a valid field
  it("S1: accepts list_meetings with valid meetingType field", async () => {
    const schema = {
      type: "object",
      properties: {
        meetingType: { type: "string", enum: ["internal", "external"] },
        limit: { type: "number" },
      },
    };
    const { registry, catalog, validator } = createUseToolDeps(schema);
    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { meetingType: "external", limit: 3 },
        dry_run: true,
      },
      registry as any,
      catalog as any,
      validator,
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.args_used).toEqual({ meetingType: "external", limit: 3 });
  });
});

describe("FOX-2865: zero-param tool hallucination guidance", () => {
  it("gives explicit 'takes no arguments' guidance for zero-param tools with unknown args", async () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const error = await runValidationFailure({
      schema,
      args: { email: "user@example.com" },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.unknown_fields).toContain("email");
    expect(repairTicket.valid_fields).toEqual([]);
    expect(error.message).toContain("This tool takes no arguments");
    expect(error.message).toContain("{}");
    expect(error.message).not.toContain("Valid arguments:");
  });

  it("gives explicit guidance even with explicit additionalProperties: false", async () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: { username: "test" },
    });

    expect(error.message).toContain("This tool takes no arguments");
    expect(error.message).toContain("Unknown fields: username");
  });

  it("still shows 'Valid arguments' for tools that have params", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    };

    const error = await runValidationFailure({
      schema,
      args: { query: "test", email: "user@example.com" },
    });

    expect(error.message).toContain("Valid arguments: query");
    expect(error.message).not.toContain("This tool takes no arguments");
  });
});
