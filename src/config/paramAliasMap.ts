/**
 * Per-tool parameter-key alias map (Sprint 2 — item R3).
 *
 * The map rewrites the agent's mistaken top-level key (source) into the
 * canonical key the downstream tool's schema actually accepts (target).
 *
 * Direction was verified against current connector schemas before each entry
 * was added:
 *   • Slack message tools accept `count` — agents often try `limit` instead
 *     (resources/mcp/slack/src/definitions.ts).
 *   • Microsoft Graph endpoints accept camelCase (startDateTime, endDateTime,
 *     deviceTimezone) — agents bleed snake_case across from Google / Slack
 *     (resources/mcp/microsoft-calendar/src/index.ts).
 *   • HubSpot create_hubspot_note accepts the body as a nested
 *     `properties.hs_note_body` string. Stage C added a connector-side mirror
 *     for `body` / `note_body`; the R3 entry is the router-side belt-and-
 *     braces. When the connector telemetry confirms R3 is firing reliably,
 *     the connector mirror in resources/mcp/hubspot/src/tools/crm-handlers.ts
 *     can go.
 *   • Google Workspace Gmail tools accept snake_case after the MCP naming
 *     standardisation; agents still regularly emit the old camelCase names
 *     from stale prompt memory and earlier connector examples.
 *   • Google Workspace Calendar tools also accept snake_case; models bleed
 *     camelCase across from Microsoft Graph naming habits (REBEL-13Y),
 *     producing MCP -33003 validation failures. Targets are verified against
 *     mcp-servers/connectors/google-workspace/src/tools/definitions/calendar.ts.
 *
 * Semantics:
 *   • Source matches by exact key on the top level of `args` only.
 *     No deep recursion (avoids accidentally rewriting `_meta` or
 *     `structuredContent` payload keys).
 *   • Replace — not duplicate. The source key is removed from `args` and the
 *     target key is set. When the target is dotted (e.g.
 *     `properties.hs_note_body`), the leading object is created on demand.
 *   • Collision rule: target wins. If the target is already present
 *     (top-level OR nested for dotted targets) and non-empty, the source key
 *     is silently dropped and a `key_alias_skipped:<from>→<to>:target_exists`
 *     breadcrumb is emitted.
 */

export type AliasEntry = {
  /** The agent's mistaken key (matched at the top level of `args`). */
  from: string;
  /**
   * The canonical schema key. Dotted form (e.g. `properties.hs_note_body`) is
   * supported for HubSpot's nested-target case. Single-segment targets only
   * write at the top level.
   */
  to: string;
};

export type ToolAliasMap = ReadonlyArray<AliasEntry>;

/** Per-tool entries, keyed by exact tool id, scoped by package family. */
const SLACK_TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // `search_slack_messages` is canonical on `count` (connectors/slack messages.ts),
  // so an agent's `limit` must be aliased to `count`.
  search_slack_messages: [{ from: "limit", to: "count" }],
  // NOTE: `get_slack_channel_history` is canonical on `limit`
  // (connectors/slack channels.ts) — it has NO `count` field. A `limit→count`
  // alias here rewrote a correct `limit` into an invalid `count`, which the
  // connector rejected (use_tool -33003 "unknown field: count"), driving weak
  // models into a non-convergent retry loop (observed burning whole turns on
  // local DeepSeek-V4-Flash). Removed 2026-06-08; see
  // docs/plans/260608_minimax-ds4-mcp-toolcall-eval/PLAN.md (P1) and
  // docs/plans/260608_ds4-local-call-improvements/FINDINGS.md.
};

const MICROSOFT_TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // Microsoft Graph wants camelCase; snake_case bleeds in from Google/Slack.
  search_workspace_calendar_events: [
    { from: "start_datetime", to: "startDateTime" },
    { from: "end_datetime", to: "endDateTime" },
    { from: "device_timezone", to: "deviceTimezone" },
  ],
  list_workspace_calendar_events: [
    { from: "start_datetime", to: "startDateTime" },
    { from: "end_datetime", to: "endDateTime" },
    { from: "device_timezone", to: "deviceTimezone" },
  ],
  create_workspace_calendar_event: [
    { from: "start_datetime", to: "startDateTime" },
    { from: "end_datetime", to: "endDateTime" },
    { from: "device_timezone", to: "deviceTimezone" },
  ],
  update_workspace_calendar_event: [
    { from: "start_datetime", to: "startDateTime" },
    { from: "end_datetime", to: "endDateTime" },
    { from: "device_timezone", to: "deviceTimezone" },
  ],
};

const HUBSPOT_TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // HubSpot create_hubspot_note nested-target case.
  create_hubspot_note: [
    { from: "body", to: "properties.hs_note_body" },
    { from: "note_body", to: "properties.hs_note_body" },
  ],
};

const GOOGLE_WORKSPACE_TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // Google Workspace Gmail/draft tools accept snake_case; agents still pass
  // the pre-standardisation camelCase parameter names.
  search_workspace_emails: [
    { from: "hasAttachment", to: "has_attachment" },
    { from: "isUnread", to: "is_unread" },
    { from: "pageToken", to: "page_token" },
    { from: "includeBody", to: "include_body" },
    { from: "returnJson", to: "return_json" },
    { from: "maxResults", to: "max_results" },
  ],
  get_workspace_email_thread: [
    { from: "threadId", to: "thread_id" },
    { from: "maxMessages", to: "max_messages" },
    { from: "includeBody", to: "include_body" },
    { from: "returnJson", to: "return_json" },
  ],
  send_workspace_email: [
    { from: "isHtml", to: "is_html" },
    { from: "replyToMessageId", to: "reply_to_message_id" },
  ],
  get_workspace_draft: [{ from: "draftId", to: "draft_id" }],
  create_workspace_draft: [
    { from: "isHtml", to: "is_html" },
    { from: "replyToMessageId", to: "reply_to_message_id" },
    { from: "threadId", to: "thread_id" },
    { from: "inReplyTo", to: "in_reply_to" },
  ],
  update_workspace_draft: [
    { from: "draftId", to: "draft_id" },
    { from: "isHtml", to: "is_html" },
    { from: "replyToMessageId", to: "reply_to_message_id" },
    { from: "threadId", to: "thread_id" },
    { from: "inReplyTo", to: "in_reply_to" },
  ],
  delete_workspace_draft: [{ from: "draftId", to: "draft_id" }],
  send_workspace_draft: [{ from: "draftId", to: "draft_id" }],
  archive_workspace_email: [
    { from: "messageId", to: "message_id" },
    { from: "messageIds", to: "message_ids" },
  ],
  trash_workspace_email: [
    { from: "messageId", to: "message_id" },
    { from: "messageIds", to: "message_ids" },
  ],
  untrash_workspace_email: [
    { from: "messageId", to: "message_id" },
    { from: "messageIds", to: "message_ids" },
  ],
  mark_workspace_email_read: [
    { from: "messageId", to: "message_id" },
    { from: "messageIds", to: "message_ids" },
  ],
  mark_workspace_email_unread: [
    { from: "messageId", to: "message_id" },
    { from: "messageIds", to: "message_ids" },
  ],
  manage_workspace_draft: [{ from: "draftId", to: "draft_id" }],
  manage_workspace_attachment: [{ from: "messageId", to: "message_id" }],
  download_workspace_attachment: [{ from: "messageId", to: "message_id" }],
  upload_workspace_attachment: [
    { from: "messageId", to: "message_id" },
    { from: "mimeType", to: "mime_type" },
  ],
  delete_workspace_attachment: [{ from: "messageId", to: "message_id" }],
  // Google Workspace Calendar tools accept snake_case (canonical schema), but
  // models routinely emit camelCase — typically bleeding across from Microsoft
  // Graph naming habits — and previously also from a calendar-sync prompt that
  // explicitly instructed `returnJson`/`deviceTimezone` for Google. The result
  // was MCP -33003 validation failures (umbrella Sentry issue REBEL-13Y).
  // Every alias target is verified against the connector schema in
  // mcp-servers/connectors/google-workspace/src/tools/definitions/calendar.ts.
  list_workspace_calendar_events: [
    { from: "calendarId", to: "calendar_id" },
    { from: "maxResults", to: "max_results" },
    { from: "timeMin", to: "time_min" },
    { from: "timeMax", to: "time_max" },
    { from: "returnJson", to: "return_json" },
    { from: "deviceTimezone", to: "device_timezone" },
  ],
  find_free_slots: [
    { from: "timeMin", to: "time_min" },
    { from: "timeMax", to: "time_max" },
    { from: "minSlotDurationMinutes", to: "min_slot_duration_minutes" },
  ],
  get_workspace_calendar_event: [
    { from: "eventId", to: "event_id" },
    { from: "calendarId", to: "calendar_id" },
  ],
  create_workspace_calendar_event: [
    { from: "calendarId", to: "calendar_id" },
    { from: "colorId", to: "color_id" },
  ],
  manage_workspace_calendar_event: [
    { from: "eventId", to: "event_id" },
    { from: "newTimes", to: "new_times" },
    { from: "colorId", to: "color_id" },
  ],
  respond_to_workspace_calendar_event: [
    { from: "eventId", to: "event_id" },
    { from: "calendarId", to: "calendar_id" },
  ],
  delete_workspace_calendar_event: [
    { from: "eventId", to: "event_id" },
    { from: "sendUpdates", to: "send_updates" },
    { from: "deletionScope", to: "deletion_scope" },
  ],
};

function isPackageFamily(packageId: string, family: string): boolean {
  const normalizedPackageId = packageId.trim().toLowerCase();
  const normalizedFamily = family.toLowerCase();
  return (
    normalizedPackageId === normalizedFamily ||
    normalizedPackageId.startsWith(`${normalizedFamily}-`)
  );
}

function isMicrosoftPackage(packageId: string): boolean {
  return packageId.trim().toLowerCase().startsWith("microsoft");
}

/**
 * Returns the alias entries for a tool. Empty array when nothing is registered.
 *
 * Aliases are scoped by package family because generic tool ids like
 * `list_workspace_calendar_events` can exist across providers with opposite
 * canonical casing.
 */
export function getAliasesForTool(
  packageId: string,
  toolId: string,
): ToolAliasMap {
  if (isPackageFamily(packageId, "Slack")) return SLACK_TOOL_ALIASES[toolId] ?? [];
  if (isPackageFamily(packageId, "HubSpot")) return HUBSPOT_TOOL_ALIASES[toolId] ?? [];
  if (isPackageFamily(packageId, "GoogleWorkspace")) {
    return GOOGLE_WORKSPACE_TOOL_ALIASES[toolId] ?? [];
  }
  if (isMicrosoftPackage(packageId)) return MICROSOFT_TOOL_ALIASES[toolId] ?? [];
  return [];
}

/** Reserved top-level keys that the normaliser must never rewrite. */
export const RESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "_meta",
  "structuredContent",
]);
