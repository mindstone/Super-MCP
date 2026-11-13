import { getLogger } from "./logging.js";
import { ERROR_CODES, type ToolBlockedReason } from "./types.js";

/**
 * Catalog connector tools that stay off whatever the user or admin config says: each reads local
 * files or runs code on this computer for the model. Code, not config, so nothing can fail open.
 */
const SAFETY_DISABLED_TOOLS_BY_CATALOG_ID: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["pipedrive", new Set(["files_upload", "deals_attach_file"])],
  // 0.0.84 renames browser_run_code; both names are listed so a pin bump stays blocked.
  ["playwright", new Set(["browser_run_code", "browser_run_code_unsafe"])],
]);

/** The same connectors added by hand or imported, with no catalog id: matched by exact npm package name. */
const CATALOG_ID_BY_NPM_PACKAGE: ReadonlyMap<string, string> = new Map([
  ["@iamsamuelfraga/mcp-pipedrive", "pipedrive"],
  ["@playwright/mcp", "playwright"],
]);

export const SAFETY_DISABLED_REASON = "Turned off for safety: it can read files or run code on this computer";

export interface SafetyIdentity {
  catalogId?: string;
  args?: string[];
}

/**
 * A package name anywhere in an argument, as a whole name: `@playwright/mcp@1`, `--package=@playwright/mcp`,
 * `x@npm:@playwright/mcp@1`, `node_modules/@playwright/mcp/cli.js`. Deliberately not a model of npm's
 * argument grammar: matching too much only turns these few tool names off, matching too little leaves them on.
 */
const mentions = (arg: string, name: string) =>
  new RegExp(`(?:^|[=:/\\s])${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:$|[@/\\s])`).test(arg);

function safetyCatalogIds(pkg: SafetyIdentity | undefined): string[] {
  if (pkg?.catalogId !== undefined) return [pkg.catalogId];
  return [...CATALOG_ID_BY_NPM_PACKAGE].filter(([name]) => (pkg?.args ?? []).some(arg => mentions(arg, name))).map(([, id]) => id);
}

export function isSafetyDisabled(pkg: SafetyIdentity | undefined, toolName: string): boolean {
  return safetyCatalogIds(pkg).some(id => SAFETY_DISABLED_TOOLS_BY_CATALOG_ID.get(id)?.has(toolName) ?? false);
}

/** Refuse a tool Super-MCP always keeps off; used on admission and as the dispatch backstop. */
export function assertNotSafetyDisabled(pkg: SafetyIdentity | undefined, package_id: string, tool_id: string): void {
  if (!isSafetyDisabled(pkg, tool_id)) return;
  getLogger().warn("Blocked attempt to use safety-disabled tool", { package_id, tool_id, catalog_id: pkg?.catalogId });
  throw {
    code: ERROR_CODES.TOOL_BLOCKED,
    message: `Tool '${package_id}__${tool_id}' is turned off for safety: it can read files or run code on this computer.`,
    data: { package_id, tool_id, blocked_reason: SAFETY_DISABLED_REASON, reason: "security-policy" satisfies ToolBlockedReason },
  };
}
