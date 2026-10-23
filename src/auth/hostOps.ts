import * as fs from "node:fs/promises";
import { z } from "zod";
import { getLogger } from "../logging.js";
import { SimpleOAuthProvider, isRenewalHeld, listOAuthTokenPackages, RENEWAL_HELD_FIELD } from "./providers/simple.js";
import { hostMode, markHostReconnect } from "./hostGrants.js";
import { TokenRefreshLockBusyError, withTokenRefreshLock } from "./tokenRefreshLock.js";

const logger = getLogger();
const PackageId = z.string().min(1).max(200)
  .refine(id => !/[\\/\x00-\x1f\x7f]/.test(id) && !id.startsWith("."));
const HostOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("release_all") }).strict(),
  z.object({ op: z.literal("grant_changed"), package_id: PackageId }).strict(),
]);
type HostOp = z.infer<typeof HostOpSchema>;
export interface HostOpsDeps {
  onCredentialsChanged?(packageId: string): Promise<void>;
}

async function runHostOp(op: HostOp, deps: HostOpsDeps): Promise<{ status: string; skipped?: number }> {
  if (op.op === "grant_changed") {
    const provider = new SimpleOAuthProvider(op.package_id);
    await withTokenRefreshLock(op.package_id, provider.getTokenFilePath(), async () => {
      const disk = await provider.readDiskTokens();
      if (disk && !disk.refresh_token) {
        await provider.atomicWriteTokens({ [RENEWAL_HELD_FIELD]: true });
      }
      await provider.clearNeedsReconnectMarker();
    });
    await deps.onCredentialsChanged?.(op.package_id);
    return { status: "changed" };
  }
  let skipped = 0;
  for (const id of await listOAuthTokenPackages()) {
    try {
      const provider = new SimpleOAuthProvider(id);
      await withTokenRefreshLock(id, provider.getTokenFilePath(), async () => {
        const raw = await fs.readFile(provider.getTokenFilePath(), "utf8");
        if (!raw.trim()) {
          // A token-lock placeholder is no sign-in; absence is the form standalone reads cleanly.
          await fs.unlink(provider.getTokenFilePath());
          return;
        }
        const disk = JSON.parse(raw);
        if (!isRenewalHeld(disk)) return;
        await markHostReconnect(provider);
        if (!disk.refresh_token) {
          // Borrowed access is not a local grant. Absence also clears standalone SDK state.
          await fs.unlink(provider.getTokenFilePath());
          return;
        }
        const { [RENEWAL_HELD_FIELD]: _held, ...unheld } = disk;
        await provider.atomicWriteTokens(unheld);
      });
    } catch (error) {
      skipped++;
      logger.warn("Host grant release deferred", {
        package_id: id,
        code: "host_grant_release_failed",
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return { status: "released", skipped };
}

/** Loopback route admission lives in server.ts. Never log credential-bearing inputs. */
export async function handleHostOpRequest(body: unknown, deps: HostOpsDeps) {
  const parsed = HostOpSchema.safeParse(body);
  if (!parsed.success) {
    return { httpStatus: 400, body: { status: "error", code: "invalid_request" } };
  }
  if (parsed.data.op === "grant_changed" && !hostMode()) {
    return { httpStatus: 404, body: { status: "error", code: "not_found" } };
  }
  try {
    const result = await runHostOp(parsed.data, deps);
    logger.info("Host OAuth op", { op: parsed.data.op, status: result.status });
    return { httpStatus: 200, body: result };
  } catch (error) {
    logger.error("Host OAuth op failed", {
      op: parsed.data.op,
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return error instanceof TokenRefreshLockBusyError
      ? { httpStatus: 503, body: { status: "busy" } }
      : { httpStatus: 500, body: { status: "error", code: "internal" } };
  }
}
