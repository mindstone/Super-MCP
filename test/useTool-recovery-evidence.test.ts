import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleUseTool } from "../src/handlers/useTool.js";
import { extractRecoveryEvidenceV1, RECOVERY_EVIDENCE_LIMITS } from "../src/handlers/recoveryEvidence.js";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";
import type { UseToolInput } from "../src/types.js";

const packageId = "example-package";
const toolId = "lookup";
function mocks(inner: unknown) {
  const callTool = vi.fn().mockResolvedValue(inner);
  const registry = {
    getPackage: () => ({ id: packageId }), callTool, notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const tool = { packageId, tool: { name: toolId, inputSchema: { type: "object" } }, schemaHash: "" };
  const catalog = {
    ensurePackageLoaded: async () => {}, getPackageStatus: () => "ready", getRefreshInFlight: () => false,
    getPackageError: () => undefined, getRetryHint: () => ({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: (pkg: string, id: string) => pkg === packageId && id === toolId ? tool : undefined,
    getToolSchema: () => tool.tool.inputSchema,
  } as unknown as Catalog;
  const validator = { validate: () => ({ valid: true, errors: [], strippedArgs: [] }) };
  return { registry, catalog, validator, callTool };
}
async function produce(inner: unknown, options: Partial<UseToolInput> = {}) {
  const context = mocks(inner);
  const result = await handleUseTool({ package_id: packageId, tool_id: toolId, args: {}, ...options }, context.registry, context.catalog, context.validator);
  return { result, callTool: context.callTool };
}
const text = (payload: unknown) => ({ type: "text", text: JSON.stringify(payload) });

describe("use_tool constructed recovery evidence", () => {
  let workspace: string;
  let originalWorkspace: string | undefined;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-recovery-"));
    originalWorkspace = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = workspace;
  });
  afterEach(async () => {
    if (originalWorkspace === undefined) delete process.env.REBEL_WORKSPACE_PATH;
    else process.env.REBEL_WORKSPACE_PATH = originalWorkspace;
    await fs.rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("retains only original primitive controls when a long error is materialized", async () => {
    const inner = { content: [text({ error: "界".repeat(31_000), ok: false, code: "invalid_auth", resolution: "private workspace", token: "private token" })], isError: true };
    const { result, callTool } = await produce(inner);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result._meta.materialization.status).toBe("materialized");
    expect(result._meta.superMcp).toMatchObject({ packageId, toolId, recoveryEvidenceV1: { version: 1, candidates: [{ ok: false, code: "invalid_auth" }] } });
    expect(JSON.stringify(result._meta.superMcp.recoveryEvidenceV1)).not.toMatch(/private|error|resolution|token/);
    expect(result.content[0].text).not.toContain('"code": "invalid_auth"');
    expect(inner.content[0].text).toContain("private token"); // Original result is not mutated.
  });

  it("does not classify codes and preserves direct-before-content ordering", () => {
    expect(extractRecoveryEvidenceV1({ ok: false, code: "unknown_control_code", content: [text({ ok: false, code: "channel_not_found" }), text({ status: "auth_required" })] })).toEqual({ version: 1, candidates: [{ ok: false, code: "unknown_control_code" }, { ok: false, code: "channel_not_found" }, { status: "auth_required" }] });
  });

  it("preserves action-first rejection and ignores metadata/structured data as authority", () => {
    expect(extractRecoveryEvidenceV1({ action: "auth_required", auth_tool: "bad-tool", reason: "token_expired", status: "auth_required", ok: false, code: "invalid_auth" })).toBeUndefined();
    expect(extractRecoveryEvidenceV1({ structuredContent: { ok: false, code: "invalid_auth" }, _meta: { superMcp: { recoveryEvidenceV1: { version: 1, candidates: [{ status: "auth_required" }] } } } })).toBeUndefined();
  });

  it("replaces a forged reserved field while keeping UI and successful data", async () => {
    const structuredContent = { value: 42 };
    const ui = { resourceUri: "ui://example/view", sourcePackageId: packageId };
    const inner = { content: [text({ status: "auth_required" })], structuredContent, _meta: { ui, superMcp: { extra: "retained", recoveryEvidenceV1: { version: 1, candidates: [{ ok: false, code: "forged_code" }] } } } };
    const { result } = await produce(inner, { max_output_chars: null });
    expect(result._meta.ui).toEqual(ui);
    expect(result.structuredContent).toEqual(structuredContent);
    expect(result._meta.superMcp.recoveryEvidenceV1).toEqual({ version: 1, candidates: [{ status: "auth_required" }] });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.result._meta.superMcp).toEqual({ extra: "retained" });
    expect(inner._meta.superMcp.recoveryEvidenceV1.candidates[0].code).toBe("forged_code");
  });

  it("removes connector-only evidence without inventing authority", async () => {
    const { result } = await produce({ content: [{ type: "text", text: "success" }], _meta: { superMcp: { recoveryEvidenceV1: { version: 1, candidates: [{ status: "auth_required" }] } } } });
    expect(result._meta.superMcp.recoveryEvidenceV1).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("recoveryEvidenceV1");
  });

  it.each([undefined, 1_000, 80_000, null])("preserves output budget %s and ordinary success materialization", async (budget) => {
    const { result } = await produce({ content: [{ type: "text", text: "界".repeat(31_000) }] }, budget === undefined ? {} : { max_output_chars: budget });
    expect(Boolean(result._meta.materialization)).toBe(budget === undefined || budget === 1_000);
    expect(result._meta.superMcp.recoveryEvidenceV1).toBeUndefined();
  });

  it.each([
    ["content_blocks", () => Array.from({ length: RECOVERY_EVIDENCE_LIMITS.contentBlocks }, () => text({}))],
    ["text_size", () => [{ type: "text", text: " ".repeat(RECOVERY_EVIDENCE_LIMITS.textCodeUnits + 1) }]],
    ["parse_budget", () => Array.from({ length: 5 }, () => ({ type: "text", text: " ".repeat(RECOVERY_EVIDENCE_LIMITS.textCodeUnits) }))],
    ["candidates", () => Array.from({ length: RECOVERY_EVIDENCE_LIMITS.candidates }, () => text({ status: "auth_required" }))],
  ] as const)("discards all earlier and later controls on %s overflow", (overflow, middle) => {
    const content = [text({ ok: false, code: "invalid_auth" }), ...middle(), text({ status: "auth_required" })];
    expect(extractRecoveryEvidenceV1({ content })).toEqual({ version: 1, candidates: [], overflow });
  });

  it("accepts the candidate boundary and ignores malformed/prose blocks", () => {
    const content = [{ type: "text", text: "not JSON" }, { type: "image", text: '{"status":"auth_required"}' }, ...Array.from({ length: RECOVERY_EVIDENCE_LIMITS.candidates }, () => text({ status: "auth_required" }))];
    expect(extractRecoveryEvidenceV1({ content })?.candidates).toHaveLength(RECOVERY_EVIDENCE_LIMITS.candidates);
  });
});
