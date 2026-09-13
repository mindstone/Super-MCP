// Caller-scoped retry state is process-global, with separate validation/downstream
// phases and an exact 500-entry LRU. Unattributable calls still count and receive
// schema help, but cannot generate either terminal instruction.
// Exercise the real handler/parser/validator; only downstream transport is mocked.

import { describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import { Validator } from "../src/validator.js";

// Literal contract values: importing production thresholds/copy would let both
// implementation and expectation drift together. The host classifies this wording.
const ORDINARY_TERMINAL =
  "These arguments have failed validation several times. Stop re-sending the same call shape — change the call or report what failed.";
const MISPLACED_TERMINAL =
  "Stop re-sending this call shape; dry_run belongs at the top level of use_tool, outside `args` — re-issue once with it moved, or drop it and proceed.";
const INPUT_SCHEMA = {
  type: "object",
  properties: { email: { type: "string" } },
  required: ["email"],
  additionalProperties: false,
};

type Branch = "ordinary" | "stripping" | "permissive" | "downstream";
const BRANCHES: Branch[] = ["ordinary", "stripping", "permissive", "downstream"];
const LOCAL_BRANCHES: Branch[] = ["ordinary", "stripping", "permissive"];

let id = 0;
function createMocks(branch: Branch = "ordinary") {
  const packageId = `attempt-pkg-${++id}`;
  const toolId = "tool";
  const schema = { ...INPUT_SCHEMA, additionalProperties: branch === "permissive" };
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn((packageId: string) => ({ id: packageId, name: packageId, transport: "stdio" })),
    getClient: vi.fn().mockResolvedValue(mockClient),
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const getTool = (packageId: string, toolId: string) => ({
    packageId, tool: { name: toolId, inputSchema: schema }, schemaHash: "",
  });
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockReturnValue(schema),
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
  return { packageId, toolId, schema, branch, mockClient, mockRegistry, mockCatalog, validator: new Validator() };
}
type Mocks = ReturnType<typeof createMocks>;

function call(mocks: Mocks, scope: unknown, args: unknown, extraInput: Record<string, unknown> = {}, useToolImpl = handleUseTool) {
  // Invalid scope values deliberately enter the real runtime boundary: the parser
  // accepts them, and the handler must normalize them without stringifying them.
  const input = {
    package_id: mocks.packageId,
    tool_id: mocks.toolId,
    args,
    ...(scope === undefined ? {} : { _rebel_attempt_scope: scope }),
    ...extraInput,
  } as Parameters<typeof handleUseTool>[0];
  return useToolImpl(input, mocks.mockRegistry, mocks.mockCatalog, mocks.validator);
}

async function captureFailure(operation: Promise<unknown>) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: -33003, message: expect.any(String) });
  return caught as {
    code: number;
    message: string;
    data: {
      validation_stage?: string;
      mcp_error_code?: number;
      repair_ticket?: {
        attempt: number;
        schema_fragments: Record<string, unknown>;
        misplaced_params?: string[];
      };
    };
  };
}

async function failingCall(mocks: Mocks, scope: unknown, useToolImpl = handleUseTool) {
  const before = mocks.mockClient.callTool.mock.calls.length;
  let args: Record<string, unknown> = {};
  if (mocks.branch === "downstream") {
    args = { email: "valid@example.test" };
    mocks.mockClient.callTool.mockRejectedValueOnce(new McpError(SdkErrorCode.InvalidParams, "email lacks tenant context"));
  } else if (mocks.branch !== "ordinary") {
    args = { email: "valid@example.test", dry_run: true };
  }
  // No outer dry_run: a no-dispatch assertion must prove rejection, not dry-run.
  const error = await captureFailure(call(mocks, scope, args, {}, useToolImpl));
  expect(error.data.repair_ticket).toBeDefined();
  expect(mocks.mockClient.callTool).toHaveBeenCalledTimes(before + (mocks.branch === "downstream" ? 1 : 0));
  if (mocks.branch === "downstream") {
    expect(mocks.mockClient.callTool).toHaveBeenNthCalledWith(
      before + 1,
      mocks.toolId,
      { email: "valid@example.test" },
    );
    expect(error.data.mcp_error_code).toBe(-32602);
    expect(error.message).toContain("email lacks tenant context");
  } else if (mocks.branch !== "ordinary") {
    expect(error.data.repair_ticket?.misplaced_params).toEqual(["dry_run"]);
    expect(error.message).toContain('dry_run: move it outside "args".');
  }
  return error;
}
type Failure = Awaited<ReturnType<typeof failingCall>>;

function expectAttempt(error: Failure, attempt: number, mocks: Mocks, attributable = true) {
  expect(error.data.repair_ticket?.attempt).toBe(attempt);
  const fragments = error.data.repair_ticket?.schema_fragments;
  if (attempt === 1) {
    expect(fragments).not.toHaveProperty("__full_schema");
  } else {
    expect(fragments).toHaveProperty("__full_schema", mocks.schema);
  }
  const misplaced = mocks.branch === "stripping" || mocks.branch === "permissive";
  const terminal = misplaced ? MISPLACED_TERMINAL : ORDINARY_TERMINAL;
  if (attributable && attempt >= 3) {
    expect(error.message.endsWith(terminal)).toBe(true);
  } else {
    expect(error.message).not.toContain(terminal);
  }
  expect(error.message.toLowerCase()).not.toContain(
    misplaced ? "stop re-sending the same call shape" : "stop re-sending this call shape",
  );
}

describe("useTool validationAttemptMap — thresholds and attribution", () => {
  it.each(BRANCHES)("%s: literal attempts 1–4 pin schema and terminal wording", async (branch) => {
    const mocks = createMocks(branch);
    for (const attempt of [1, 2, 3, 4]) {
      expectAttempt(await failingCall(mocks, "scope-default"), attempt, mocks);
    }
  });

  it.each(BRANCHES)("%s: unscoped attempts 1–5 count and escalate schema without terminal guidance", async (branch) => {
    const mocks = createMocks(branch);
    for (const attempt of [1, 2, 3, 4, 5]) {
      const error = await failingCall(mocks, undefined);
      expectAttempt(error, attempt, mocks, false);
      expect(error.message).not.toContain(ORDINARY_TERMINAL);
      expect(error.message).not.toContain(MISPLACED_TERMINAL);
    }
  });

  it.each(["ordinary", "downstream"] as const)("%s: isolates non-colliding callers without clearing their progress", async (branch) => {
    const mocks = createMocks(branch);
    for (const [scope, attempt] of [["A", 1], ["A", 2], ["B", 1], ["A", 3]] as const) {
      expectAttempt(await failingCall(mocks, scope), attempt, mocks);
    }
  });

  it("normalizes absent, null, non-string, empty and whitespace-only scopes into one unattributable bucket", async () => {
    const mocks = createMocks();
    const values: unknown[] = [undefined, null, 7, false, {}, [], "", " \t\n "];
    for (const [index, scope] of values.entries()) {
      const error = await captureFailure(call(mocks, scope, {}));
      expectAttempt(error, index + 1, mocks, false);
    }
    expect(mocks.mockClient.callTool).not.toHaveBeenCalled();
  });

  it("preserves accepted scope bytes instead of trimming the identity", async () => {
    const mocks = createMocks();
    for (const [scope, attempt] of [[" A ", 1], [" A ", 2], ["A", 1], [" A ", 3], ["A", 2]] as const) {
      expectAttempt(await failingCall(mocks, scope), attempt, mocks);
    }
  });
});

describe("useTool validationAttemptMap — collision-free identity", () => {
  it("separates delimiter-colliding scope/package/tool tuples", async () => {
    const base = createMocks();
    const a = { ...base, packageId: "tuple-pkg", toolId: "t" };
    const b = { ...base, packageId: "left::tuple-pkg", toolId: "t" };
    const failures = [
      await failingCall(a, "collision::left"),
      await failingCall(a, "collision::left"),
      await failingCall(b, "collision"),
      await failingCall(a, "collision::left"),
    ];

    expect(failures.map((error) => error.data.repair_ticket?.attempt)).toEqual([1, 2, 1, 3]);
    expectAttempt(failures[0], 1, a);
    expectAttempt(failures[1], 2, a);
    expectAttempt(failures[2], 1, b);
    expectAttempt(failures[3], 3, a);
  });

  it('keeps literal "__unscoped__" attributable and distinct from missing scope', async () => {
    const mocks = createMocks();
    const failures = [
      await failingCall(mocks, undefined),
      await failingCall(mocks, undefined),
      await failingCall(mocks, "__unscoped__"),
      await failingCall(mocks, "__unscoped__"),
      await failingCall(mocks, "__unscoped__"),
      await failingCall(mocks, undefined),
    ];

    expect(failures.map((error) => error.data.repair_ticket?.attempt)).toEqual([1, 2, 1, 2, 3, 3]);
    expectAttempt(failures[0], 1, mocks, false);
    expectAttempt(failures[1], 2, mocks, false);
    expectAttempt(failures[2], 1, mocks);
    expectAttempt(failures[3], 2, mocks);
    expectAttempt(failures[4], 3, mocks);
    expectAttempt(failures[5], 3, mocks, false);
  });

  it('separates validation tool "t::downstream" from downstream phase for tool "t"', async () => {
    const base = createMocks();
    const local = { ...base, packageId: "phase-pkg", toolId: "t::downstream" };
    const downstream = { ...base, packageId: "phase-pkg", toolId: "t", branch: "downstream" as const };
    const failures = [
      await failingCall(local, "phase-scope"),
      await failingCall(local, "phase-scope"),
      await failingCall(downstream, "phase-scope"),
      await failingCall(local, "phase-scope"),
    ];

    expect(failures.map((error) => error.data.repair_ticket?.attempt)).toEqual([1, 2, 1, 3]);
    expectAttempt(failures[0], 1, local);
    expectAttempt(failures[1], 2, local);
    expectAttempt(failures[2], 1, downstream);
    expectAttempt(failures[3], 3, local);
  });
});

describe("useTool validationAttemptMap — reset targeting and phases", () => {
  it.each(["packageId", "toolId"] as const)("isolates %s counts and success resets within one caller", async (dimension) => {
    const a = createMocks();
    const b = { ...a, [dimension]: `${a[dimension]}-other` };
    expectAttempt(await failingCall(a, "A"), 1, a);
    expectAttempt(await failingCall(a, "A"), 2, a);
    expectAttempt(await failingCall(b, "A"), 1, b);
    await call(b, "A", { email: "valid@example.test" });
    expectAttempt(await failingCall(a, "A"), 3, a);
    expectAttempt(await failingCall(b, "A"), 1, b);
  });

  it.each(LOCAL_BRANCHES)("%s: caller B success preserves A, caller A success resets only A", async (branch) => {
    const mocks = createMocks(branch);
    expectAttempt(await failingCall(mocks, "A"), 1, mocks);
    expectAttempt(await failingCall(mocks, "A"), 2, mocks);
    expectAttempt(await failingCall(mocks, "B"), 1, mocks);
    await call(mocks, "B", { email: "valid@example.test" });
    expectAttempt(await failingCall(mocks, "A"), 3, mocks);
    expectAttempt(await failingCall(mocks, "B"), 1, mocks);
    await call(mocks, "A", { email: "valid@example.test" });
    expectAttempt(await failingCall(mocks, "B"), 2, mocks);
    expectAttempt(await failingCall(mocks, "A"), 1, mocks);
  });

  it("ordinary validation and permissive soft-param teaching share local history", async () => {
    const mocks = createMocks("permissive");
    const ordinary = { ...mocks, branch: "ordinary" as const };
    expectAttempt(await failingCall(ordinary, "A"), 1, ordinary);
    expectAttempt(await failingCall(mocks, "A"), 2, mocks);
    expectAttempt(await failingCall(ordinary, "A"), 3, ordinary);
    expectAttempt(await failingCall(mocks, "A"), 4, mocks);
  });

  it.each(LOCAL_BRANCHES)("%s: local failure resets only its caller's downstream history; downstream entry resets local history", async (branch) => {
    const mocks = createMocks(branch);
    const downstream = { ...mocks, branch: "downstream" as const };
    expectAttempt(await failingCall(downstream, "A"), 1, downstream);
    expectAttempt(await failingCall(downstream, "A"), 2, downstream);
    expectAttempt(await failingCall(downstream, "B"), 1, downstream);
    expectAttempt(await failingCall(mocks, "A"), 1, mocks);
    expectAttempt(await failingCall(mocks, "A"), 2, mocks);
    expectAttempt(await failingCall(downstream, "B"), 2, downstream);
    expectAttempt(await failingCall(downstream, "A"), 1, downstream);
    expectAttempt(await failingCall(mocks, "A"), 1, mocks);
  });

  it.each(["dry-run", "success", "output-validation", "other-error"] as const)(
    "%s resets only the current caller's downstream attempts",
    async (outcome) => {
      const mocks = createMocks("downstream");
      expectAttempt(await failingCall(mocks, "A"), 1, mocks);
      expectAttempt(await failingCall(mocks, "A"), 2, mocks);
      expectAttempt(await failingCall(mocks, "B"), 1, mocks);
      const before = mocks.mockClient.callTool.mock.calls.length;
      if (outcome === "output-validation") {
        mocks.mockClient.callTool.mockRejectedValueOnce(new McpError(
          SdkErrorCode.InvalidParams,
          "Structured content does not match the tool's output schema: email must be string",
        ));
      } else if (outcome === "other-error") {
        mocks.mockClient.callTool.mockRejectedValueOnce(new Error("connector failed"));
      }
      const operation = call(mocks, "A", { email: "valid@example.test" }, { dry_run: outcome === "dry-run" });
      if (outcome === "output-validation" || outcome === "other-error") {
        await expect(operation).rejects.toMatchObject({ code: -33007 });
      } else {
        await expect(operation).resolves.toMatchObject({ isError: false });
      }
      expect(mocks.mockClient.callTool).toHaveBeenCalledTimes(before + (outcome === "dry-run" ? 0 : 1));
      expectAttempt(await failingCall(mocks, "B"), 2, mocks);
      expectAttempt(await failingCall(mocks, "A"), 1, mocks);
    },
  );
});

describe("useTool validationAttemptMap — early dispatch preservation", () => {
  it.each([
    { label: "malformed args", args: 42 },
    { label: "hard meta-param", args: { max_output_chars: 100 } },
  ])("$label rejects before counting or dispatch and preserves existing history", async ({ args }) => {
    const mocks = createMocks();
    for (let repeat = 0; repeat < 4; repeat++) {
      const error = await captureFailure(call(mocks, "A", structuredClone(args)));
      expect(error.data.validation_stage).toBe("dispatch");
      expect(error.data).not.toHaveProperty("repair_ticket");
      expect(error.message).not.toContain(ORDINARY_TERMINAL);
      expect(error.message).not.toContain(MISPLACED_TERMINAL);
    }
    expect(mocks.mockRegistry.getPackage).not.toHaveBeenCalled();
    expectAttempt(await failingCall(mocks, "A"), 1, mocks);
    await captureFailure(call(mocks, "A", structuredClone(args)));
    expectAttempt(await failingCall(mocks, "A"), 2, mocks);
    expect(mocks.mockClient.callTool).not.toHaveBeenCalled();
  });
});

describe("useTool validationAttemptMap — exact bounded LRU", () => {
  it("hits at capacity never evict another entry", async () => {
    vi.resetModules();
    const { handleUseTool: freshUseTool } = await import("../src/handlers/useTool.js");
    const mocks = createMocks();
    for (const scope of ["A", "B"]) {
      expectAttempt(await failingCall(mocks, scope, freshUseTool), 1, mocks);
      expectAttempt(await failingCall(mocks, scope, freshUseTool), 2, mocks);
    }
    for (let i = 0; i < 498; i++) {
      expectAttempt(await failingCall(mocks, `filler-${i}`, freshUseTool), 1, mocks);
    }
    // Touch a key that is NOT oldest: eviction on every access would erase A.
    expectAttempt(await failingCall(mocks, "B", freshUseTool), 3, mocks);
    expectAttempt(await failingCall(mocks, "A", freshUseTool), 3, mocks);
  });

  it("keeps exactly 500 entries, refreshes hits and evicts exactly one least-recent entry", async () => {
    // Fresh module: other tests' process-global counters cannot act as spare victims.
    vi.resetModules();
    const { handleUseTool: freshUseTool } = await import("../src/handlers/useTool.js");
    const mocks = createMocks();
    for (const scope of ["A", "B", "C"]) {
      expectAttempt(await failingCall(mocks, scope, freshUseTool), 1, mocks);
      expectAttempt(await failingCall(mocks, scope, freshUseTool), 2, mocks);
    }
    for (let i = 0; i < 497; i++) {
      expectAttempt(await failingCall(mocks, `filler-${i}`, freshUseTool), 1, mocks);
    }
    // A was oldest: touching it distinguishes true LRU from FIFO. C is inspected
    // before reinserting B so a spurious second eviction cannot be concealed.
    expectAttempt(await failingCall(mocks, "A", freshUseTool), 3, mocks);
    expectAttempt(await failingCall(mocks, "spill", freshUseTool), 1, mocks);
    expectAttempt(await failingCall(mocks, "C", freshUseTool), 3, mocks);
    expectAttempt(await failingCall(mocks, "A", freshUseTool), 4, mocks);
    expectAttempt(await failingCall(mocks, "B", freshUseTool), 1, mocks);
  });
});
