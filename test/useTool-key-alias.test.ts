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
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
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

  it("rewrites multiple aliases in one call (MS calendar snake_case → camelCase)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "Microsoft-foo",
    });

    const response = await handleUseTool(
      {
        package_id: "Microsoft-foo",
        tool_id: "list_workspace_calendar_events",
        args: {
          start_datetime: "2026-05-17T00:00:00Z",
          end_datetime: "2026-05-17T23:59:59Z",
          device_timezone: "Europe/London",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_calendar_events", {
      startDateTime: "2026-05-17T00:00:00Z",
      endDateTime: "2026-05-17T23:59:59Z",
      deviceTimezone: "Europe/London",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:start_datetime→startDateTime",
      "key_alias:end_datetime→endDateTime",
      "key_alias:device_timezone→deviceTimezone",
    ]);
  });
});
