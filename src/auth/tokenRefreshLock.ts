import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { getLogger } from "../logging.js";

const logger = getLogger();

// proper-lockfile is a CJS package; load via createRequire to avoid ESM
// interop surprises (mirrors the installGracefulFs pattern).
const requireFn = createRequire(import.meta.url);
interface ProperLockfile {
  lock: (
    file: string,
    options: {
      stale?: number;
      update?: number;
      retries?:
        | number
        | { retries: number; minTimeout?: number; maxTimeout?: number; factor?: number; randomize?: boolean };
      realpath?: boolean;
      onCompromised?: (err: Error) => void;
    },
  ) => Promise<() => Promise<void>>;
}
const properLockfile = requireFn("proper-lockfile") as ProperLockfile;

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_UPDATE_MS = 5_000;
// Bounded retries with jittered backoff. Total wait stays well under the 30s
// connect timeout so a contended lock surfaces a retryable error rather than
// blowing the connect budget. proper-lockfile uses retry/exponential backoff
// (retry-internal `retry` lib semantics): with factor 2, min 200ms, max 2s,
// randomize, ~8 retries totals roughly 10-14s of worst-case waiting.
const DEFAULT_RETRIES = {
  retries: 8,
  minTimeout: 200,
  maxTimeout: 2_000,
  factor: 2,
  randomize: true,
} as const;

/**
 * True when a lock-acquire failure is genuine contention (proper-lockfile
 * exhausted its retries while another holder kept the lock) rather than an
 * infrastructural error (missing dir, EACCES, disk failure). proper-lockfile
 * signals contention with `code === 'ELOCKED'`.
 */
function isContentionError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

function resolveStaleMs(): number {
  const envValue = process.env.SUPER_MCP_REFRESH_LOCK_STALE_MS;
  if (!envValue) {
    return DEFAULT_STALE_MS;
  }
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STALE_MS;
  }
  return parsed;
}

/** Thrown when the cross-process lock can't be acquired within the budget. */
export class TokenRefreshLockBusyError extends Error {
  readonly retryable = true;
  readonly packageId: string;
  constructor(packageId: string, cause?: unknown) {
    super(`Token refresh is busy for package '${packageId}' (auth lock contended)`);
    this.name = "TokenRefreshLockBusyError";
    this.packageId = packageId;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Thrown when the lock cannot be acquired for an INFRASTRUCTURAL reason that is
 * NOT contention — a missing parent directory, EACCES, a disk failure, etc.
 * Distinct from {@link TokenRefreshLockBusyError} so callers do not retry a
 * genuinely-broken environment as if it were a busy lock. Not retryable.
 */
export class TokenRefreshLockError extends Error {
  readonly retryable = false;
  readonly packageId: string;
  constructor(packageId: string, cause?: unknown) {
    super(`Token refresh lock could not be acquired for package '${packageId}' (lock infrastructure error)`);
    this.name = "TokenRefreshLockError";
    this.packageId = packageId;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Thrown when an acquired lock is compromised mid-critical-section. */
export class TokenRefreshLockCompromisedError extends Error {
  readonly packageId: string;
  constructor(packageId: string, cause?: unknown) {
    super(`Token refresh lock was compromised for package '${packageId}'`);
    this.name = "TokenRefreshLockCompromisedError";
    this.packageId = packageId;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// In-process per-package async mutex (a simple promise-chain map). This sits
// INSIDE the cross-process lock so that, within one process, concurrent refresh
// transactions for the same package are serialized before they even contend for
// the on-disk lock — keeping the body-parsed failed-token capture from being
// clobbered by a sibling in-process auth.
// ---------------------------------------------------------------------------
const inProcessChains = new Map<string, Promise<unknown>>();

function withInProcessMutex<T>(packageId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inProcessChains.get(packageId) ?? Promise.resolve();
  // Run fn after the prior holder settles (success OR failure).
  const run = prior.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next waiter.
  inProcessChains.set(
    packageId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Run `fn` while holding a per-package, cross-process token-refresh lock (with
 * an in-process mutex nested inside it). The lock is keyed to the token-file
 * path. Mirrors the proven semantics of the in-app HubSpot credential lock:
 * conservative stale window, heartbeat update, bounded jittered retries,
 * realpath:false, and a hard-fail if the lock is compromised.
 *
 * NOTE: the lock target file (the token file) must exist for proper-lockfile to
 * place its sibling `.lock` directory; we ensure an empty placeholder exists so
 * the very first refresh (before any token has ever been written) can still
 * lock. The lock is on the PATH, independent of the file's contents.
 */
export interface TokenRefreshLockOptions {
  /** Override the stale window (ms). Defaults to resolveStaleMs(). */
  staleMs?: number;
  /** Override proper-lockfile retry policy. Defaults to DEFAULT_RETRIES. */
  retries?:
    | number
    | { retries: number; minTimeout?: number; maxTimeout?: number; factor?: number; randomize?: boolean };
}

export async function withTokenRefreshLock<T>(
  packageId: string,
  tokenFilePath: string,
  fn: (assertLockHealthy: () => void) => Promise<T>,
  options?: TokenRefreshLockOptions,
): Promise<T> {
  return withInProcessMutex(packageId, async () => {
    // Ensure the lock target exists (proper-lockfile locks an existing path).
    try {
      await fsp.access(tokenFilePath);
    } catch {
      // Create an empty placeholder so we can lock the path. saveTokens() later
      // atomically renames over it; the lock is on the path, not the inode. A
      // failure here (missing parent dir, EACCES, disk full) is infrastructural,
      // NOT contention — surface it as a hard lock error rather than swallowing
      // it and then mis-reporting the subsequent lock failure as "busy".
      try {
        await fsp.mkdir(dirname(tokenFilePath), { recursive: true, mode: 0o700 });
        await fsp.writeFile(tokenFilePath, "", { flag: "a", mode: 0o600 });
      } catch (error) {
        logger.error("Could not create token-lock target file", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TokenRefreshLockError(packageId, error);
      }
    }

    const tracker: { error?: Error } = {};
    let release: (() => Promise<void>) | undefined;
    let primaryError: unknown;

    try {
      const releaseFn = await properLockfile.lock(tokenFilePath, {
        stale: options?.staleMs ?? resolveStaleMs(),
        update: DEFAULT_UPDATE_MS,
        retries: options?.retries ?? { ...DEFAULT_RETRIES },
        realpath: false,
        onCompromised: (err: Error) => {
          tracker.error = err;
          logger.error("Token refresh lock compromised", {
            package_id: packageId,
            error: err.message,
          });
        },
      });
      release = async () => {
        await releaseFn();
      };
      logger.debug("Acquired token refresh lock", { package_id: packageId });
    } catch (error) {
      // Distinguish genuine contention (proper-lockfile exhausts retries with
      // ELOCKED) from an infrastructural failure (missing dir, EACCES, disk).
      // Only the former is a retryable "busy"; the latter must not send callers
      // down the retry path against a broken environment (GPT F4).
      if (isContentionError(error)) {
        logger.warn("Could not acquire token refresh lock within budget", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TokenRefreshLockBusyError(packageId, error);
      }
      logger.error("Token refresh lock acquisition failed (infrastructure error)", {
        package_id: packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new TokenRefreshLockError(packageId, error);
    }

    try {
      const lockDirPath = `${tokenFilePath}.lock`;
      const assertLockHealthy = (): void => {
        if (tracker.error) {
          throw new TokenRefreshLockCompromisedError(packageId, tracker.error);
        }
        if (!fs.existsSync(lockDirPath)) {
          throw new TokenRefreshLockCompromisedError(
            packageId,
            new Error(`Lock directory missing: ${lockDirPath}`),
          );
        }
      };

      assertLockHealthy();
      const result = await fn(assertLockHealthy);
      assertLockHealthy();
      return result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (release) {
        try {
          await release();
          logger.debug("Released token refresh lock", { package_id: packageId });
        } catch (releaseError) {
          if (primaryError === undefined) {
            throw new TokenRefreshLockCompromisedError(packageId, releaseError);
          }
          logger.warn("Failed to release token refresh lock (suppressed under prior error)", {
            package_id: packageId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        }
      }
    }
  });
}
