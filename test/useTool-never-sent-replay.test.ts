import { describe, expect, it, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

// FOX-11496: use_tool asks the registry to replay a never-sent call only when the
// connector's own annotations say the tool reads, or repeats safely, and is not destructive.

function createMocks(annotations: Record<string, boolean> | undefined) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
    callTool,
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const getTool = (packageId: string, toolId: string) =>
    packageId === "pkg1" && toolId === "tool1"
      ? { packageId, tool: { name: toolId, inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation((packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema),
  } as unknown as Catalog;
  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };
  return { mockRegistry, mockCatalog, mockValidator, callTool };
}

describe("use_tool and the never-sent replay", () => {
  it.each([
    ["no annotations", undefined, false],
    ["empty annotations", {}, false],
    ["read-only", { readOnlyHint: true }, true],
    ["idempotent", { idempotentHint: true }, true],
    ["read-only and idempotent", { readOnlyHint: true, idempotentHint: true }, true],
    ["read-only but destructive", { readOnlyHint: true, destructiveHint: true }, false],
    ["idempotent but destructive", { idempotentHint: true, destructiveHint: true }, false],
    ["idempotent, explicitly not read-only", { idempotentHint: true, readOnlyHint: false }, true],
    ["read-only, explicitly not destructive", { readOnlyHint: true, destructiveHint: false }, true],
    ["explicitly not read-only or idempotent", { readOnlyHint: false, idempotentHint: false }, false],
    ["destructive only", { destructiveHint: true }, false],
  ] as const)("use_tool asks for the replay only for a tool that is read-only or idempotent and not destructive: %s", async (_name, annotations, expected) => {
    const { mockRegistry, mockCatalog, mockValidator, callTool } = createMocks(annotations as Record<string, boolean> | undefined);
    await handleUseTool({ package_id: "pkg1", tool_id: "tool1", args: {} }, mockRegistry, mockCatalog, mockValidator);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0].at(-1)).toEqual({ replayNeverSent: expected });
  });
});
