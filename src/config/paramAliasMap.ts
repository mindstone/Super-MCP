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

/** Per-tool entries, keyed by exact tool id (no package qualifier). */
const TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // Slack message tools accept `count`, agents pass `limit`.
  search_slack_messages: [{ from: "limit", to: "count" }],
  get_slack_channel_history: [{ from: "limit", to: "count" }],
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
  // HubSpot create_hubspot_note nested-target case.
  create_hubspot_note: [
    { from: "body", to: "properties.hs_note_body" },
    { from: "note_body", to: "properties.hs_note_body" },
  ],
};

/**
 * Returns the alias entries for a tool. Empty array when nothing is registered.
 *
 * The package id is accepted (and ignored today) so callers can pass the
 * full identifier without inspecting it; future entries that need to scope
 * by package (e.g. only `microsoft-calendar` flavour of the calendar tools)
 * can do so without rewriting call sites.
 */
export function getAliasesForTool(
  _packageId: string,
  toolId: string,
): ToolAliasMap {
  return TOOL_ALIASES[toolId] ?? [];
}

/** Reserved top-level keys that the normaliser must never rewrite. */
export const RESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "_meta",
  "structuredContent",
]);
