/**
 * ownerWatchdog — owner-liveness self-watchdog for super-mcp.
 *
 * When super-mcp is spawned by Rebel it receives three owner-identity flags:
 *   --rebel-owner-pid   <pid>      the spawning process's PID
 *   --rebel-owner-start <epochMs>  the spawning process's start time (ms since epoch)
 *   --rebel-owner-id    <uuid>     a stable session UUID for logging
 *
 * This module polls the owner's liveness on a ~15s interval.  When the owner is
 * confirmed dead across N=2 consecutive polls it calls `onOwnerDead()` — which the
 * caller wires to the existing graceful `shutdown()` so downstream MCP children
 * are closed cleanly (no trading one orphan class for another).
 *
 * Safety design — ESRCH-only by design (REBEL-6ED):
 *   - ESRCH (no such process)  → owner dead (conclusive) → fires at N=2
 *   - kill-success             → alive (UNCONDITIONALLY — no start-time check)
 *   - EPERM                    → treat as alive (no permission, but exists)
 *   - other kill(0) error      → treat as alive (fail-safe)
 *   - N=2 consecutive dead reads required before firing (debounces transient glitches)
 *   - Timer is unref()'d so it never keeps the process alive on its own
 *
 * Why ESRCH-only (no start-time probe):
 *   The watchdog previously duplicated the app's process start-time probe
 *   (src/core/utils/processStartTime.ts) to guard against PID reuse.  A seam
 *   mismatch in the Windows implementation — `Get-Date -UFormat %s` returns
 *   local-time seconds on PowerShell 5.1, not UTC epoch-seconds — produced a
 *   permanent false "PID reused → owner dead" verdict and self-exit of super-mcp
 *   on every Windows start (REBEL-6ED: ~1000 errors/day, 26-32 users, 0.4.50).
 *
 *   The fix is structural: a duplicate probe creates an entire class of seam-mismatch
 *   bugs (formula, locale, clock, platform fallback order) that simply cannot exist
 *   when there is only ONE implementation.  We therefore DELETE the duplicate probe
 *   from the watchdog entirely.  Owner start-time identity is now owned SOLELY by the
 *   app-side startup reaper via processStartTime.ts; the watchdog deliberately does
 *   NOT re-implement it.
 *
 *   Asymmetry of harm justifies this design:
 *     • False-dead (ESRCH-but-PID-reused): impossible — ESRCH means the PID slot is
 *       empty; the impostor has not yet claimed it.  ESRCH is a conclusive signal.
 *     • False-alive (kill(0) succeeds but owner is replaced by a PID-reuse impostor):
 *       rare in practice.  If the impostor is short-lived, the watchdog fires once it
 *       exits (ESRCH).  If the impostor is long-lived, super-mcp lingers as an orphan
 *       until the next Rebel launch, when the app-side `reapCrossLaunchSuperMcpOrphans()`
 *       backstop reaps it (it is a CROSS-LAUNCH reaper, NOT an in-session sweep). That
 *       bounded linger is vastly preferable to tearing down super-mcp and all MCP
 *       children for all connectors on every Windows launch (the REBEL-6ED failure).
 *
 * ownerStartMs is kept in WatchdogOptions and log lines for correlation only; it no
 * longer gates any verdict.
 *
 * Activation: only when all three owner flags are present and valid — standalone
 * super-mcp invocations (no flags) are completely unaffected.
 */

import { getLogger } from "./logging.js";

const logger = getLogger();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** PID of the owner process (the Electron app that spawned us). */
  ownerPid: number;
  /** Epoch-ms start time of the owner — kept for log correlation only; does NOT gate any verdict. */
  ownerStartMs: number | null;
  /** Stable UUID for log correlation. */
  ownerId?: string;
  /** Poll interval in milliseconds (default: 15 000). */
  pollMs?: number;
  /** Called once when the owner is confirmed dead.  Should trigger graceful shutdown. */
  onOwnerDead: () => void | Promise<void>;
}

export interface WatchdogHandle {
  /** Stop all polling.  Safe to call multiple times. */
  stop: () => void;
}

/**
 * Start the owner-liveness watchdog.  Returns a handle so the caller can clear
 * the timer on graceful shutdown (via the existing `shutdown()` in server.ts).
 */
export function startWatchdog(options: WatchdogOptions): WatchdogHandle {
  const {
    ownerPid,
    ownerStartMs,
    ownerId = "unknown",
    pollMs = 15_000,
    onOwnerDead,
  } = options;

  logger.info("Owner-liveness watchdog started", {
    ownerPid,
    ownerStartMs,
    ownerId,
    pollMs,
  });

  let consecutiveDeadReads = 0;
  let fired = false;
  let stopped = false;

  const handle: WatchdogHandle = { stop: () => {} };

  const tick = async (): Promise<void> => {
    if (stopped || fired) return;

    const verdict = checkOwnerLiveness(ownerPid);

    if (verdict === "alive") {
      consecutiveDeadReads = 0;
      return;
    }

    // verdict === "dead"
    consecutiveDeadReads++;
    logger.debug("Owner liveness: dead read", {
      ownerPid,
      ownerId,
      consecutiveDeadReads,
      required: 2,
    });

    if (consecutiveDeadReads < 2) {
      // Not yet enough consecutive reads — wait for the next poll.
      return;
    }

    // N=2 consecutive dead reads — fire once then self-stop.
    fired = true;
    handle.stop();

    logger.warn("Owner process confirmed dead — initiating self-exit", {
      ownerPid,
      ownerStartMs,
      ownerId,
      reason: "owner_dead",
    });

    let cleanupThrew = false;
    try {
      await onOwnerDead();
    } catch (err) {
      // Cleanup threw — log but don't let it prevent the exit below.
      cleanupThrew = true;
      logger.error("onOwnerDead threw during owner-death teardown", {
        ownerPid,
        ownerId,
        error: String(err),
      });
    } finally {
      // Guarantee exit regardless of whether cleanup succeeded or threw.
      // The timer is already stopped (handle.stop() above), so without this
      // a throwing cleanup would leave the process stranded — exactly the
      // orphan this watchdog is meant to prevent.
      // Non-zero on the cleanup-threw path preserves the operational signal.
      process.exit(cleanupThrew ? 1 : 0);
    }
  };

  // Use setInterval rather than recursive setTimeout so the interval stays
  // predictable under fake timers in tests.
  const interval = setInterval(() => {
    tick().catch((err) => {
      logger.error("Unexpected error in watchdog tick", {
        ownerPid,
        ownerId,
        error: String(err),
      });
    });
  }, pollMs);

  // Unref so the timer never keeps the process alive on its own.
  interval.unref();

  handle.stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    logger.debug("Owner-liveness watchdog stopped", { ownerPid, ownerId });
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Liveness check — ESRCH-only
// ---------------------------------------------------------------------------

type LivenessVerdict = "alive" | "dead";

/**
 * Check whether the owner PID is still alive using kill(pid, 0).
 *
 * Only ESRCH (no such process) is treated as conclusively dead.
 * kill(0) success, EPERM, and any other error all return "alive" (fail-safe).
 *
 * No start-time probe is performed; see the module docblock for rationale.
 */
function checkOwnerLiveness(ownerPid: number): LivenessVerdict {
  try {
    process.kill(ownerPid, 0);
    // kill succeeded — PID exists.  Unconditionally alive; no start-time check.
    return "alive";
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ESRCH") {
      // Process does not exist — definitively dead.
      return "dead";
    }
    if (code === "EPERM") {
      // Process exists but we lack permission to signal it — treat as alive.
      return "alive";
    }
    // Any other error: fail-safe → treat as alive.
    logger.warn("process.kill(ownerPid, 0) threw unexpected error; treating owner as alive", {
      ownerPid,
      error: String(err),
    });
    return "alive";
  }
}
