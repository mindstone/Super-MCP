import { describe, it, expect, vi } from "vitest";
import { Validator, ValidationError } from "../src/validator.js";
import {
  handleUseTool,
  STOP_RETRYING_THRESHOLD,
} from "../src/handlers/useTool.js";
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
    // Stage 6: useTool dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same closure so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, args: any) => callTool(toolId, args),
    notifyActivity: () => {},
  };

  const getTool = (packageId: string, toolId: string) => ({
    packageId,
    tool: {
      name: toolId,
      inputSchema: schema,
    },
    schemaHash,
  });
  const catalog = {
    ensurePackageLoaded: async () => {},
    getPackageStatus: () => "ready",
    getRefreshInFlight: () => false,
    getPackageError: () => undefined,
    getRetryHint: () => ({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool,
    getToolSchema: (packageId: string, toolId: string) =>
      getTool(packageId, toolId).tool.inputSchema,
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
  /**
   * Extra TOP-LEVEL use_tool params merged into the envelope. Needed by the
   * misplaced-meta-param ticket tests to exercise the "already present at top
   * level" branch (and to override the default `dry_run: true`).
   */
  extraInput?: Record<string, unknown>;
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
        ...(options.extraInput ?? {}),
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
    // REBEL-7JD: the shared STOP_RETRYING_MESSAGE no longer tells the model to
    // "ask the user for specifics" — that misroutes a self-fixable call-shape
    // mistake to a non-technical user. A live superproject classifier
    // (src/renderer/features/inbox/hooks/usePendingApprovals.ts
    // isArgValidationExhausted) substring-matches this text to route the
    // terminal inbox affordance, so the two repos move together.
    expect(third.message).toContain("These arguments have failed validation several times");
    expect(third.message).toContain("Stop re-sending the same call shape");
    expect(third.message).not.toContain("ask the user for specifics");
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

describe("REBEL-7JD: misplaced use_tool meta-params in the repair ticket", () => {
  // Vacuous-green guard: the three HARD-reject meta-params (max_output_chars,
  // output_offset, schema_hash) can no longer reach the validator — the Stage-1
  // envelope guard (handlers/useToolInput.ts rejectMisplacedMetaParams) throws
  // first. So these tests drive the ticket path with the two SOFT meta-params
  // (`dry_run`, `result_id`), which are deliberately excluded from the guard and
  // are therefore the only params that can arrive here nested inside `args`.
  // See types.ts USE_TOOL_SOFT_META_PARAMS for why each is excluded.

  it("names a nested dry_run as a misplaced top-level use_tool parameter (no-arg tool)", async () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const error = await runValidationFailure({
      schema,
      // `dry_run` nested inside args, with NO top-level twin — the guard stands
      // down (soft param) and the validator strips it as an unknown field.
      args: { dry_run: true },
      extraInput: { dry_run: undefined },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.misplaced_params).toEqual(["dry_run"]);
    expect(error.message).toContain("Misplaced use_tool parameters: dry_run.");
    expect(error.message).toContain("These are top-level use_tool parameters, not tool arguments");
    expect(error.message).toContain('move it outside "args"');

    // No contradictory double-report: the param must NOT also be listed as an
    // unknown field (which would tell the model to just drop it), and the
    // no-arg guidance must not fire on a call whose only "argument" was the
    // misplaced meta-param.
    expect(repairTicket.unknown_fields).not.toContain("dry_run");
    expect(repairTicket.unknown_fields).toEqual([]);
    expect(error.message).not.toContain("Unknown fields");
    expect(error.message).not.toContain("This tool takes no arguments");
  });

  it("leads with the misplacement section, before Unknown fields", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    };

    const error = await runValidationFailure({
      schema,
      args: { query: "hello", dry_run: true, emial: "user@example.com" },
      extraInput: { dry_run: undefined },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.misplaced_params).toEqual(["dry_run"]);
    expect(repairTicket.unknown_fields).toEqual(["emial"]);

    const misplacedIndex = error.message.indexOf("Misplaced use_tool parameters:");
    const unknownIndex = error.message.indexOf("Unknown fields:");
    expect(misplacedIndex).toBeGreaterThan(-1);
    expect(unknownIndex).toBeGreaterThan(-1);
    expect(misplacedIndex).toBeLessThan(unknownIndex);
  });

  it("tells the model to REMOVE (not move) a param that is already present top-level", async () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const error = await runValidationFailure({
      schema,
      args: { dry_run: true },
      // Top-level twin present: the top-level value is the one honoured, so
      // "move it outside args" would be wrong advice (reviewer-kimi F4).
      extraInput: { dry_run: true },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.misplaced_params).toEqual(["dry_run"]);
    expect(error.message).toContain("remove it from \"args\"");
    expect(error.message).toContain("the top-level value is the one used");
    expect(error.message).not.toContain('move it outside "args"');
  });

  it("treats an explicitly falsy top-level twin as PRESENT (remove, not move)", async () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const error = await runValidationFailure({
      schema,
      args: { dry_run: true },
      // `dry_run: false` is explicitly supplied at the top level. Presence is
      // pinned to `!== undefined` (getTopLevelMetaParamPresence), matching the
      // envelope guard — so this is the "remove" case even though the value is
      // falsy. A truthiness test here would wrongly emit "move it outside args"
      // and lose the user's explicit `false` (Stage 2 review F4).
      extraInput: { dry_run: false },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.misplaced_params).toEqual(["dry_run"]);
    expect(error.message).toContain("remove it from \"args\"");
    expect(error.message).toContain("the top-level value is the one used");
    expect(error.message).not.toContain('move it outside "args"');
  });

  it("warns that a nested result_id turns the retry into a continuation call", async () => {
    const schema = {
      type: "object",
      properties: {},
    };

    const error = await runValidationFailure({
      schema,
      // No top-level result_id: this is a NORMAL call, so it reaches the
      // validator rather than the continuation branch (arbitrator-recall F1).
      args: { result_id: "abc123" },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.misplaced_params).toEqual(["result_id"]);
    expect(error.message).toContain("Misplaced use_tool parameters: result_id.");
    expect(error.message).toContain(
      "passing result_id at the top level makes this a continuation call — the tool will not run",
    );
  });

  it("emits misplacement-specific terminal guidance instead of the shared stop message", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {},
    };

    let error: any;
    for (let attempt = 0; attempt < STOP_RETRYING_THRESHOLD; attempt += 1) {
      error = await runValidationFailure({
        schema,
        args: { dry_run: true },
        packageId,
        toolId,
        extraInput: { dry_run: undefined },
      });
    }

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.attempt).toBe(STOP_RETRYING_THRESHOLD);
    expect(error.message).toContain("Stop re-sending this call shape");
    expect(error.message).toContain("belongs at the top level of use_tool");
    // Never routes a self-fixable misplacement to the user.
    expect(error.message).not.toContain("ask the user");
    expect(error.message).not.toContain("These arguments have failed validation several times");
  });

  it("keeps the shared stop message for non-misplacement validation failures", async () => {
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

    let error: any;
    for (let attempt = 0; attempt < STOP_RETRYING_THRESHOLD; attempt += 1) {
      error = await runValidationFailure({ schema, args: {}, packageId, toolId });
    }

    expect(error.message).toContain("These arguments have failed validation several times");
    expect(error.message).not.toContain("stop re-sending this call shape");
  });
});

describe("REBEL-7JD: meta-param observability warns at the validation seam", () => {
  function findWarn(warnSpy: any, message: string) {
    return warnSpy.mock.calls.find((call: unknown[]) => call[0] === message);
  }

  it("warns when a meta-param name collides with a legitimate schema property", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const packageId = nextId("pkg");
    // The tool legitimately declares `dry_run` as one of its own arguments.
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {
          dry_run: { type: "boolean" },
        },
      },
      { callTool },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: packageId,
          tool_id: toolId,
          args: { dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      const warn = findWarn(
        warnSpy,
        "use_tool meta-param name collides with legitimate schema property",
      );
      expect(warn).toBeDefined();
      expect(warn?.[1]).toMatchObject({ package_id: packageId, tool_id: toolId, param: "dry_run" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns ONCE per tool+param across repeated calls (R8 once-set)", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const packageId = nextId("pkg");
    // The tool legitimately declares `dry_run`, so every call takes the collision
    // (i) branch. The warn is a wake-up signal, not a per-call metric — it must
    // fire once per tool+param, not once per call (R8).
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {
          dry_run: { type: "boolean" },
        },
      },
      { callTool },
    );

    try {
      for (let call = 0; call < 3; call += 1) {
        const result = await handleUseTool(
          {
            package_id: packageId,
            tool_id: toolId,
            args: { dry_run: true },
          },
          registry as any,
          catalog as any,
          validator,
        );
        expect(result.isError).toBe(false);
      }

      const collisionWarns = warnSpy.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "use_tool meta-param name collides with legitimate schema property" &&
          (call[1] as { tool_id?: string } | undefined)?.tool_id === toolId,
      );
      expect(collisionWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns with the canonical-twin variant when only the TWIN is declared (F4)", async () => {
    // The tool declares `dryRun`; the call nests `dry_run`. That is not a literal
    // collision, but it IS the twin path (now renamed before dispatch), so it must
    // be observable — and distinguishable from the literal case in the message.
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const packageId = nextId("pkg");
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: packageId,
          tool_id: toolId,
          args: { dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      const twinWarn = findWarn(
        warnSpy,
        "use_tool meta-param collides with a CANONICAL TWIN of a schema property",
      );
      expect(twinWarn).toBeDefined();
      expect(twinWarn?.[1]).toMatchObject({
        package_id: packageId,
        tool_id: toolId,
        param: "dry_run",
        declared_property: "dryRun",
      });
      // The literal-collision message must NOT be used for the twin case.
      expect(
        findWarn(warnSpy, "use_tool meta-param name collides with legitimate schema property"),
      ).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns ONCE per tool+param for the canonical-twin arm too (shared once-set)", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const packageId = nextId("pkg");
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    try {
      for (let call = 0; call < 3; call += 1) {
        const result = await handleUseTool(
          {
            package_id: packageId,
            tool_id: toolId,
            args: { dry_run: true },
          },
          registry as any,
          catalog as any,
          validator,
        );
        expect(result.isError).toBe(false);
      }

      const twinWarns = warnSpy.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "use_tool meta-param collides with a CANONICAL TWIN of a schema property" &&
          (call[1] as { tool_id?: string } | undefined)?.tool_id === toolId,
      );
      expect(twinWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns with the canonical-twin variant for a HARD param, which is still dispatched VERBATIM (R11)", async () => {
    // R11: pins the widened warn scope (the collision loop runs over the FULL
    // USE_TOOL_META_PARAMS set, not just the soft pair) AND the hard/soft asymmetry:
    // the soft pair gets renamed into its declared twin, the hard three never do —
    // their escape hatch is the top-level twin, so the nested copy is forwarded to the
    // tool untouched. A future scoping tidy-up must not silently narrow either half
    // away: the deferred residue items (R12/R15) are conditioned on this signal.
    //
    // The top-level `max_output_chars` is REQUIRED here: without it
    // rejectMisplacedMetaParams (useToolInput.ts) throws at the envelope layer before
    // the validation seam ever runs. Unique package/tool ids because the warn is
    // once-per-tool+param via a module-level Set.
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const toolId = nextId("tool");
    const packageId = nextId("pkg");
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { maxOutputChars: { type: "number" } },
        additionalProperties: true,
      },
      { callTool },
    );

    try {
      const result = await handleUseTool(
        {
          package_id: packageId,
          tool_id: toolId,
          max_output_chars: 2000,
          args: { max_output_chars: 2000 },
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(result.isError).toBe(false);
      const twinWarn = warnSpy.mock.calls.find(
        (call: unknown[]) =>
          call[0] === "use_tool meta-param collides with a CANONICAL TWIN of a schema property" &&
          (call[1] as { param?: string } | undefined)?.param === "max_output_chars",
      );
      expect(twinWarn).toBeDefined();
      expect(twinWarn?.[1]).toMatchObject({
        package_id: packageId,
        tool_id: toolId,
        param: "max_output_chars",
        declared_property: "maxOutputChars",
      });
      // Hard params are never renamed: the nested key reaches the tool verbatim.
      expect(callTool).toHaveBeenCalledTimes(1);
      expect((callTool.mock.calls[0] as any[])[1]).toEqual({ max_output_chars: 2000 });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when args carry no meta-param names", async () => {
    const warnSpy = vi.spyOn(getLogger(), "warn");
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        additionalProperties: true,
      },
      { callTool },
    );

    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { query: "hello" },
        },
        registry as any,
        catalog as any,
        validator,
      );

      expect(
        findWarn(warnSpy, "use_tool meta-param name collides with legitimate schema property"),
      ).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * REBEL-7JD (residue R1): the DECLARED-PROPERTY misplacement gate.
 *
 * The prior gate asked "will the validator strip this unknown arg?". On a
 * permissive schema (`additionalProperties: true`, or no `properties` at all)
 * the answer is no, so a nested `dry_run` validated clean and was DISPATCHED —
 * a real mutation running when the model asked for a dry run.
 *
 * The gate now asks the right question: "does this tool DECLARE this parameter?"
 * Scoped to the SOFT pair (`dry_run`, `result_id`) only — the hard three are
 * handled at the envelope layer (useToolInput.ts) and their top-level-twin escape
 * hatch must stay intact (test/useTool-dispatch-validation.test.ts case (v)).
 */
describe("REBEL-7JD: declared-property misplacement gate", () => {
  it("(i) throws a -33003 misplacement ticket for a nested dry_run on a NON-STRIPPING schema", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    // additionalProperties: true and `dry_run` NOT declared → the validator
    // neither strips nor rejects, so before the gate this silently dispatched.
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: packageId,
          tool_id: toolId,
          args: { query: "hello", dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    // Classifier-stable prefix (kimi F5): the host substring-matches this clause.
    expect(error.message.startsWith("Argument validation failed for tool")).toBe(true);
    expect(error.message).toContain(`Argument validation failed for tool '${toolId}' in package '${packageId}'.`);
    expect(error.message).toContain("Misplaced use_tool parameters: dry_run.");
    expect(error.message).toContain('move it outside "args"');
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    // The whole point: the downstream tool must NOT run.
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(ii) dispatches when the schema DECLARES dry_run (legitimate tool argument)", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dry_run: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { dry_run: true },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("(ii-b) RENAMES the canonical twin before dispatch when the schema declares dryRun", async () => {
    // DA F1: the gate subtracts canonical twins, but on a NON-STRIPPING schema the
    // auto-repair seam never runs (validation passes clean), so the literal
    // `dry_run` key used to be dispatched VERBATIM — the tool ignores the unknown
    // key, keeps its declared `dryRun` default (false) and MUTATES FOR REAL. The
    // gate seam must normalise the key itself: `dry_run` → declared `dryRun`.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { dry_run: true },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
    // The load-bearing assertion (DA F3): WHICH args reached the tool. Asserting
    // only the call count pinned the silent-mutation hole green.
    const dispatchedArgs = (callTool.mock.calls[0] as any[])[1] as Record<string, unknown>;
    expect(dispatchedArgs).toEqual({ dryRun: true });
    expect("dry_run" in dispatchedArgs).toBe(false);
  });

  it("(ii-c) never dispatches the literal dry_run key on a permissive twin schema (DA F1 trace)", async () => {
    // The exact trace the Devil's Advocate walked: schema declares `dryRun`,
    // additionalProperties: true, args nest `dry_run: true`. Validation passes
    // clean, so pre-fix the tool received `{dry_run: true}`, ignored it, and
    // executed a real mutation for a model that asked for a dry run.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { target: { type: "string" }, dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { target: "prod", dry_run: true },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    const dispatchedArgs = (callTool.mock.calls[0] as any[])[1] as Record<string, unknown>;
    expect(dispatchedArgs.dryRun).toBe(true);
    expect("dry_run" in dispatchedArgs).toBe(false);
    expect(dispatchedArgs).toEqual({ target: "prod", dryRun: true });
  });

  it("(ii-d) renames a canonical-twin result_id (declared resultId) before dispatch", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { resultId: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { result_id: "abc123" },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect((callTool.mock.calls[0] as any[])[1]).toEqual({ resultId: "abc123" });
  });

  it("(ii-e) leaves a LITERALLY declared dry_run untouched (no rename)", async () => {
    // A literal declaration is a legitimate tool argument — the rename must not fire.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dry_run: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { dry_run: true },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect((callTool.mock.calls[0] as any[])[1]).toEqual({ dry_run: true });
  });

  it("(ii-f) throws the misplacement ticket when the canonical twin is AMBIGUOUS", async () => {
    // Two declared properties share the canonical form `dryrun`, so which one the
    // model meant is undecidable. Fail visible rather than guess or pass through.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" }, "dry-run": { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(ii-g) does not clobber an existing value at the canonical-twin target", async () => {
    // Both declared `dryRun` and nested `dry_run` present: renaming would overwrite
    // an explicit value. Undecidable → misplacement ticket, never a silent overwrite.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { dryRun: false, dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(ii-h) TEACHES a canonical twin whose value the declared property rejects (R10)", async () => {
    // R10: the rename fixes the SPELLING; it cannot prove the VALUE. The tool
    // declares `resultId: {type: 'string'}`; the call nests `result_id: 42`. On this
    // permissive schema the pre-rename validation passes clean (unknown key allowed),
    // so pre-fix the gate renamed and DISPATCHED `{resultId: 42}` — type-invalid, and
    // failing differently (and unhelpfully) downstream. The rename is now re-validated
    // and, on failure, the param is taught instead.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { resultId: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { result_id: 42 },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.message.startsWith("Argument validation failed for tool")).toBe(true);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["result_id"]);
    // The load-bearing R10 assertion (opus F4): the ticket must carry the
    // re-validation's errors so it names the DECLARED property and its expected type —
    // the exact corrected shape for the "I meant the tool's own resultId" reading. An
    // empty-errors ticket would teach only 'move it outside "args"', which is the
    // wrong correction for a type mismatch.
    expect(error.data?.errors?.length).toBeGreaterThan(0);
    expect(error.data?.repair_ticket?.type_errors).toEqual([
      { field: "resultId", expected: "string", got: "number", value: 42 },
    ]);
    expect(error.message).toContain("Type errors: resultId (expected string, got number)");
    expect(Object.keys(error.data?.repair_ticket?.schema_fragments ?? {})).toContain("resultId");
    // Never dispatched, and the args the ticket echoes are the ones the model sent.
    expect(callTool).not.toHaveBeenCalled();
    expect(error.data?.provided_args).toEqual(["result_id"]);
    // ONE counter bump for the whole call (no second increment from the re-validation).
    expect(error.data?.repair_ticket?.attempt).toBe(1);
  });

  it("(ii-i) rolls back ALL renames atomically when one of them fails re-validation", async () => {
    // kimi F2: renames are applied to a single clone and committed together. A
    // per-rename commit would leave `args` partially renamed, so the ticket's
    // `provided_args` would list keys the model never sent (`dryRun`) — teaching the
    // model about a call shape it did not make.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" }, resultId: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          // `dry_run` would rename cleanly; `result_id` would not (declared string).
          args: { dry_run: true, result_id: 42 },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run", "result_id"]);
    expect(error.data?.provided_args).toEqual(["dry_run", "result_id"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(ii-j) dispatches a well-typed twin on a COMPOSED (oneOf) schema", async () => {
    // Failure Mode Matrix over-fire mitigation (Stage-2 review R1). A composed schema
    // skips the validator's `additionalProperties: false` injection (validator.ts), so
    // the nested `dry_run` is neither stripped nor rejected and the gate is the only
    // thing standing between the call and dispatch. The rename must survive BOTH the
    // injection skip and oneOf branch selection: a working call must stay a working
    // call, not become a -33003.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" }, query: { type: "string" } },
        oneOf: [{ required: ["query"] }],
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { query: "x", dry_run: true },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
    const dispatchedArgs = (callTool.mock.calls[0] as any[])[1] as Record<string, unknown>;
    expect(dispatchedArgs).toEqual({ query: "x", dryRun: true });
    expect("dry_run" in dispatchedArgs).toBe(false);
  });

  it("(ii-k) TEACHES a composed-schema twin whose rename flips oneOf branch membership", async () => {
    // The negative sibling of (ii-j), and the DESIGNED loud failure: this schema means
    // "exactly one of query or dryRun". Pre-rename `{query, dry_run}` satisfies branch
    // one (dryRun absent); the renamed `{query, dryRun}` satisfies NEITHER branch. R10
    // re-validation therefore rejects the rename, and the call fails VISIBLY with the
    // teaching ticket rather than dispatching a shape the tool would reject anyway.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" }, query: { type: "string" } },
        oneOf: [
          { required: ["query"], not: { required: ["dryRun"] } },
          { required: ["dryRun"], not: { required: ["query"] } },
        ],
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { query: "x", dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.message.startsWith("Argument validation failed for tool")).toBe(true);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    // Fail-visible, not fail-silent: the rename is rolled back, the ticket carries the
    // re-validation's composition errors, and the model sees back exactly what it sent.
    expect(error.data?.errors?.length).toBeGreaterThan(0);
    expect(error.data?.provided_args).toEqual(["query", "dry_run"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(ii-l) does NOT commit the rename when an independent misplacement is about to throw", async () => {
    // Stage-2 review R2 / opus F4. Mixed case: `dry_run` is a decidable twin of the
    // declared `dryRun`, but `result_id` is a genuine misplacement, so this call throws
    // no matter what. Committing the rename anyway would rebind `args` and make the
    // ticket's `provided_args` echo `dryRun` — a key the model never sent — and log a
    // rename for a call that never dispatched. The ticket must mirror the model's own
    // call shape (same accuracy invariant as the atomic rollback in (ii-i)).
    const infoSpy = vi.spyOn(getLogger(), "info");
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { dry_run: true, result_id: "x" },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    try {
      expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
      // The load-bearing assertion: the model-sent keys, verbatim.
      expect(error.data?.provided_args).toEqual(["dry_run", "result_id"]);
      // Only the genuine misplacement is taught; the decidable twin is not (the retry
      // that moves result_id top-level will rename and dispatch as before).
      expect(error.data?.repair_ticket?.misplaced_params).toEqual(["result_id"]);
      // No rename breadcrumb/log for a call that never dispatched.
      const renameLogs = infoSpy.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "Renamed nested soft meta-param to its declared canonical twin",
      );
      expect(renameLogs).toHaveLength(0);
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("(iii) says REMOVE (not move) when a top-level twin is already present", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          // Top-level twin present, so "move it" would be wrong advice. NOTE the
          // top-level `dry_run: true` also means the call would short-circuit into
          // the dry-run branch — the gate must fire BEFORE that.
          dry_run: true,
          args: { query: "hello", dry_run: true },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    expect(error.message).toContain('remove it from "args"');
    expect(error.message).toContain("the top-level value is the one used");
    expect(error.message).not.toContain('move it outside "args"');
    expect(callTool).not.toHaveBeenCalled();
  });

  it("(iv) throws a misplacement ticket on a schema-less tool (no properties)", async () => {
    // Accepted behaviour change #1: previously this dispatched silently.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      { type: "object" },
      { callTool },
    );

    let error: any;
    try {
      await handleUseTool(
        {
          package_id: nextId("pkg"),
          tool_id: nextId("tool"),
          args: { result_id: "abc123" },
        },
        registry as any,
        catalog as any,
        validator,
      );
      throw new Error("Expected the misplacement gate to reject the call");
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
    expect(error.message.startsWith("Argument validation failed for tool")).toBe(true);
    expect(error.data?.repair_ticket?.misplaced_params).toEqual(["result_id"]);
    expect(error.message).toContain(
      "passing result_id at the top level makes this a continuation call — the tool will not run",
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("increments the shared validation attempt counter and reaches the misplacement terminal line", async () => {
    // Invariant (6): gate-injected failures use the SAME counter, so the existing
    // threshold/terminal behaviour applies unchanged.
    const callTool = vi.fn(async () => ({ ok: true }));
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    let error: any;
    for (let attempt = 0; attempt < STOP_RETRYING_THRESHOLD; attempt += 1) {
      try {
        await handleUseTool(
          {
            package_id: packageId,
            tool_id: toolId,
            args: { query: "hello", dry_run: true },
          },
          registry as any,
          catalog as any,
          validator,
        );
        throw new Error("Expected the misplacement gate to reject the call");
      } catch (caught) {
        error = caught;
      }
    }

    expect(error.data?.repair_ticket?.attempt).toBe(STOP_RETRYING_THRESHOLD);
    // Byte-identical terminal line (invariant 3) — deliberately NOT the shared
    // STOP_RETRYING_MESSAGE, and deliberately NOT matching isArgValidationExhausted.
    expect(error.message).toContain("Stop re-sending this call shape");
    expect(error.message).not.toContain("These arguments have failed validation several times");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not fire for a nested key that is neither a soft meta-param nor declared", async () => {
    // Scope discipline: the gate only knows about {dry_run, result_id}. An ordinary
    // unknown key on a permissive schema still passes through as before.
    const callTool = vi.fn(async () => ({ ok: true }));
    const { registry, catalog, validator } = createUseToolDeps(
      {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: true,
      },
      { callTool },
    );

    const result = await handleUseTool(
      {
        package_id: nextId("pkg"),
        tool_id: nextId("tool"),
        args: { query: "hello", surprise_field: 1 },
      },
      registry as any,
      catalog as any,
      validator,
    );

    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
