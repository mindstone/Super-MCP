// Contract test for the TOOL_BLOCKED error shape. Hosts (e.g. the Rebel MCP
// Apps relay) branch on the closed `data.reason` discriminator, and older
// consumers fall back to string-matching the message / legacy boolean flags.
// This test pins all three surfaces for each block kind so none can drift
// silently:
//   - code === ERROR_CODES.TOOL_BLOCKED (-33008)
//   - data.reason is the expected ToolBlockedReason value
//   - legacy fields (blocked_reason / user_disabled / admin_disabled) survive
//   - the message substring older text-match detectors rely on is unchanged

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { SecurityPolicy, setSecurityPolicy } from "../src/security.js";
import { ERROR_CODES } from "../src/types.js";
import type { PackageConfig } from "../src/types.js";
import { ValidationResult } from "../src/validator.js";

function createMocks(opts: { packages: PackageConfig[] }) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };

  const packagesById = new Map(opts.packages.map(p => [p.id, p]));

  const mockRegistry = {
    getPackage: vi.fn((id: string) => packagesById.get(id)),
    findPackagesByAlias: vi.fn(() => []),
    getClient: vi.fn().mockResolvedValue(mockClient),
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const getTool = (packageId: string, toolId: string) =>
    packagesById.has(packageId) && toolId === "send_message"
      ? { packageId, tool: { name: toolId, inputSchema: { type: "object" } }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
    findToolByName: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator };
}

function callUseTool(
  mocks: ReturnType<typeof createMocks>,
  package_id: string,
  tool_id: string,
) {
  return handleUseTool(
    { package_id, tool_id, args: {}, max_output_chars: null },
    mocks.mockRegistry,
    mocks.mockCatalog,
    mocks.mockValidator,
  );
}

describe("TOOL_BLOCKED error contract — closed data.reason discriminator", () => {
  afterEach(() => {
    // getSecurityPolicy() is a module-level singleton; reset so other suites
    // are not polluted by the block rules configured here.
    setSecurityPolicy(new SecurityPolicy({}));
  });

  it("security-policy block: code -33008, reason 'security-policy', legacy blocked_reason kept", async () => {
    setSecurityPolicy(new SecurityPolicy({ blockedTools: ["send_message"] }));
    const mocks = createMocks({
      packages: [{ id: "TestPkg", name: "TestPkg", transport: "stdio", visibility: "default" }],
    });

    await expect(callUseTool(mocks, "TestPkg", "send_message")).rejects.toMatchObject({
      code: ERROR_CODES.TOOL_BLOCKED,
      message: expect.stringContaining("is explicitly blocked"),
      data: expect.objectContaining({
        reason: "security-policy",
        blocked_reason: expect.stringContaining("is explicitly blocked"),
        package_id: "TestPkg",
        tool_id: "send_message",
      }),
    });
  });

  it("admin-disabled: code -33008, reason 'admin-disabled', legacy admin_disabled flag kept", async () => {
    const policy = new SecurityPolicy({});
    policy.setAdminDisabledTools({ "test-catalog": ["send_message"] });
    setSecurityPolicy(policy);
    const mocks = createMocks({
      packages: [{ id: "TestPkg", name: "TestPkg", transport: "stdio", visibility: "default", catalogId: "test-catalog" }],
    });

    await expect(callUseTool(mocks, "TestPkg", "send_message")).rejects.toMatchObject({
      code: ERROR_CODES.TOOL_BLOCKED,
      // Pinned substring: older consumers text-match on this wording.
      message: expect.stringContaining("disabled by your organization's administrator"),
      data: expect.objectContaining({
        reason: "admin-disabled",
        blocked_reason: "Disabled by administrator",
        admin_disabled: true,
        package_id: "TestPkg",
        tool_id: "send_message",
      }),
    });
  });

  it("user-disabled: code -33008, reason 'user-disabled', legacy user_disabled flag kept", async () => {
    const policy = new SecurityPolicy({});
    policy.setUserDisabledTools({ TestPkg: ["send_message"] });
    setSecurityPolicy(policy);
    const mocks = createMocks({
      packages: [{ id: "TestPkg", name: "TestPkg", transport: "stdio", visibility: "default" }],
    });

    await expect(callUseTool(mocks, "TestPkg", "send_message")).rejects.toMatchObject({
      code: ERROR_CODES.TOOL_BLOCKED,
      // Pinned substring: the compose app's text-match fallback keys on
      // "disabled by user preference" — do not reword without a major-version
      // coordination across consumers.
      message: expect.stringContaining("disabled by user preference"),
      data: expect.objectContaining({
        reason: "user-disabled",
        blocked_reason: "Disabled by user",
        user_disabled: true,
        package_id: "TestPkg",
        tool_id: "send_message",
      }),
    });
  });

  it("does not add reason to non-blocked errors (PACKAGE_NOT_FOUND untouched)", async () => {
    setSecurityPolicy(new SecurityPolicy({}));
    const mocks = createMocks({ packages: [] });

    await expect(callUseTool(mocks, "MissingPkg", "send_message")).rejects.toMatchObject({
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      data: expect.not.objectContaining({ reason: expect.anything() }),
    });
  });
});
