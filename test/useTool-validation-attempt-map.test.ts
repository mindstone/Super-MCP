// A2 contract: the module-global validationAttemptMap (keyed
// `${package_id}::${tool_id}`) must bound its size with TRUE LRU eviction.
// The old wholesale clear() at the 500-entry cap silently reset every caller's
// retry counter at once, so one caller hitting the cap erased other callers'
// progress toward STOP_RETRYING_THRESHOLD (and re-armed the 260806 retry loop
// for them). Key shape stays package::tool — no session/caller discriminator
// exists at the handleUseTool boundary (both plan critiques F3/F2 verified),
// and inventing one would reset the counter every call.
//
// See: docs/plans/260817_chunk9-supermcp-connector/PLAN.md Stage A2.
// NOTE: `test` (not `src/handlers/__tests__`): vitest.config.ts includes both;
// the other useTool integration harnesses live here.

import { describe, expect, it, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES } from "../src/types.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import { Validator } from "../src/validator.js";

// Load-bearing, classifier-stable prefix of STOP_RETRYING_MESSAGE
// (useTool.ts:155-171): the host renderer's isArgValidationExhausted
// substring-matches "stop re-sending the same call shape".
const STOP_RETRYING_SUBSTRING = "Stop re-sending the same call shape";

// A schema that can never be satisfied by `args: {}` — guarantees every call
// below fails at the teaching branch (ARG_VALIDATION_FAILED) so the attempt
// counter is the only input that changes between calls.
const UNFULFILLABLE_SCHEMA = {
  type: "object",
  properties: { email: { type: "string" } },
  required: ["email"],
  additionalProperties: false,
};

function createMocks() {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn((id: string) => ({ id, name: id, transport: "stdio" })),
    getClient: vi.fn().mockResolvedValue(mockClient),
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue(UNFULFILLABLE_SCHEMA),
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
  // REAL validator so the ARG_VALIDATION_FAILED teaching branch is exercised
  // end-to-end (mirrors test/useTool-auto-repair.test.ts).
  const validator = new Validator();
  return { mockRegistry, mockCatalog, validator };
}

type Mocks = ReturnType<typeof createMocks>;

/** Drive one guaranteed arg-validation failure for (packageId, toolId). */
async function failingCall(packageId: string, toolId: string, mocks: Mocks): Promise<{ code: unknown; message: string }> {
  let caught: unknown;
  try {
    await handleUseTool(
      { package_id: packageId, tool_id: toolId, args: {} },
      mocks.mockRegistry,
      mocks.mockCatalog,
      mocks.validator,
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const err = caught as { code?: unknown; message?: string };
  expect(err.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
  expect(typeof err.message).toBe("string");
  return { code: err.code, message: err.message ?? "" };
}

describe("useTool validationAttemptMap — threshold and bounded LRU", () => {
  it("N failures on the same (package, tool) still trip the stop-retrying threshold at 3", async () => {
    const mocks = createMocks();

    const first = await failingCall("ThresholdPkg", "failing_tool", mocks);
    const second = await failingCall("ThresholdPkg", "failing_tool", mocks);
    const third = await failingCall("ThresholdPkg", "failing_tool", mocks);

    expect(first.message).not.toContain(STOP_RETRYING_SUBSTRING);
    expect(second.message).not.toContain(STOP_RETRYING_SUBSTRING);
    expect(third.message).toContain(STOP_RETRYING_SUBSTRING);
  });

  it("past capacity, evicts ONLY the oldest entry and preserves a recently-touched counter (clear() regression)", async () => {
    const mocks = createMocks();

    // Longest-lived key (`oldest_tool`) is inserted first → LRU victim.
    await failingCall("LRUPkg", "oldest_tool", mocks);
    await failingCall("LRUPkg", "oldest_tool", mocks);

    // Recently-touched key (`anchor_tool`) — counter 2 that must survive.
    await failingCall("LRUPkg", "anchor_tool", mocks);
    await failingCall("LRUPkg", "anchor_tool", mocks);

    // Fill to exactly MAX_ATTEMPT_MAP_SIZE (500): +498 distinct keys.
    for (let i = 0; i < 498; i++) {
      await failingCall(`LRUPkgFill${i}`, "fill_tool", mocks);
    }

    // Touch the anchor at capacity: its 3rd failure must still carry the
    // terminal guidance. Under the old code this increment hit the >=500 cap,
    // clear()ed the whole map, and the anchor restarted at attempt 1 with no
    // guidance — the regression this stage fixes.
    const anchorThird = await failingCall("LRUPkg", "anchor_tool", mocks);
    expect(anchorThird.message).toContain(STOP_RETRYING_SUBSTRING);

    // Overflow one more distinct key: with true LRU only the oldest entry
    // (oldest_tool) is evicted.
    await failingCall("LRUOverflowPkg", "spill_tool", mocks);

    // The evicted key restarts from 1 — its 3rd overall failure shows no
    // guidance (counter was evicted with the entry).
    const oldestThird = await failingCall("LRUPkg", "oldest_tool", mocks);
    expect(oldestThird.message).not.toContain(STOP_RETRYING_SUBSTRING);
  });
});
