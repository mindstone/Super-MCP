import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../logging.js";
import type { PackageConfig } from "../types.js";
import { createResponseNormalizingFetch } from "../clients/httpClient.js";
import {
  SimpleOAuthProvider,
  RENEWAL_HELD_FIELD,
  OBTAINED_AT_FIELD,
  isRenewalHeld,
  withHostRefreshScope,
} from "./providers/simple.js";
import { RefreshOnlyOAuthProvider } from "./providers/refreshOnly.js";
import { remainingLifetimeMs } from "./refreshTransaction.js";
import { TokenRefreshLockBusyError, withTokenRefreshLock } from "./tokenRefreshLock.js";

/**
 * Host operations on a package's OAuth files, for a host (Rebel) that keeps one
 * owner per refresh token across machines: POST /api/oauth/host and the
 * SUPER_MCP_HOLD_RENEWAL startup hold. Every change runs under the package's
 * withTokenRefreshLock, so it serializes with refreshes in this process and its
 * peers. Nothing here runs unless a host asks. Design and the status table:
 * the app repo's docs/plans/261022_fox-5673-connector-token-owner/PLAN.md.
 */

const logger = getLogger();

const PackageId = z
  .string()
  .min(1)
  .max(200)
  .refine((id) => !/[\\/\0]/.test(id) && !id.startsWith("."), "invalid package id");

/**
 * The borrowed-access shape: what `refresh` returns and `cache` accepts. No
 * `expires_in` means the token states no expiry.
 */
const AccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  scope: z.string().optional(),
  expires_in: z.number().int().nonnegative().optional(),
});
export type BorrowedAccess = z.infer<typeof AccessSchema>;

const HostOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("hold"), package_id: PackageId }),
  z.object({ op: z.literal("resume"), package_id: PackageId }),
  z.object({ op: z.literal("export"), package_id: PackageId, discard: z.boolean() }),
  z.object({ op: z.literal("cache"), package_id: PackageId, access: AccessSchema }),
  z.object({
    op: z.literal("install"),
    package_id: PackageId,
    tokens: z.looseObject({ access_token: z.string().min(1), token_type: z.string().min(1) }),
    client: z.looseObject({}).nullable().optional(),
  }),
  z.object({ op: z.literal("remove"), package_id: PackageId }),
  z.object({ op: z.literal("refresh"), package_id: PackageId, min_remaining_ms: z.number().nonnegative() }),
]);

export type HostOp = z.infer<typeof HostOpSchema>;
export type HostOpResult = { status: string; [key: string]: unknown };

export interface HostOpsDeps {
  getPackage(packageId: string): PackageConfig | undefined;
  /** Restart a configured package after its credentials were installed or removed. */
  onCredentialsChanged?(packageId: string): Promise<void>;
  /** Token-endpoint fetch for `refresh` (tests). Defaults to global fetch. */
  baseFetch?: typeof fetch;
}

const MISSING: HostOpResult = { status: "missing" };

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

/** Parsed JSON, or undefined when absent or the lock's empty placeholder. */
async function readJsonFile(filePath: string): Promise<any | undefined> {
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  });
  return raw.trim() ? JSON.parse(raw) : undefined;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  });
}

function withoutField(tokens: any, field: string): any {
  const { [field]: _omit, ...rest } = tokens;
  return rest;
}

/** Access-only, held: the refresh token now lives with the owner. */
function accessOnlyHeld(tokens: any): any {
  return { ...withoutField(tokens, "refresh_token"), [RENEWAL_HELD_FIELD]: true };
}

export async function runHostOp(op: HostOp, deps: HostOpsDeps): Promise<HostOpResult> {
  // Plan item S3-3 (round-3 amendment): `refresh` takes no outer lock. The lock
  // is not reentrant and runRefreshTransaction owns it, so an outer lock would
  // wait on itself.
  if (op.op === "refresh") {
    return refreshOp(op, deps);
  }
  const provider = new SimpleOAuthProvider(op.package_id);
  const tokenPath = provider.getTokenFilePath();
  // Avoid leaving the lock's placeholder behind for a package with no file.
  if ((op.op === "hold" || op.op === "resume" || op.op === "export") && !(await exists(tokenPath))) {
    return MISSING;
  }
  const result = await withTokenRefreshLock(op.package_id, tokenPath, async (): Promise<HostOpResult> => {
    const disk = await readJsonFile(tokenPath);
    switch (op.op) {
      case "hold":
        if (!disk) return MISSING;
        if (!isRenewalHeld(disk)) await provider.atomicWriteTokens({ ...disk, [RENEWAL_HELD_FIELD]: true });
        return { status: "held" };
      case "resume":
        if (!disk) return MISSING;
        // A cache without its refresh token can't renew here; it stays held.
        if (typeof disk.refresh_token !== "string") return { status: "no_refresh_token" };
        await provider.atomicWriteTokens(withoutField(disk, RENEWAL_HELD_FIELD));
        return { status: "resumed" };
      case "export":
        return exportUnderLock(provider, disk, op.discard);
      case "cache":
        // Never silently drop a refresh token: the host exports or discards first.
        if (typeof disk?.refresh_token === "string") return { status: "refused", reason: "holds_refresh_token" };
        await provider.atomicWriteTokens({ ...op.access, [OBTAINED_AT_FIELD]: Date.now(), [RENEWAL_HELD_FIELD]: true });
        await provider.clearNeedsReconnectMarker();
        return { status: "cached" };
      case "install":
        // Client first, so tokens never sit beside a mismatched registration.
        if (op.client) await provider.atomicWriteTokens(op.client, provider.getClientFilePath());
        await provider.atomicWriteTokens(withoutField(op.tokens, RENEWAL_HELD_FIELD));
        await provider.clearNeedsReconnectMarker();
        return { status: "installed" };
      case "remove":
        await unlinkIfPresent(tokenPath);
        await unlinkIfPresent(provider.getClientFilePath());
        await unlinkIfPresent(provider.getNeedsReconnectMarkerPath());
        return { status: "removed" };
    }
  });
  if (result.status === "installed" || result.status === "removed") {
    await deps.onCredentialsChanged?.(op.package_id);
  }
  return result;
}

async function exportUnderLock(provider: SimpleOAuthProvider, disk: any, discard: boolean): Promise<HostOpResult> {
  if (!disk) return MISSING;
  if (discard) {
    await provider.atomicWriteTokens(accessOnlyHeld(disk));
    return { status: "discarded" };
  }
  const exportDir = process.env.SUPER_MCP_EXPORT_DIR;
  if (!exportDir) return { status: "unsupported", reason: "no_export_dir" };
  const pendingPath = path.join(exportDir, `${provider.getPackageId()}.json`);
  if (typeof disk.refresh_token !== "string") {
    // A repeat after a completed export is idempotent.
    return (await exists(pendingPath)) ? { status: "exported", repeat: true } : { status: "no_refresh_token" };
  }
  // Plan item S3-3e: held first, then the pending bundle durable, then the
  // strip. A crash at any point leaves the file held (unspendable here) and,
  // after the second step, the pending bundle present for a repeat.
  if (!isRenewalHeld(disk)) await provider.atomicWriteTokens({ ...disk, [RENEWAL_HELD_FIELD]: true });
  const client = (await readJsonFile(provider.getClientFilePath())) ?? null;
  const bundle = { version: 1, package_id: provider.getPackageId(), tokens: withoutField(disk, RENEWAL_HELD_FIELD), client };
  await provider.atomicWriteTokens(bundle, pendingPath);
  await provider.atomicWriteTokens(accessOnlyHeld(disk));
  return { status: "exported" };
}

/**
 * The owner's credential answer for one package: super-mcp interprets its own
 * token file, so the host never does. Renews (through the package's own fetch
 * wrapper and refresh transaction, without connecting the MCP server, never
 * registry.getClient()) only when less than `min_remaining_ms` is left, or to
 * verify a reconnect marker that sits beside a refresh token; otherwise it
 * answers from disk. Returns access only, never the refresh token or client.
 */
async function refreshOp(
  op: Extract<HostOp, { op: "refresh" }>,
  deps: HostOpsDeps,
): Promise<HostOpResult> {
  const probe = new SimpleOAuthProvider(op.package_id);
  const before = await readJsonFile(probe.getTokenFilePath()).catch(() => undefined);
  const marked = (await SimpleOAuthProvider.readNeedsReconnectMarkerState(op.package_id)).state !== "absent";
  if (!before?.access_token) {
    // After the owner's dead-grant verdict the file is gone and the marker stays.
    return { status: marked ? "needs_reconnect" : "missing" };
  }
  const hasRefreshToken = typeof before.refresh_token === "string";
  const verifyMarker = marked && hasRefreshToken;
  // A short-lived token is renewed below a third of its lifetime, not on every
  // borrow: only super-mcp knows the lifetime (`expires_in` at obtain time).
  const minRemainingMs =
    typeof before.expires_in === "number"
      ? Math.min(op.min_remaining_ms, (before.expires_in * 1000) / 3)
      : op.min_remaining_ms;
  if (!verifyMarker && remainingMs(before) >= minRemainingMs) {
    return marked ? { status: "needs_reconnect" } : accessResult(before);
  }
  if (!hasRefreshToken) {
    // Nothing to renew with: what is left is still usable until it expires.
    return remainingMs(before) > 0 && !marked ? accessResult(before) : { status: "needs_reconnect" };
  }
  const config = deps.getPackage(op.package_id);
  if (!config || config.transport !== "http" || !config.oauth || !config.base_url) {
    return { status: "setup_required" };
  }
  const port = (await SimpleOAuthProvider.getSavedClientPort(op.package_id)) ?? 5173;
  const staticCredentials = config.oauthClientId
    ? { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret }
    : undefined;
  const provider = new SimpleOAuthProvider(op.package_id, port, staticCredentials);
  await provider.initialize();
  // Without a registration the SDK would register a new client; never do that here.
  if (!(await provider.clientInformation())) {
    return { status: "needs_reconnect" };
  }

  // The SDK swallows a failed refresh POST and falls through to its redirect,
  // so whether the provider was reachable is observed here, not from the error.
  let unreachable = false;
  const baseFetch = deps.baseFetch ?? fetch;
  const trackedFetch: typeof fetch = async (input, init) => {
    try {
      return await baseFetch(input, init);
    } catch (error) {
      unreachable = true;
      throw error;
    }
  };
  const fetchFn = createResponseNormalizingFetch(trackedFetch, (error) => provider.setLastOAuthError(error), provider);
  // Marker verification must reach the provider: no short-circuit on a valid
  // access token. A successful refresh clears the marker.
  const threshold = verifyMarker ? Number.POSITIVE_INFINITY : minRemainingMs;
  try {
    await withHostRefreshScope(threshold, () =>
      auth(new RefreshOnlyOAuthProvider(provider), { serverUrl: config.base_url!, fetchFn }),
    );
  } catch (error) {
    // The owner's dead-grant verdict removes the refresh token; anything that
    // leaves it in place (network, 5xx, a busy lock) is transient.
    const after = await readJsonFile(probe.getTokenFilePath()).catch(() => before);
    if (typeof after?.refresh_token !== "string") {
      return { status: "needs_reconnect" };
    }
    const reason = unreachable ? "provider_unreachable" : "provider_error";
    logger.warn("Host refresh did not renew", {
      package_id: op.package_id,
      reason,
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "unavailable", reason };
  }
  const after = await readJsonFile(probe.getTokenFilePath()).catch(() => undefined);
  return after?.access_token ? accessResult(after) : { status: "unavailable", reason: "provider_error" };
}

/**
 * Remaining access lifetime on disk. No `expires_in`: never expires. An
 * `expires_in` without our obtained-at stamp is of unknown age, so 0 (renew).
 */
function remainingMs(tokens: any): number {
  if (typeof tokens?.expires_in !== "number") return Number.POSITIVE_INFINITY;
  return remainingLifetimeMs(tokens) ?? 0;
}

/** Access-only projection: never the refresh token, client or private fields. */
function accessResult(tokens: any): HostOpResult {
  const remaining = remainingMs(tokens);
  const access: BorrowedAccess = {
    access_token: tokens.access_token,
    token_type: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
    ...(typeof tokens.scope === "string" ? { scope: tokens.scope } : {}),
    ...(Number.isFinite(remaining) ? { expires_in: Math.max(0, Math.floor(remaining / 1000)) } : {}),
  };
  return { status: "fresh", access };
}

/** Parse, run and map one POST /api/oauth/host body. Logs only op, package and status. */
export async function handleHostOpRequest(
  body: unknown,
  deps: HostOpsDeps,
): Promise<{ httpStatus: number; body: HostOpResult }> {
  const parsed = HostOpSchema.safeParse(body);
  if (!parsed.success) {
    return { httpStatus: 400, body: { status: "error", code: "invalid_request" } };
  }
  const op = parsed.data;
  try {
    const result = await runHostOp(op, deps);
    logger.info("Host OAuth op", { op: op.op, package_id: op.package_id, status: result.status });
    return { httpStatus: 200, body: result };
  } catch (error) {
    const busy = error instanceof TokenRefreshLockBusyError;
    logger.error("Host OAuth op failed", {
      op: op.op,
      package_id: op.package_id,
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return busy
      ? { httpStatus: 503, body: { status: "busy" } }
      : { httpStatus: 500, body: { status: "error", code: "internal" } };
  }
}

/**
 * SUPER_MCP_HOLD_RENEWAL: comma list of package ids to hold before discovery
 * starts, so a refresh token the host is handing to its owner is never spent
 * here first. Absent (standalone use) means nothing happens.
 */
export async function applyStartupRenewalHold(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ids = (env.SUPER_MCP_HOLD_RENEWAL ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  for (const [index, id] of ids.entries()) {
    const parsed = PackageId.safeParse(id);
    if (!parsed.success) {
      // Hosts derive ids from token file names, so this is a host bug; hold the rest.
      logger.warn("Startup renewal hold skipped an unusable package id", { entry_index: index });
      continue;
    }
    // Plan item S3-2: a valid hold that can't be applied fails startup rather
    // than letting discovery spend the token (absent files have nothing to hold).
    await runHostOp({ op: "hold", package_id: parsed.data }, { getPackage: () => undefined });
  }
}
