import { describe, expect, it, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES, type PackageConfig } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import { Validator, type ValidationResult } from "../src/validator.js";

function makePackageConfig(id: string, name = id): PackageConfig {
  return { id, name, transport: "stdio", visibility: "default" };
}

function createMocks(opts: {
  packages?: PackageConfig[];
  toolMatches?: Array<{ packageId: string; toolId: string }>;
  /** Override the downstream tool's advertised inputSchema (default: additionalProperties: true). */
  schema?: unknown;
  /** Spy on the REAL Validator instead of the always-valid stub (for pre-fix red-run fidelity). */
  realValidator?: boolean;
} = {}) {
  const packages = opts.packages ?? [makePackageConfig("pkg1")];
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn().mockReturnValue([]),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const toolSchema = opts.schema ?? {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
  const getTool = (packageId: string, toolId: string) => {
    const isKnownMatch = (opts.toolMatches ?? []).some(
      (match) => match.packageId === packageId && match.toolId === toolId,
    );
    return packagesById.has(packageId) && (isKnownMatch || toolId === "tool1" || toolId === "tool")
      ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
      : undefined;
  };
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
    findToolByName: vi.fn().mockReturnValue(opts.toolMatches ?? []),
  } as unknown as Catalog;
  const realValidator = new Validator();
  const mockValidator = {
    validate: opts.realValidator
      ? vi.fn((schema: any, data: any, context?: { package_id?: string; tool_id?: string }) =>
          realValidator.validate(schema, data, context),
        )
      : vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

async function expectDispatchArgValidation(promise: Promise<unknown>) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    code: ERROR_CODES.ARG_VALIDATION_FAILED,
    message: expect.stringContaining("search_tools"),
  });
  expect(caught).toMatchObject({
    message: expect.stringContaining("list_tools"),
  });
  expect(caught).toMatchObject({
    message: expect.stringContaining("get_tool_details"),
  });
}

describe("useTool dispatch-level validation", () => {
  it("rejects a non-object use_tool input with coded recovery guidance", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        undefined as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("rejects missing tool_id with coded recovery guidance before package lookup", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        { package_id: "pkg1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("rejects empty tool_id with coded recovery guidance", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    await expectDispatchArgValidation(
      handleUseTool(
        { package_id: "pkg1", tool_id: "  ", args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
  });

  it("rejects non-object non-JSON args at dispatch before package lookup", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({ packages: [] });

    await expectDispatchArgValidation(
      handleUseTool(
        {
          package_id: "missing",
          tool_id: "tool1",
          args: "not-json",
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
  });

  it("accepts namespaced tool_id without package_id", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      packages: [makePackageConfig("pkg1")],
    });

    const response = await handleUseTool(
      { tool_id: "pkg1__tool1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
    expect(mockCatalog.findToolByName).not.toHaveBeenCalled();
  });

  it("accepts a unique bare tool_id without package_id and reaches the resolver", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      packages: [makePackageConfig("pkg1")],
      toolMatches: [{ packageId: "pkg1", toolId: "tool1" }],
    });

    const response = await handleUseTool(
      { tool_id: "tool1", args: {} } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockCatalog.findToolByName).toHaveBeenCalledWith("tool1");
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
  });

  it("coerces omitted and null args to empty objects", async () => {
    for (const input of [
      { package_id: "pkg1", tool_id: "tool1" },
      { package_id: "pkg1", tool_id: "tool1", args: null },
    ]) {
      const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

      const response = await handleUseTool(
        input as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      );

      expect(response.isError).toBe(false);
      expect(mockValidator.validate).toHaveBeenCalledWith(
        expect.anything(),
        {},
        expect.objectContaining({ package_id: "pkg1", tool_id: "tool1" }),
      );
      expect(mockClient.callTool).toHaveBeenCalledWith("tool1", {});
    }
  });

  it("accepts stringified JSON object args and forwards the parsed object", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "tool1",
        args: "{\"query\":\"budget\"}",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      { query: "budget" },
      expect.objectContaining({ package_id: "pkg1", tool_id: "tool1" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", { query: "budget" });
  });

  it("staged calls short-circuit BEFORE dispatch validation even with a malformed args container", async () => {
    // Pin the ordering contract: by the time _rebel_staged reaches us, the host has
    // already created and broadcast the approval entry. A -33003 here would diverge
    // model and user state (duplicate approval prompts); validation belongs to the
    // approval-replay leg. See useTool.ts staged short-circuit comment.
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "pkg1__tool",
        args: 42, // malformed container that WOULD throw -33003 on a normal call
        _rebel_staged: true,
        _rebel_staged_message: "Staged for approval.",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response._meta?.superMcp).toMatchObject({ staged: true });
    expect(response.content[0]).toMatchObject({ type: "text", text: "Staged for approval." });
    expect(mockValidator.validate).not.toHaveBeenCalled();
  });

  it("treats result_id calls as continuation calls and ignores package/tool/args shape", async () => {
    // LOAD-BEARING (REBEL-7JD / arbitrator-recall F1+F2): this is the executable proof
    // that a top-level `result_id` makes the call a continuation and `args` is ignored
    // WHOLESALE — not even the malformed-args dispatch error fires. That is exactly why
    // `result_id` is NOT in USE_TOOL_HARD_REJECT_META_PARAMS: the misplacement guard's
    // "absent at top level" predicate and `isContinuationCall` are exact complements, so
    // the guard is unreachable for it, AND telling the model to hoist `result_id` to the
    // top level would hijack the call into this continuation branch (useTool.ts:969) —
    // a silent failure (plausible cache-miss prose, tool never invoked). Do not delete.
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        result_id: "missing-cache-entry",
        output_offset: 0,
        args: "not-json",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Cached result expired or not found"),
    });
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
    expect(mockValidator.validate).not.toHaveBeenCalled();
  });

  it("preserves the existing missing output_offset continuation response", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        result_id: "missing-cache-entry",
        args: "not-json",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("output_offset is required"),
    });
    expect(mockRegistry.getPackage).not.toHaveBeenCalled();
    expect(mockValidator.validate).not.toHaveBeenCalled();
  });
});

// REBEL-7JD: `use_tool` meta-params (max_output_chars, dry_run, result_id, output_offset,
// schema_hash) are TOP-LEVEL envelope parameters. A model that nested one inside `args`
// used to get "Unknown fields: max_output_chars. This tool takes no arguments" — advice
// that never named the misplacement, so the model re-added the field and looped. The
// envelope-layer guard rejects the hard-reject subset deterministically on attempt 1.
describe("useTool misplaced meta-param rejection", () => {
  const NO_ARG_SCHEMA = {
    type: "object",
    properties: {},
    // Deliberately NO additionalProperties — the incident's own shape
    // (`get_running_cohorts`, schema `"properties": {}`); the validator injects
    // additionalProperties: false for such schemas.
  };

  async function catchError(promise: Promise<unknown>): Promise<any> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to reject, but it resolved");
  }

  it("(i) rejects the incident shape (nested max_output_chars on a no-arg tool) at dispatch", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      schema: NO_ARG_SCHEMA,
      realValidator: true,
    });

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { max_output_chars: 50000 },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    // Classifier-stable prefix (arbitrator-recall F3): usePendingApprovals
    // `isArgValidationFailure` and Toast `argValidationToastFingerprint` both
    // substring-match this clause. Without it, staged replay regresses to a raw red
    // jargon toast and the FOX-3519 Sentry collapse re-fragments.
    expect(error.message).toContain("Argument validation failed for tool");
    expect(error.message).toContain("top-level");
    expect(error.message).toContain("use_tool");
    expect(error.message).toContain("max_output_chars");
    expect(error.data).toMatchObject({
      validation_stage: "dispatch",
      field: "args.max_output_chars",
      misplaced_param: "max_output_chars",
    });
    // Rejected at the envelope layer: neither the validator nor the downstream tool runs.
    expect(mockValidator.validate).not.toHaveBeenCalled();
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("(ii-a) rejects nested output_offset with no top-level twin at dispatch", async () => {
    // output_offset is consumed in the continuation preamble BEFORE the schema fetch —
    // the validation layer can never see it, so the envelope seam is the only cover.
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      schema: NO_ARG_SCHEMA,
      realValidator: true,
    });

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { output_offset: 100 },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    expect(error.message).toContain("Argument validation failed for tool");
    expect(error.message).toContain("output_offset");
    expect(error.data).toMatchObject({
      validation_stage: "dispatch",
      misplaced_param: "output_offset",
    });
    expect(mockValidator.validate).not.toHaveBeenCalled();
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("(ii-b) does NOT reject nested result_id at dispatch — it reaches the validator", async () => {
    // Pins the result_id exclusion (arbitrator-recall F1). Hard-rejecting it would be
    // unreachable on continuation calls and would teach the model into the hijack trap;
    // the Stage-2 schema-aware repair ticket teaches it one layer later instead.
    const { mockRegistry, mockCatalog, mockValidator } = createMocks({
      schema: NO_ARG_SCHEMA,
      realValidator: true,
    });

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { result_id: "abc" },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(mockValidator.validate).toHaveBeenCalled();
    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    expect(error.data?.validation_stage).toBeUndefined();
    expect(error.data?.repair_ticket).toBeDefined();
  });

  it("(iii) proceeds when the tool legitimately declares dry_run as a property", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      schema: {
        type: "object",
        properties: { dry_run: { type: "boolean" } },
        additionalProperties: false,
      },
      realValidator: true,
    });

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "tool1",
        args: { dry_run: true },
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", { dry_run: true });
  });

  it("(iv) rejects nested max_output_chars even on an additionalProperties:true schema", async () => {
    // Schema-independent: the guard runs at the envelope layer, so a permissive downstream
    // schema (createMocks default) does not smuggle the meta-param through.
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { max_output_chars: 1000 },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    expect(error.message).toContain("Argument validation failed for tool");
    expect(error.data).toMatchObject({ validation_stage: "dispatch", misplaced_param: "max_output_chars" });
    expect(mockValidator.validate).not.toHaveBeenCalled();
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("(iv-b) rejects nested schema_hash at dispatch", async () => {
    // schema_hash is the third hard-rejected param and had no direct case before
    // (reviewer-opus F1); the drift-guard test pins the set, this pins the behaviour.
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks({
      schema: NO_ARG_SCHEMA,
      realValidator: true,
    });

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { schema_hash: "abc123" },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    expect(error.message).toContain("Argument validation failed for tool");
    expect(error.message).toContain("schema_hash");
    expect(error.data).toMatchObject({
      validation_stage: "dispatch",
      field: "args.schema_hash",
      misplaced_param: "schema_hash",
    });
    expect(mockValidator.validate).not.toHaveBeenCalled();
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("(vii) never emits a placeholder package_id in the retry template for a namespaced call", async () => {
    // reviewer-kimi F2: `{tool_id: "pkg1__tool1"}` with no package_id is a supported
    // shape, so a retry template containing `package_id: "<unknown>"` would teach a
    // call that itself fails package lookup — the same "error message teaches a
    // broken shape" failure class this guard exists to end.
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const error = await catchError(
      handleUseTool(
        {
          tool_id: "pkg1__tool1",
          args: { max_output_chars: 5 },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error).toMatchObject({ code: ERROR_CODES.ARG_VALIDATION_FAILED });
    expect(error.message).toContain("Argument validation failed for tool");
    expect(error.message).not.toContain("<unknown>");
    // The namespaced tool_id alone is a resolvable retry shape.
    expect(error.message).toContain('use_tool({ tool_id: "pkg1__tool1"');
    // (RECOVERY_GUIDANCE legitimately mentions package_id in its list_tools example,
    // so assert on the retry template itself rather than the whole message.)
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("(viii) caps the echoed nested value so it cannot crowd out the leading clause", async () => {
    // reviewer-kimi F4: the composed message competes for the host's 2000-char
    // error-data budget, which truncates tail-first.
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const error = await catchError(
      handleUseTool(
        {
          package_id: "pkg1",
          tool_id: "tool1",
          args: { max_output_chars: "x".repeat(50_000) },
        } as unknown as Parameters<typeof handleUseTool>[0],
        mockRegistry,
        mockCatalog,
        mockValidator,
      ),
    );

    expect(error.message).toContain("(truncated)");
    expect(error.message.length).toBeLessThan(1200);
    expect(error.message.startsWith("Argument validation failed for tool")).toBe(true);
  });

  it("(v) does NOT reject when the meta-param is ALSO present top-level (escape hatch)", async () => {
    // The escape hatch that keeps a tool legitimately declaring one of the hard-rejected
    // params callable: pass it top-level too. Verified genuine for all three
    // (max_output_chars/output_offset/schema_hash reach callTool).
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "tool1",
        max_output_chars: 2000,
        args: { max_output_chars: 2000 },
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalled();
    expect(mockClient.callTool).toHaveBeenCalledWith("tool1", { max_output_chars: 2000 });
  });

  it("(vi) staged short-circuit still wins over the misplacement guard", async () => {
    // Placement contract: the _rebel_staged short-circuit precedes parseUseToolInput, so
    // the host's already-broadcast approval entry is never contradicted by a -33003 here.
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "pkg1",
        tool_id: "tool1",
        args: { max_output_chars: 1 },
        _rebel_staged: true,
        _rebel_staged_message: "Staged for approval.",
      } as unknown as Parameters<typeof handleUseTool>[0],
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response._meta?.superMcp).toMatchObject({ staged: true });
    expect(mockValidator.validate).not.toHaveBeenCalled();
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });
});
