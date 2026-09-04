// R3 integration test: useTool wires normalizeArgKeys between R1 coercion and
// the validator, emits breadcrumbs on _meta.superMcp.normalisations, and
// forwards the rewritten args to the downstream client.
//
// See: super-mcp/src/handlers/useTool.ts
//      super-mcp/src/utils/normalizeInput.ts
//      super-mcp/src/config/paramAliasMap.ts

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

function createMocks() {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };

  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "Slack-test" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const toolSchema = {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
  const knownTargets = new Set([
    "Slack-test\0search_slack_messages",
    "Slack-test\0list_slack_channels",
    "HubSpot-x\0create_hubspot_note",
    "Microsoft-foo\0list_workspace_calendar_events",
  ]);
  const getTool = (packageId: string, toolId: string) =>
    knownTargets.has(`${packageId}\0${toolId}`)
      ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

describe("useTool R3 — per-tool key-alias normalisation", () => {
  it("Slack: rewrites limit → count, emits breadcrumb, forwards rewritten args", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "Slack-test",
        tool_id: "search_slack_messages",
        args: { limit: 25, query: "stand-up" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("search_slack_messages", {
      count: 25,
      query: "stand-up",
    });
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      { count: 25, query: "stand-up" },
      expect.objectContaining({ tool_id: "search_slack_messages" }),
    );

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual(["key_alias:limit→count"]);
  });

  it("HubSpot: rewrites body → properties.hs_note_body (nested target creation)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({ id: "HubSpot-x" });

    const response = await handleUseTool(
      {
        package_id: "HubSpot-x",
        tool_id: "create_hubspot_note",
        args: { body: "hello world" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("create_hubspot_note", {
      properties: { hs_note_body: "hello world" },
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:body→properties.hs_note_body",
    ]);
  });

  it("emits skipped breadcrumb (and drops source) when target already present", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "Slack-test",
        tool_id: "search_slack_messages",
        args: { limit: 25, count: 50, query: "stand-up" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("search_slack_messages", {
      count: 50,
      query: "stand-up",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias_skipped:limit→count:target_exists",
    ]);
  });

  it("no normalisation breadcrumb when the tool has no map entry", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "Slack-test",
        tool_id: "list_slack_channels",
        args: { limit: 25 },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp).toBeDefined();
    expect(superMcp).not.toHaveProperty("normalisations");
  });

  it("coexists with R1 — undefined args produces only the coerce breadcrumb", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "Slack-test",
        tool_id: "search_slack_messages",
        args: undefined as unknown as Record<string, unknown>,
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("search_slack_messages", {});

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual(["coerce_undefined_args"]);
  });

  // NOTE (Stage 0, 2026-06-16): the Microsoft Graph and Google Workspace
  // camelCase↔snake_case alias tests were removed from this file along with the
  // alias-map entries they exercised. Those re-casing failures are now handled
  // by the schema-driven `canonicalKeyNormalize` auto-repair — see
  // `test/useTool-auto-repair.test.ts` (end-to-end, real Validator) and
  // `test/autoRepair-normalize.test.ts` (pure-function unit tests). Only the
  // irreducible synonym/nested-rename entries (Slack `limit→count`, HubSpot
  // `body→properties.hs_note_body`) remain in the alias map and are covered by
  // the retained tests above.

  it("retained HubSpot synonym: note_body → properties.hs_note_body", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({ id: "HubSpot-x" });

    const response = await handleUseTool(
      {
        package_id: "HubSpot-x",
        tool_id: "create_hubspot_note",
        args: { note_body: "hello world" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("create_hubspot_note", {
      properties: { hs_note_body: "hello world" },
    });
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:note_body→properties.hs_note_body",
    ]);
  });

  it("removed Microsoft casing alias no longer rewrites (delegated to auto-repair)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({ id: "Microsoft-foo" });

    // Mock validator returns valid, so the auto-repair pass is NOT triggered;
    // with the alias map entry gone, the camelCase key passes through untouched.
    const response = await handleUseTool(
      {
        package_id: "Microsoft-foo",
        tool_id: "list_workspace_calendar_events",
        args: { device_timezone: "Europe/London" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_calendar_events", {
      device_timezone: "Europe/London",
    });
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp).not.toHaveProperty("normalisations");
  });
});
