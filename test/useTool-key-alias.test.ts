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

  it("Google Workspace draft: rewrites stale camelCase → snake_case before validation", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "GoogleWorkspace-alexs-mindstone-com",
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-alexs-mindstone-com",
        tool_id: "create_workspace_draft",
        args: {
          to: ["debug-recipient@example.com"],
          subject: "REBEL-609 draft routing test",
          body: "This is a draft routing test.",
          isHtml: false,
          threadId: "thread-123",
          replyToMessageId: "message-123",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      {
        to: ["debug-recipient@example.com"],
        subject: "REBEL-609 draft routing test",
        body: "This is a draft routing test.",
        is_html: false,
        thread_id: "thread-123",
        reply_to_message_id: "message-123",
      },
      expect.objectContaining({ tool_id: "create_workspace_draft" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("create_workspace_draft", {
      to: ["debug-recipient@example.com"],
      subject: "REBEL-609 draft routing test",
      body: "This is a draft routing test.",
      is_html: false,
      thread_id: "thread-123",
      reply_to_message_id: "message-123",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:isHtml→is_html",
      "key_alias:replyToMessageId→reply_to_message_id",
      "key_alias:threadId→thread_id",
    ]);
  });

  it("Google Workspace calendar: rewrites camelCase → snake_case before validation (REBEL-13Y)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "GoogleWorkspace-alexs-mindstone-com",
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-alexs-mindstone-com",
        tool_id: "list_workspace_calendar_events",
        args: {
          email: "user@example.com",
          deviceTimezone: "Europe/London",
          returnJson: true,
          maxResults: 25,
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      {
        email: "user@example.com",
        max_results: 25,
        return_json: true,
        device_timezone: "Europe/London",
      },
      expect.objectContaining({ tool_id: "list_workspace_calendar_events" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_calendar_events", {
      email: "user@example.com",
      max_results: 25,
      return_json: true,
      device_timezone: "Europe/London",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:maxResults→max_results",
      "key_alias:returnJson→return_json",
      "key_alias:deviceTimezone→device_timezone",
    ]);
  });

  it("Google Workspace calendar: rewrites manage_workspace_calendar_event camelCase before validation (REBEL-13Y review F3)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "GoogleWorkspace-alexs-mindstone-com",
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-alexs-mindstone-com",
        tool_id: "manage_workspace_calendar_event",
        args: {
          email: "user@example.com",
          eventId: "abc123",
          action: "update_time",
          newTimes: [
            {
              start: { dateTime: "2026-06-01T09:00:00Z" },
              end: { dateTime: "2026-06-01T10:00:00Z" },
            },
          ],
          colorId: "7",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      {
        email: "user@example.com",
        event_id: "abc123",
        action: "update_time",
        new_times: [
          {
            start: { dateTime: "2026-06-01T09:00:00Z" },
            end: { dateTime: "2026-06-01T10:00:00Z" },
          },
        ],
        color_id: "7",
      },
      expect.objectContaining({ tool_id: "manage_workspace_calendar_event" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("manage_workspace_calendar_event", {
      email: "user@example.com",
      event_id: "abc123",
      action: "update_time",
      new_times: [
        {
          start: { dateTime: "2026-06-01T09:00:00Z" },
          end: { dateTime: "2026-06-01T10:00:00Z" },
        },
      ],
      color_id: "7",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:eventId→event_id",
      "key_alias:newTimes→new_times",
      "key_alias:colorId→color_id",
    ]);
  });

  it("Google Workspace calendar: rewrites delete_workspace_calendar_event camelCase before validation (REBEL-13Y review F3)", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();
    (mockRegistry.getPackage as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "GoogleWorkspace-alexs-mindstone-com",
    });

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-alexs-mindstone-com",
        tool_id: "delete_workspace_calendar_event",
        args: {
          email: "user@example.com",
          eventId: "abc123",
          sendUpdates: "all",
          deletionScope: "this_and_following",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("delete_workspace_calendar_event", {
      email: "user@example.com",
      event_id: "abc123",
      send_updates: "all",
      deletion_scope: "this_and_following",
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "key_alias:eventId→event_id",
      "key_alias:sendUpdates→send_updates",
      "key_alias:deletionScope→deletion_scope",
    ]);
  });
});
