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
 * Locale is pinned to C (LC_ALL/LANG/LC_TIME) so that Date.parse succeeds
 * regardless of the user's locale — matches the app's processStartTime.ts
 * runCommand() env pin.
 *
 * Example output: "Mon Jun 23 13:45:02 2026"
 */
async function probeDarwin(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 3_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" },
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
 * clock ticks since boot), then combine with the boot epoch from /proc/uptime.
 *
 * Formula matches the app's processStartTime.ts exactly:
 *   bootEpochMs = Date.now() - (uptimeSec * 1000)
 *   startTimeMs = bootEpochMs + (startTicks * 1000) / clkTck
 *
 * Using /proc/uptime (not /proc/stat btime) is important because the two
 * boot-epoch sources can diverge by 1-2 s on some kernels (btime is an integer
 * second truncated at boot; uptime is a live float computed from the kernel
 * monotonic clock), which would push the comparison outside the 2 s tolerance.
 *
 * CLK_TCK is resolved via `getconf CLK_TCK` (falls back to 100 only when
 * getconf is unavailable — which is exceedingly rare on any modern Linux).
 *
 * Falls back to `ps -o lstart=` (with locale pin) if /proc is unavailable.
 */
async function probeLinux(pid: number): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");

    // --- resolve CLK_TCK via getconf (matches app's getLinuxClockTicksPerSecond) ---
    // On getconf failure we return null (fail-safe: treat owner as alive) rather than
    // assuming 100 — this matches src/core/utils/processStartTime.ts exactly, keeping
    // the seam identical and preventing a spurious dead verdict on rare Linux systems.
    let clkTck: number | null = null;
    try {
      const { stdout: clkStdout } = await execFileAsync("getconf", ["CLK_TCK"], {
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C" },
      });
      const parsed = parseInt(clkStdout.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        clkTck = parsed;
      }
    } catch {
      // getconf unavailable — return null (fail-safe: treat owner as alive, matches app).
    }
    if (clkTck === null) return null;

    // --- read starttime ticks from /proc/<pid>/stat ---
    let statContent: string;
    try {
      statContent = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch {
      // /proc not available — fall back to ps (with locale pin).
      return await probeDarwin(pid);
    }

    // Field 22 (0-indexed: field 21) is starttime in clock ticks since boot.
    // The comm field (field 2) may contain spaces wrapped in parens — find the
    // closing paren to locate subsequent fields safely.
    const closeParen = statContent.lastIndexOf(")");
    if (closeParen === -1) return null;
    const afterComm = statContent.slice(closeParen + 1).trim();
    const fields = afterComm.split(/\s+/);
    const starttimeTicks = parseInt(fields[19], 10); // field 22 = fields[19] after comm
    if (!Number.isFinite(starttimeTicks) || starttimeTicks < 0) return null;

    // --- derive boot epoch from /proc/uptime (matches app's initializeLinuxClockInfo) ---
    // We sample Date.now() and /proc/uptime as close together as possible to
    // minimise jitter.  The app does the same at init time; on the same host
    // both readings will agree within a few ms, well inside the 2 s tolerance.
    let uptimeContent: string;
    try {
      uptimeContent = await readFile("/proc/uptime", "utf8");
    } catch {
      return null;
    }
    const uptimeSeconds = parseFloat(uptimeContent.trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;

    const bootEpochMs = Date.now() - uptimeSeconds * 1_000;
    const startTimeMs = bootEpochMs + (starttimeTicks * 1_000) / clkTck;
    if (!Number.isFinite(startTimeMs)) return null;

    return Math.round(startTimeMs);
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
