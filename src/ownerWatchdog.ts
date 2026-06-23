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
 * Safety design:
 *   - ESRCH (no such process)           → owner dead (conclusive)
 *   - kill-success + start-time differs → PID reused by unrelated process → owner dead
 *   - kill-success + start-time matches → alive
 *   - kill-success + probe returns null  → treat as alive (fail-safe)
 *   - EPERM                              → treat as alive (no permission, but exists)
 *   - N=2 consecutive dead reads required before firing (debounces transient glitches)
 *   - Timer is unref()'d so it never keeps the process alive on its own
 *
 * Activation: only when all three owner flags are present and valid — standalone
 * super-mcp invocations (no flags) are completely unaffected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "./logging.js";

const execFileAsync = promisify(execFile);
const logger = getLogger();

// Tolerance (ms) for start-time comparison.  Clocks aren't perfectly synchronised
// across the epoch-ms round-trip; 2 s is a safe floor for same-host parent/child.
const START_TIME_TOLERANCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** PID of the owner process (the Electron app that spawned us). */
  ownerPid: number;
  /** Epoch-ms start time of the owner (for PID-reuse guard); null = no reuse guard. */
  ownerStartMs: number | null;
  /** Stable UUID for log correlation. */
  ownerId?: string;
  /** Poll interval in milliseconds (default: 15 000). */
  pollMs?: number;
  /** Called once when the owner is confirmed dead.  Should trigger graceful shutdown. */
  onOwnerDead: () => void | Promise<void>;
  /**
   * Injected start-time prober (for testing).  Defaults to the real cross-platform probe.
   * Must return epoch-ms or null (probe unavailable).
   */
  _probeStartTimeMs?: (pid: number) => Promise<number | null>;
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
    _probeStartTimeMs = probeProcessStartTimeMs,
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

    const verdict = await checkOwnerLiveness(ownerPid, ownerStartMs, _probeStartTimeMs);

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

    try {
      await onOwnerDead();
    } catch (err) {
      // If the shutdown callback itself throws, still log and exit.
      logger.error("onOwnerDead threw during owner-death teardown", {
        ownerPid,
        ownerId,
        error: String(err),
      });
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
// Liveness check
// ---------------------------------------------------------------------------

type LivenessVerdict = "alive" | "dead";

async function checkOwnerLiveness(
  ownerPid: number,
  ownerStartMs: number | null,
  probeStartTime: (pid: number) => Promise<number | null>,
): Promise<LivenessVerdict> {
  let killSucceeded = false;

  try {
    process.kill(ownerPid, 0);
    killSucceeded = true;
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

  if (!killSucceeded) return "alive";

  // kill succeeded — PID exists.  Apply the start-time reuse guard if we have
  // an expected start time to compare against.
  if (ownerStartMs === null) {
    // No start time to compare → treat as alive (flag-absent case or probe failed
    // at spawn time; we can't distinguish from PID reuse).
    return "alive";
  }

  const liveStartMs = await probeStartTime(ownerPid);

  if (liveStartMs === null) {
    // Probe unavailable on this platform — fail-safe → alive.
    return "alive";
  }

  const diff = Math.abs(liveStartMs - ownerStartMs);
  if (diff > START_TIME_TOLERANCE_MS) {
    // Start time mismatch: the PID has been reused by an unrelated process.
    logger.debug("Owner PID reuse detected via start-time mismatch", {
      ownerPid,
      expectedStartMs: ownerStartMs,
      liveStartMs,
      diffMs: diff,
    });
    return "dead";
  }

  // Start time matches within tolerance — genuine owner, still alive.
  return "alive";
}

// ---------------------------------------------------------------------------
// Cross-platform start-time probe
// ---------------------------------------------------------------------------

/**
 * Probe the start time (epoch ms) of the given PID.
 *
 * Returns null if:
 *   - the PID no longer exists
 *   - the platform probe fails or is unavailable
 *   - the result cannot be parsed
 *
 * Never throws.
 */
export async function probeProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      return await probeDarwin(pid);
    } else if (platform === "linux") {
      return await probeLinux(pid);
    } else if (platform === "win32") {
      return await probeWindows(pid);
    }
    // Unknown platform — fail-safe.
    return null;
  } catch {
    return null;
  }
}

/**
 * macOS: use `ps -o lstart= -p <pid>` which prints the human-readable start
 * date/time of the process (empty output = no such PID).
 *
 * Example output: "Mon Jun 23 13:45:02 2026"
 */
async function probeDarwin(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 3_000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Linux: read /proc/<pid>/stat and extract the process start time (field 22,
 * clock ticks since boot), then combine with the boot time from /proc/stat.
 *
 * Falls back to `ps -o lstart= -p <pid>` if /proc is unavailable.
 */
async function probeLinux(pid: number): Promise<number | null> {
  try {
    // Try /proc/<pid>/stat first.
    const { readFile } = await import("node:fs/promises");

    let statContent: string;
    try {
      statContent = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch {
      // /proc not available — fall back to ps.
      return await probeDarwin(pid); // ps -o lstart= works on most Linux distros too.
    }

    // Field 22 (0-indexed: field 21) is starttime in clock ticks since boot.
    // The comm field (field 2) may contain spaces wrapped in parens — find the
    // closing paren to locate subsequent fields safely.
    const closeParen = statContent.lastIndexOf(")");
    if (closeParen === -1) return null;
    const afterComm = statContent.slice(closeParen + 2); // skip ") "
    const fields = afterComm.split(" ");
    const starttimeTicks = parseInt(fields[19], 10); // field 22 = fields[19] after comm
    if (!Number.isFinite(starttimeTicks)) return null;

    // Read boot time from /proc/stat.
    let procStatContent: string;
    try {
      procStatContent = await readFile("/proc/stat", "utf8");
    } catch {
      return null;
    }
    const btimeLine = procStatContent.split("\n").find((l) => l.startsWith("btime "));
    if (!btimeLine) return null;
    const bootTimeSec = parseInt(btimeLine.split(" ")[1], 10);
    if (!Number.isFinite(bootTimeSec)) return null;

    const clkTck = 100; // sysconf(_SC_CLK_TCK) — 100 on virtually all Linux systems
    const startTimeSec = bootTimeSec + starttimeTicks / clkTck;
    return Math.round(startTimeSec * 1_000);
  } catch {
    return null;
  }
}

/**
 * Windows: use PowerShell Get-CimInstance to retrieve process creation time.
 */
async function probeWindows(pid: number): Promise<number | null> {
  try {
    const psScript =
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate` +
      ` | Get-Date -UFormat %s`;
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { timeout: 5_000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const sec = parseFloat(trimmed);
    return Number.isNaN(sec) ? null : Math.round(sec * 1_000);
  } catch {
    return null;
  }
}
