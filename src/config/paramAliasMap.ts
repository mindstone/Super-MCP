/**
 * Per-tool parameter-key alias map (Sprint 2 — item R3).
 *
 * The map rewrites the agent's mistaken top-level key (source) into the
 * canonical key the downstream tool's schema actually accepts (target).
 *
 * ── Stage 0 split (2026-06-16) — irreducible entries only ───────────────────
 * The generic, schema-driven `canonicalKeyNormalize` (see
 * `super-mcp/src/utils/normalizeInput.ts`, wired in `useTool.ts`'s
 * validate-before-send auto-repair) now reproduces ALL the pure
 * casing/separator entries this map used to carry (camelCase↔snake_case bleed:
 * Microsoft Graph `startDateTime`/`deviceTimezone`, the Google Workspace Gmail
 * + Calendar camelCase→snake_case sets, etc.). Those entries were REMOVED — the
 * normalizer maps the key to whichever schema property shares its canonical
 * form, so there is nothing for a hand-maintained casing table to add, and the
 * table was the drift hazard that manufactured the `limit→count` /
 * `device_timezone` failures in the first place.
 *
 * What CANNOT be derived from the schema shape, and so REMAINS here:
 *   • True synonyms — a different word, not a re-casing. Slack
 *     `search_slack_messages` is canonical on `count`; agents say `limit`.
 *     `canonical("limit") !== canonical("count")`, so the normalizer would
 *     never connect them. (Verified: `get_slack_channel_history` is canonical
 *     on `limit` and has NO `count` — which is exactly why this synonym must
 *     stay tool-scoped, not global; see the note below.)
 *   • Nested-target renames — HubSpot `create_hubspot_note` takes the body as
 *     `properties.hs_note_body`; agents pass top-level `body`/`note_body`. The
 *     normalizer only matches top-level schema properties and cannot synthesise
 *     a nested path, so these stay.
 *
 * Direction was verified against current connector schemas:
 *   • Slack message tools accept `count` — agents often try `limit` instead
 *     (resources/mcp/slack/src/definitions.ts).
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

const HUBSPOT_TOOL_ALIASES: Readonly<Record<string, ToolAliasMap>> = {
  // HubSpot create_hubspot_note nested-target case — `canonicalKeyNormalize`
  // cannot synthesise the nested `properties.hs_note_body` path, so this stays.
  create_hubspot_note: [
    { from: "body", to: "properties.hs_note_body" },
    { from: "note_body", to: "properties.hs_note_body" },
  ],
};

// NOTE (Stage 0, 2026-06-16): the Microsoft Graph and Google Workspace alias
// maps were REMOVED. Every entry they held was a pure camelCase↔snake_case
// re-casing (e.g. `startDateTime`↔`start_datetime`, `maxResults`↔`max_results`,
// `eventId`↔`event_id`) which `canonicalKeyNormalize` now reproduces by mapping
// each unknown key to the unique schema property sharing its canonical form.
// The REBEL-13Y casing failures these maps targeted are covered there, without
// the per-tool drift risk. True synonyms / nested renames (Slack `limit→count`,
// HubSpot `body→properties.hs_note_body`) remain above because no schema-shape
// match can derive them.

function isPackageFamily(packageId: string, family: string): boolean {
  const normalizedPackageId = packageId.trim().toLowerCase();
  const normalizedFamily = family.toLowerCase();
  return (
    normalizedPackageId === normalizedFamily ||
    normalizedPackageId.startsWith(`${normalizedFamily}-`)
  );
}

/**
 * Returns the alias entries for a tool. Empty array when nothing is registered.
 *
 * After the Stage 0 split only true synonyms (Slack) and nested-target renames
 * (HubSpot) remain — the casing-only Microsoft/Google maps are handled by the
 * schema-driven `canonicalKeyNormalize` auto-repair, not here.
 */
export function getAliasesForTool(
  packageId: string,
  toolId: string,
): ToolAliasMap {
  if (isPackageFamily(packageId, "Slack")) return SLACK_TOOL_ALIASES[toolId] ?? [];
  if (isPackageFamily(packageId, "HubSpot")) return HUBSPOT_TOOL_ALIASES[toolId] ?? [];
  return [];
}

/** Reserved top-level keys that the normaliser must never rewrite. */
export const RESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "_meta",
  "structuredContent",
]);
