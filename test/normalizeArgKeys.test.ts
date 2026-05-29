// R3 unit tests for normalizeArgKeys + the per-tool alias map.
// Verifies direction, target-wins collision, nested-target creation,
// reserved-key exclusion, and no-op cases.
//
// See: super-mcp/src/config/paramAliasMap.ts
//      super-mcp/src/utils/normalizeInput.ts

import { describe, it, expect } from "vitest";
import {
  normalizeArgKeys,
  formatKeyAliasBreadcrumb,
} from "../src/utils/normalizeInput.js";
import { getAliasesForTool } from "../src/config/paramAliasMap.js";

const ctx = (tool_id: string, package_id = "pkg") => ({
  handler: "use_tool" as const,
  package_id,
  tool_id,
});

describe("normalizeArgKeys — alias map directions", () => {
  it("Slack search_slack_messages: limit → count", () => {
    const aliases = getAliasesForTool("Slack-test", "search_slack_messages");
    expect(aliases).toEqual([{ from: "limit", to: "count" }]);
  });

  it("Microsoft calendar list: start_datetime/end_datetime/device_timezone → camelCase", () => {
    const aliases = getAliasesForTool(
      "Microsoft-foo",
      "list_workspace_calendar_events"
    );
    expect(aliases).toEqual([
      { from: "start_datetime", to: "startDateTime" },
      { from: "end_datetime", to: "endDateTime" },
      { from: "device_timezone", to: "deviceTimezone" },
    ]);
  });

  it("HubSpot create_hubspot_note: body / note_body → properties.hs_note_body (nested)", () => {
    const aliases = getAliasesForTool("HubSpot-x", "create_hubspot_note");
    expect(aliases).toEqual([
      { from: "body", to: "properties.hs_note_body" },
      { from: "note_body", to: "properties.hs_note_body" },
    ]);
  });

  it("Google Workspace create_workspace_draft: stale camelCase → snake_case", () => {
    const aliases = getAliasesForTool(
      "GoogleWorkspace-alexs-mindstone-com",
      "create_workspace_draft"
    );
    expect(aliases).toEqual([
      { from: "isHtml", to: "is_html" },
      { from: "replyToMessageId", to: "reply_to_message_id" },
      { from: "threadId", to: "thread_id" },
      { from: "inReplyTo", to: "in_reply_to" },
    ]);
  });

  it("returns [] for a tool with no aliases", () => {
    expect(getAliasesForTool("anything", "list_slack_channels")).toEqual([]);
  });

  it("returns [] when a shared tool name belongs to a different package family", () => {
    expect(
      getAliasesForTool(
        "GoogleWorkspace-alexs-mindstone-com",
        "list_workspace_calendar_events"
      )
    ).toEqual([]);
    expect(getAliasesForTool("Slack-test", "create_workspace_draft")).toEqual([]);
  });
});

describe("normalizeArgKeys — top-level replacement semantics", () => {
  it("replaces a single key and emits an `applied` breadcrumb", () => {
    const args = { limit: 25, channel: "C1" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ count: 25, channel: "C1" });
    expect(breadcrumbs).toEqual([{ kind: "applied", from: "limit", to: "count" }]);
    expect(formatKeyAliasBreadcrumb(breadcrumbs[0])).toBe("key_alias:limit→count");
  });

  it("replaces multiple keys in one call", () => {
    const args = {
      start_datetime: "2026-05-17T00:00:00Z",
      end_datetime: "2026-05-17T23:59:59Z",
      device_timezone: "America/New_York",
    };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("list_workspace_calendar_events", "Microsoft365Calendar-work")
    );
    expect(out).toEqual({
      startDateTime: "2026-05-17T00:00:00Z",
      endDateTime: "2026-05-17T23:59:59Z",
      deviceTimezone: "America/New_York",
    });
    expect(breadcrumbs).toHaveLength(3);
    expect(breadcrumbs.every((b) => b.kind === "applied")).toBe(true);
  });

  it("rewrites Google Workspace draft camelCase keys before validation", () => {
    const args = {
      to: ["debug-recipient@example.com"],
      subject: "REBEL-609 draft routing test",
      body: "This is a draft routing test.",
      isHtml: false,
      threadId: "thread-123",
      inReplyTo: "message-123",
    };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("create_workspace_draft", "GoogleWorkspace-alexs-mindstone-com")
    );
    expect(out).toEqual({
      to: ["debug-recipient@example.com"],
      subject: "REBEL-609 draft routing test",
      body: "This is a draft routing test.",
      is_html: false,
      thread_id: "thread-123",
      in_reply_to: "message-123",
    });
    expect(breadcrumbs).toEqual([
      { kind: "applied", from: "isHtml", to: "is_html" },
      { kind: "applied", from: "threadId", to: "thread_id" },
      { kind: "applied", from: "inReplyTo", to: "in_reply_to" },
    ]);
  });

  it("is a no-op when the agent already used the canonical key", () => {
    const args = { count: 25, channel: "C1" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ count: 25, channel: "C1" });
    expect(breadcrumbs).toEqual([]);
  });

  it("does not rewrite for a tool without a map entry", () => {
    const args = { limit: 25 };
    const { args: out, breadcrumbs } = normalizeArgKeys(args, ctx("list_slack_channels"));
    expect(out).toEqual({ limit: 25 });
    expect(breadcrumbs).toEqual([]);
  });

  it("passes through non-object args unchanged", () => {
    const { args: out, breadcrumbs } = normalizeArgKeys(
      "not-an-object",
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toBe("not-an-object");
    expect(breadcrumbs).toEqual([]);
  });

  it("passes through undefined args unchanged", () => {
    const { args: out, breadcrumbs } = normalizeArgKeys(
      undefined,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toBeUndefined();
    expect(breadcrumbs).toEqual([]);
  });
});

describe("normalizeArgKeys — target-wins collision", () => {
  it("drops the source key and emits a `skipped` breadcrumb when target exists", () => {
    const args = { limit: 25, count: 50, channel: "C1" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ count: 50, channel: "C1" });
    expect(breadcrumbs).toEqual([
      { kind: "skipped", from: "limit", to: "count", reason: "target_exists" },
    ]);
    expect(formatKeyAliasBreadcrumb(breadcrumbs[0])).toBe(
      "key_alias_skipped:limit→count:target_exists"
    );
  });

  it("treats empty-string target as absent and copies the source over it", () => {
    const args = { limit: 25, count: "", channel: "C1" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ count: 25, channel: "C1" });
    expect(breadcrumbs).toEqual([{ kind: "applied", from: "limit", to: "count" }]);
  });

  it("treats null target as absent and copies the source over it", () => {
    const args = { limit: 25, count: null, channel: "C1" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ count: 25, channel: "C1" });
    expect(breadcrumbs).toEqual([{ kind: "applied", from: "limit", to: "count" }]);
  });
});

describe("normalizeArgKeys — nested target (HubSpot)", () => {
  it("creates properties = {} and writes hs_note_body when properties is absent", () => {
    const args = { body: "hello world" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("create_hubspot_note", "HubSpot-x")
    );
    expect(out).toEqual({ properties: { hs_note_body: "hello world" } });
    expect(breadcrumbs).toEqual([
      { kind: "applied", from: "body", to: "properties.hs_note_body" },
    ]);
  });

  it("writes hs_note_body into existing properties when slot is empty", () => {
    const args = { body: "hi", properties: { hs_timestamp: 1234 } };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("create_hubspot_note", "HubSpot-x")
    );
    expect(out).toEqual({ properties: { hs_timestamp: 1234, hs_note_body: "hi" } });
    expect(breadcrumbs).toEqual([
      { kind: "applied", from: "body", to: "properties.hs_note_body" },
    ]);
  });

  it("target-wins when properties.hs_note_body is already non-empty", () => {
    const args = {
      body: "alias",
      properties: { hs_note_body: "explicit", hs_timestamp: 1234 },
    };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("create_hubspot_note", "HubSpot-x")
    );
    expect(out).toEqual({ properties: { hs_note_body: "explicit", hs_timestamp: 1234 } });
    expect(breadcrumbs).toEqual([
      { kind: "skipped", from: "body", to: "properties.hs_note_body", reason: "target_exists" },
    ]);
  });

  it("note_body also maps to properties.hs_note_body when body is absent", () => {
    const args = { note_body: "fallback" };
    const { args: out } = normalizeArgKeys(
      args,
      ctx("create_hubspot_note", "HubSpot-x")
    );
    expect(out).toEqual({ properties: { hs_note_body: "fallback" } });
  });

  it("skips rewrite when properties is a non-object scalar (validator surfaces error)", () => {
    const args = { body: "hi", properties: "should-be-object" };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("create_hubspot_note", "HubSpot-x")
    );
    expect(out).toEqual({ body: "hi", properties: "should-be-object" });
    expect(breadcrumbs).toEqual([]);
  });
});

describe("normalizeArgKeys — reserved-key exclusion", () => {
  it("never touches `_meta` at the top level", () => {
    const args = { _meta: { trace_id: "abc" }, limit: 25 };
    const { args: out, breadcrumbs } = normalizeArgKeys(
      args,
      ctx("search_slack_messages", "Slack-test")
    );
    expect(out).toEqual({ _meta: { trace_id: "abc" }, count: 25 });
    expect(breadcrumbs).toEqual([{ kind: "applied", from: "limit", to: "count" }]);
  });

  it("never touches `structuredContent` at the top level", () => {
    const args = {
      structuredContent: { items: [{ id: 1 }] },
      limit: 25,
    };
    const { args: out } = normalizeArgKeys(args, ctx("search_slack_messages", "Slack-test"));
    expect(out).toEqual({
      structuredContent: { items: [{ id: 1 }] },
      count: 25,
    });
  });
});
