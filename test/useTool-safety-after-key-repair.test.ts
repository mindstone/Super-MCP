// use_tool admits a call on the arguments the agent sent, then may rename a key to the
// schema's spelling (`file_name` → `filename`, normalizeInput.ts). The dispatch backstop in
// registry.callTool must see the renamed arguments, so a restricted argument cannot slip in
// under another spelling (PLAN § Technical Design, "Argument-scoped local-fs").

import { describe, expect, it, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { ERROR_CODES } from "../src/types.js";
import { Validator } from "../src/validator.js";
import type { Catalog } from "../src/catalog.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const REASON = "Turned off for safety: saving to a file on this computer isn't allowed. Leave out `filename` and try again.";

function setup() {
  const registry = new PackageRegistry({
    mcpServers: { "browser-2": { command: "unused", catalogId: "playwright" } },
  } as never);
  const lease = vi.spyOn(registry as never, "acquireLease");
  const inputSchema = {
    type: "object",
    properties: { filename: { type: "string" }, type: { type: "string" } },
    additionalProperties: false,
  };
  const entry = { packageId: "browser-2", tool: { name: "browser_take_screenshot", inputSchema }, schemaHash: "" };
  const catalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn((p: string, t: string) => (p === "browser-2" && t === "browser_take_screenshot" ? entry : undefined)),
    getToolSchema: vi.fn((p: string, t: string) => (p === "browser-2" && t === "browser_take_screenshot" ? inputSchema : undefined)),
  } as unknown as Catalog;
  return { registry, catalog, lease };
}

async function call(args: Record<string, unknown>) {
  const { registry, catalog, lease } = setup();
  const outcome = await handleUseTool(
    { package_id: "browser-2", tool_id: "browser_take_screenshot", args, max_output_chars: null },
    registry,
    catalog,
    new Validator(),
  ).then((result) => ({ result }), (error: unknown) => ({ error }));
  return { outcome, lease };
}

describe("use_tool refuses a restricted argument that key repair renames into place", () => {
  it("refuses file_name once it is repaired to filename, before any connector starts", async () => {
    const { outcome, lease } = await call({ file_name: "shot.png" });
    expect(outcome).toEqual({
      error: {
        code: ERROR_CODES.TOOL_BLOCKED,
        message: `Tool 'browser-2__browser_take_screenshot': ${REASON}`,
        data: { package_id: "browser-2", tool_id: "browser_take_screenshot", blocked_reason: REASON, reason: "security-policy" },
      },
    });
    expect(lease).not.toHaveBeenCalled();
  });

  it("refuses the canonical spelling at admission", async () => {
    const { outcome, lease } = await call({ filename: "shot.png" });
    expect(JSON.stringify(outcome)).toContain("Turned off for safety: saving to a file");
    expect(lease).not.toHaveBeenCalled();
  });

  it("lets the call through without the argument (positive control)", async () => {
    const { outcome, lease } = await call({ type: "png" });
    expect(JSON.stringify(outcome)).not.toContain("Turned off for safety");
    expect(lease).toHaveBeenCalled();
  });
});
