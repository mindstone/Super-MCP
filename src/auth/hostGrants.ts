import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  discoverOAuthServerInfo,
  selectClientAuthMethod,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../logging.js";
import type { PackageConfig } from "../types.js";
import {
  SimpleOAuthProvider,
  getStaticCredentials,
  listOAuthTokenPackages,
  OBTAINED_AT_FIELD,
  RENEWAL_HELD_FIELD,
  isRenewalHeld,
} from "./providers/simple.js";
import { withTokenRefreshLock } from "./tokenRefreshLock.js";

const logger = getLogger();

export function hostMode(): boolean {
  return !!(process.env.SUPER_MCP_HOST_GRANTS_DIR && process.env.MCP_HOST_BRIDGE_STATE);
}

export function accessTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Match the SDK's discovery, client authentication selection and resource rules. */
export async function buildRenewalSpec(provider: SimpleOAuthProvider, fetchFn: typeof fetch = fetch) {
  const config = provider.getHostGrantConfig();
  if (!config?.base_url) throw new Error("OAuth configuration unavailable");
  const port = (await SimpleOAuthProvider.getSavedClientPort(config.id)) ?? 5173;
  const registered = new SimpleOAuthProvider(config.id, port, getStaticCredentials(config));
  await registered.initialize();
  const client = await registered.clientInformation();
  if (!client?.client_id) return undefined;
  const info = await discoverOAuthServerInfo(config.base_url, {
    fetchFn: (input, init) => fetchFn(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  const metadata = info.authorizationServerMetadata;
  const resource = await selectResourceURL(config.base_url, registered, info.resourceMetadata);
  return {
    token_endpoint: metadata?.token_endpoint ?? new URL("/token", info.authorizationServerUrl).href,
    client: {
      id: client.client_id as string,
      ...(client.client_secret ? { secret: client.client_secret as string } : {}),
    },
    auth: selectClientAuthMethod(client, metadata?.token_endpoint_auth_methods_supported ?? []),
    ...(resource ? { params: { resource: resource.href } } : {}),
  };
}

export async function markHostReconnect(provider: SimpleOAuthProvider): Promise<void> {
  await provider.atomicWriteTokens({ needs_reconnect: true }, provider.getNeedsReconnectMarkerPath());
}

const TokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().min(1),
  obtained_at: z.number().finite(),
  expires_at: z.number().finite().optional(),
  scope: z.string().optional(),
}).refine(token => !!(token.access_token || token.refresh_token));
type DiskTokens = Record<string, unknown>;

/** Only access fields and local ownership stamps belong in a borrowed cache. */
export function hostAccessCache(tokens: DiskTokens): DiskTokens {
  const fields = [
    "access_token", "token_type", "scope", "expires_in", OBTAINED_AT_FIELD,
  ];
  return {
    ...Object.fromEntries(fields.filter(key => tokens[key] !== undefined).map(key => [key, tokens[key]])),
    [RENEWAL_HELD_FIELD]: true,
  };
}

/** Caller holds the token lock. A durable offer always precedes removal of renewal credentials. */
export async function offerHostGrant(
  provider: SimpleOAuthProvider,
  disk: DiskTokens,
  legacy: boolean,
  renewal?: Awaited<ReturnType<typeof buildRenewalSpec>>,
): Promise<boolean> {
  try {
    if (disk.refresh_token && !renewal) return false;
    const obtained = typeof disk[OBTAINED_AT_FIELD] === "number" ? disk[OBTAINED_AT_FIELD] : 0;
    const token = TokenSchema.parse({
      access_token: disk.access_token,
      refresh_token: disk.refresh_token,
      token_type: disk.token_type,
      scope: disk.scope,
      obtained_at: obtained,
      ...(typeof disk.expires_in === "number" ? { expires_at: obtained + disk.expires_in * 1000 } : {}),
    });
    const dir = process.env.SUPER_MCP_HOST_GRANTS_DIR!;
    await provider.atomicWriteTokens({
      version: 1,
      sourcePath: provider.getTokenFilePath(),
      legacy,
      components: { default: token },
      ...(disk.refresh_token ? { renewal } : {}),
    }, path.join(dir, `${randomUUID()}.json`), true);
    return true;
  } catch (error) {
    logger.warn("Host grant offer deferred", {
      package_id: provider.getPackageId(),
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

/** Discover before locking, then offer the latest disk grant under the token lock. */
async function prepareLegacy(provider: SimpleOAuthProvider): Promise<void> {
  const before = await provider.readDiskTokens();
  if (!before?.access_token && !before?.refresh_token) return;
  if (isRenewalHeld(before) && !before.refresh_token) return;
  let renewal: Awaited<ReturnType<typeof buildRenewalSpec>>;
  if (before.refresh_token) {
    try {
      renewal = await buildRenewalSpec(provider);
      if (!renewal) await markHostReconnect(provider);
    } catch (error) {
      logger.warn("Host grant offer deferred", {
        package_id: provider.getPackageId(),
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  await withTokenRefreshLock(provider.getPackageId(), provider.getTokenFilePath(), async () => {
    const disk = await provider.readDiskTokens();
    if (!disk?.access_token && !disk?.refresh_token) return;
    if (isRenewalHeld(disk) && !disk.refresh_token) return;
    if (disk.refresh_token) {
      await provider.atomicWriteTokens({ ...disk, [RENEWAL_HELD_FIELD]: true });
    }
    if (await offerHostGrant(provider, disk, true, renewal)) {
      await provider.atomicWriteTokens(hostAccessCache(disk));
    }
  });
}

/** Invalid host configuration remains fatal, before the transport starts. */
export async function validateHostGrantsDirectory(): Promise<void> {
  if (!hostMode()) return;
  const dir = process.env.SUPER_MCP_HOST_GRANTS_DIR!;
  if (!path.isAbsolute(dir)) throw new Error("Absolute grants directory required");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Grants directory must be a directory without a symlink");
  }
  if (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid!())) {
    throw new Error("Private grants directory owned by the current user required");
  }
}

/** No standalone files are touched. Host mode holds every file even if a pass fails. */
export async function prepareHostGrants(getPackage: (id: string) => PackageConfig | undefined): Promise<void> {
  if (!hostMode()) return;
  for (const id of await listOAuthTokenPackages()) {
    try {
      const provider = new SimpleOAuthProvider(id);
      const config = getPackage(id);
      if (config) provider.setHostGrantConfig(config);
      await prepareLegacy(provider);
    } catch {
      logger.warn("Host grant preparation deferred", { package_id: id, code: "host_grant_prepare_failed" });
    }
  }
}

const AccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  obtained_at: z.number().finite(),
  expires_at: z.number().finite().optional(),
  scope: z.string().optional(),
});
const PullSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("fresh"),
    generation: z.number().int().positive(),
    components: z.record(z.string(), AccessSchema),
    ended: z.array(z.string()).optional(),
  }),
  z.object({ status: z.literal("needs_reconnect"), generation: z.number().int().positive() }),
  z.object({ status: z.literal("disconnected"), generation: z.number().int().positive() }),
  z.object({ status: z.literal("missing"), bootstrapAllowed: z.boolean() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const BridgeSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().min(1) });
const pulls = new Map<string, Promise<DiskTokens | undefined>>();

async function readHostCache(provider: SimpleOAuthProvider): Promise<DiskTokens | undefined> {
  try {
    return await provider.readDiskTokens();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    logger.warn("Ignoring corrupt OAuth cache", { package_id: provider.getPackageId() });
    return undefined;
  }
}

function remainingLifetimeMs(disk: DiskTokens | undefined): number {
  if (typeof disk?.expires_in !== "number") return Infinity;
  return typeof disk[OBTAINED_AT_FIELD] === "number"
    ? disk[OBTAINED_AT_FIELD] + disk.expires_in * 1000 - Date.now()
    : 0;
}

function usable(disk: DiskTokens | undefined, invalidate?: string): boolean {
  return typeof disk?.access_token === "string" && accessTokenHash(disk.access_token) !== invalidate &&
    remainingLifetimeMs(disk) > 0;
}

/** Pulls are single-flight per source; cache writes share the provider's cross-process lock. */
export async function pullHostAccess(
  provider: SimpleOAuthProvider,
  invalidate?: string,
): Promise<DiskTokens | undefined> {
  const source = provider.getTokenFilePath();
  const active = pulls.get(source);
  if (active) {
    const disk = await active;
    if (!invalidate || (typeof disk?.access_token === "string" && accessTokenHash(disk.access_token) !== invalidate)) {
      return disk;
    }
    return pullHostAccess(provider, invalidate);
  }
  const run = (async () => {
    let disk: DiskTokens | undefined;
    let marked = true;
    try {
      const marker = await SimpleOAuthProvider.readNeedsReconnectMarkerState(provider.getPackageId());
      marked = marker.state !== "absent";
      try {
        disk = await provider.readDiskTokens();
        const lifetime = typeof disk?.expires_in === "number" ? disk.expires_in * 1000 : Infinity;
        const remaining = remainingLifetimeMs(disk);
        if (!marked && !invalidate && usable(disk) && remaining >= Math.min(600_000, lifetime / 4)) return disk;
        if (disk?.refresh_token) {
          await prepareLegacy(provider);
          disk = await provider.readDiskTokens();
          // Metadata is still unavailable: keep the held grant intact for the next pull.
          if (disk?.refresh_token) return !marked && usable(disk, invalidate) ? disk : undefined;
        }
      } catch (error) {
        logger.warn("Host grant preparation deferred", {
          package_id: provider.getPackageId(),
          error_name: error instanceof Error ? error.name : typeof error,
        });
      }
      const bridge = BridgeSchema.parse(JSON.parse(await fs.readFile(process.env.MCP_HOST_BRIDGE_STATE!, "utf8")));
      const response = await fetch(`http://127.0.0.1:${bridge.port}/oauth/access`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ source, ...(invalidate ? { invalidate } : {}) }),
      });
      if (!response.ok) throw new Error("Host access request failed");
      const result = PullSchema.parse(await response.json());
      if (result.status === "fresh") {
        const access = result.components.default;
        if (!access) {
          await markHostReconnect(provider);
          return undefined;
        }
        const cache = hostAccessCache({
          access_token: access.access_token,
          token_type: access.token_type,
          scope: access.scope,
          [OBTAINED_AT_FIELD]: access.obtained_at,
          expires_in: access.expires_at !== undefined ? (access.expires_at - access.obtained_at) / 1000 : undefined,
        });
        let saved: DiskTokens | undefined = await withTokenRefreshLock(provider.getPackageId(), source, async () => {
          const current = await readHostCache(provider);
          if (current?.refresh_token) return current;
          await provider.atomicWriteTokens(cache);
          await provider.clearNeedsReconnectMarker();
          return cache;
        });
        if (saved?.refresh_token) {
          await prepareLegacy(provider);
          saved = await provider.readDiskTokens();
        }
        return usable(saved, invalidate) ? saved : undefined;
      }
      if (result.status === "missing") {
        disk = await readHostCache(provider);
      }
      if (result.status === "needs_reconnect" || result.status === "disconnected" ||
          (result.status === "missing" && !isRenewalHeld(disk) && !disk?.refresh_token)) {
        await markHostReconnect(provider);
        return undefined;
      }
      logger.info("Host access deferred", { package_id: provider.getPackageId(), status: result.status });
    } catch (error) {
      logger.warn("Host access unavailable", {
        package_id: provider.getPackageId(),
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
    return !marked && usable(disk, invalidate) ? disk : undefined;
  })();
  pulls.set(source, run);
  try {
    return await run;
  } finally {
    if (pulls.get(source) === run) pulls.delete(source);
  }
}
