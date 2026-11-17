import { getLogger } from "./logging.js";
import { ERROR_CODES, type ToolBlockedReason } from "./types.js";
import {
  CAPABILITY_BY_CATALOG_ID,
  LAUNCH_VARIANTS,
  RETIRED_COMMUNITY_IDENTITIES,
  type CommunityLaunchVariant,
  type CommunityToolCapability,
} from "./communityToolCapabilities.generated.js";

/**
 * Community connector tools stay off, whatever the user or admin config says, when their reviewed
 * class (resources/connector-catalog.json, generated into communityToolCapabilities.generated.ts)
 * says they run code or reach files on this computer, or when nobody has classified them. Code, not
 * config, so nothing can fail open. A class is a reviewed claim about third-party code, not a sandbox.
 */

const LOCAL_FS_REASON = "Turned off for safety: this tool can read or write files on this computer.";
const EXEC_REASON = "Turned off for safety: this tool can run code on this computer.";
const UNREVIEWED_REASON = "Turned off for safety: Rebel hasn't reviewed what this tool can do yet.";
const RETIRED_REASON = "Turned off for safety: this connector was removed from Rebel's catalog.";
const localFsArgumentReason = (arg: string) =>
  `Turned off for safety: saving to a file on this computer isn't allowed. Leave out \`${arg}\` and try again.`;

export interface SafetyIdentity {
  catalogId?: string;
  args?: string[];
}

export interface SafetyBlock {
  reason: string;
}

type CapabilityTable = Readonly<Record<string, CommunityToolCapability>>;

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * A package name anywhere in an argument, as a whole name: `@playwright/mcp@1`, `--package=@playwright/mcp`,
 * `x@npm:@playwright/mcp@1`, `node_modules/@playwright/mcp/cli.js`, `braze-mcp-server==1.2.0`. Deliberately
 * not a model of npm's or uv's argument grammar: matching too much only holds more tools to their
 * classification, matching too little leaves a connection unchecked.
 */
const mentions = (arg: string, name: string) =>
  new RegExp(`(?:^|[=:/\\s])${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:$|[@/\\s=[])`).test(arg);

const RETIRED = "retired";

/**
 * The capability tables a connection answers to: its own when its catalog id is a community one;
 * otherwise those of every community package its arguments launch, whatever other catalog id it carries.
 * Where entries share a package, the one its arguments pick out, or all of them when they pick out
 * none or several. `retired` when the connection is a community connector that has left the catalog:
 * its catalog id is a retired one, or its arguments pick out a retired launch variant and no single
 * current one (or only a current one with no distinguishing arguments, which matches any launch). An
 * entry in today's catalog otherwise wins, so an id that comes back answers to its table again.
 */
function candidateTables(pkg: SafetyIdentity | undefined): CapabilityTable[] | typeof RETIRED {
  const ownTable = pkg?.catalogId === undefined ? undefined : own(CAPABILITY_BY_CATALOG_ID, pkg.catalogId);
  if (ownTable !== undefined) return [ownTable];
  if (pkg?.catalogId !== undefined && RETIRED_COMMUNITY_IDENTITIES.catalogIds.includes(pkg.catalogId)) return RETIRED;
  const args = pkg?.args ?? [];
  const launched = (variantsByPackage: Readonly<Record<string, readonly CommunityLaunchVariant[]>>) =>
    Object.entries(variantsByPackage).filter(([name]) => args.some(arg => mentions(arg, name)));
  const picked = (variants: readonly CommunityLaunchVariant[]) =>
    variants.filter(variant => variant.distinguishingArgs.every(arg => args.includes(arg)));
  // A retired variant picked out by its own arguments outranks a current one that matches any launch
  // (a shared package's last entry has no distinguishing arguments). Example: `acme-mcp` once launched
  // `acme-a` (no extra args) and `acme-b` (`--flavour b`); `acme-b` left the catalog. A launch with
  // `--flavour b` picks retired `acme-b` and current `acme-a` (which matches anything), so it is retired.
  // A plain launch picks only `acme-a`. A launch that picks a retired variant and other than exactly one
  // current variant is retired too.
  const retired = launched(RETIRED_COMMUNITY_IDENTITIES.launchVariants).some(([name, variants]) => {
    const current = picked(own(LAUNCH_VARIANTS, name) ?? []);
    return picked(variants).some(gone =>
      current.length !== 1 || (gone.distinguishingArgs.length > 0 && current[0].distinguishingArgs.length === 0));
  });
  if (retired) return RETIRED;
  const ids = new Set(launched(LAUNCH_VARIANTS).flatMap(([, variants]) => {
    const chosen = picked(variants);
    return (chosen.length === 1 ? chosen : variants).map(variant => variant.catalogId);
  }));
  return [...ids].map(id => CAPABILITY_BY_CATALOG_ID[id]);
}

const isSupplied = (args: Record<string, unknown> | undefined, name: string) =>
  args !== undefined && own(args, name) !== undefined && args[name] !== null;

/**
 * Why Super-MCP refuses this call, or undefined when it allows it. Without `args` (listing, search,
 * details) an argument-scoped `local-fs` tool counts as allowed: only a call that supplies one of its
 * named arguments is refused. Any candidate's `exec` or whole-tool `local-fs` refuses; a tool no
 * candidate classifies is refused as unreviewed. Every tool of a community connector that has left the
 * catalog is refused. A connection that is no community connector is untouched.
 */
export function safetyBlock(pkg: SafetyIdentity | undefined, toolName: string, args?: Record<string, unknown>): SafetyBlock | undefined {
  const tables = candidateTables(pkg);
  if (tables === RETIRED) return { reason: RETIRED_REASON };
  if (tables.length === 0) return undefined;
  const classes = tables.map(table => own(table, toolName)).filter(entry => entry !== undefined);
  if (classes.some(entry => entry.capability === "exec")) return { reason: EXEC_REASON };
  if (classes.some(entry => entry.capability === "local-fs" && entry.localFsArguments === undefined)) return { reason: LOCAL_FS_REASON };
  const supplied = classes
    .flatMap(entry => entry.capability === "local-fs" ? entry.localFsArguments ?? [] : [])
    .find(name => isSupplied(args, name));
  if (supplied !== undefined) return { reason: localFsArgumentReason(supplied) };
  return classes.length > 0 ? undefined : { reason: UNREVIEWED_REASON };
}

export const safetyBlockMessage = (package_id: string, tool_id: string, block: SafetyBlock) =>
  `Tool '${package_id}__${tool_id}': ${block.reason}`;

/** Refuse a tool Super-MCP keeps off; used on admission and as the dispatch backstop. */
export function assertNotSafetyDisabled(pkg: SafetyIdentity | undefined, package_id: string, tool_id: string, args?: Record<string, unknown>): void {
  const block = safetyBlock(pkg, tool_id, args);
  if (block === undefined) return;
  getLogger().warn("Blocked attempt to use safety-disabled tool", { package_id, tool_id, catalog_id: pkg?.catalogId, blocked_reason: block.reason });
  throw {
    code: ERROR_CODES.TOOL_BLOCKED,
    message: safetyBlockMessage(package_id, tool_id, block),
    data: { package_id, tool_id, blocked_reason: block.reason, reason: "security-policy" satisfies ToolBlockedReason },
  };
}
