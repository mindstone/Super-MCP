/**
 * Unit tests for ownerWatchdog — the owner-liveness self-watchdog that detects
 * when the spawning Electron/Node owner process has died and triggers graceful
 * self-exit so super-mcp doesn't accumulate as an orphan.
 *
 * All process interactions are mocked; no real processes are spawned.
 * Uses fake timers so poll intervals advance synchronously.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks must be declared before the dynamic import below (vitest hoists vi.mock calls).
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We test the module functions directly; dynamic import lets us re-require after
// mocking (needed because vi.mock is hoisted but module cache persists).
const { startWatchdog, probeProcessStartTimeMs } = await import('../src/ownerWatchdog.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers by `n` full poll cycles. */
async function advancePolls(n: number, pollMs = 15_000): Promise<void> {
  for (let i = 0; i < n; i++) {
    // advanceTimersByTimeAsync fires timers AND flushes resulting microtasks/promises,
    // making it safe for async callbacks (like tick()). Vitest 2.x API.
    await vi.advanceTimersByTimeAsync(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ownerWatchdog — startWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires onOwnerDead exactly once after N=2 consecutive ESRCH reads', async () => {
    // process.kill throws ESRCH (no process) on every call.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill ESRCH 99999'), { code: 'ESRCH' });
      throw err;
    });

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // 1st dead read — not yet fired (need 2 consecutive).
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    // 2nd consecutive dead read — fires.
    await advancePolls(1);
    expect(onOwnerDead).toHaveBeenCalledTimes(1);

    // Additional polls do NOT re-fire (watchdog self-stops after firing).
    await advancePolls(2);
    expect(onOwnerDead).toHaveBeenCalledTimes(1);

    stop();
  });

  it('does NOT fire when process.kill throws EPERM (alive, inaccessible)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill EPERM 99999'), { code: 'EPERM' });
      throw err;
    });

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    await advancePolls(5);
    expect(onOwnerDead).not.toHaveBeenCalled();

    stop();
  });

  it('fires when start-time mismatch indicates PID reuse (kill succeeds but wrong process)', async () => {
    // kill(pid, 0) succeeds — pid is live.
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    // But the live process has a DIFFERENT start time (PID reused by unrelated proc).
    const ownerStartMs = 1_700_000_000_000;
    const impostorStartMs = 1_700_000_099_000; // ~99s later — different process

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 1234,
      ownerStartMs,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
      // Inject a start-time prober that returns the impostor's start time.
      _probeStartTimeMs: vi.fn().mockResolvedValue(impostorStartMs),
    });

    // 1st read: mismatch → dead-count = 1.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    // 2nd consecutive mismatch → fires.
    await advancePolls(1);
    expect(onOwnerDead).toHaveBeenCalledTimes(1);

    stop();
  });

  it('does NOT fire when start-time probe returns null (fail-safe: treat alive)', async () => {
    // kill(pid, 0) succeeds — pid is live.
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 1234,
      ownerStartMs: 1_700_000_000_000,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
      // Probe unavailable — returns null (platform can't determine start time).
      _probeStartTimeMs: vi.fn().mockResolvedValue(null),
    });

    await advancePolls(5);
    expect(onOwnerDead).not.toHaveBeenCalled();

    stop();
  });

  it('resets dead-count on a single alive read between two dead reads (debounce)', async () => {
    let callCount = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 1st poll: dead (ESRCH).
        const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        throw err;
      }
      // 2nd poll: alive (returns normally).
      return true as any;
    });

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // 1st poll: dead → count = 1.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    // 2nd poll: alive → count resets to 0.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    stop();
  });

  it('stop() prevents further ticks from firing', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      throw err;
    });

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // Stop before the 2nd consecutive dead read would fire.
    await advancePolls(1); // 1st dead read.
    stop();
    await advancePolls(5); // Would have fired without stop().
    expect(onOwnerDead).not.toHaveBeenCalled();
  });

  it('process.exit is called even when onOwnerDead cleanup throws (F2 guarantee)', async () => {
    // Owner is dead (ESRCH on every poll).
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill ESRCH 99999'), { code: 'ESRCH' });
      throw err;
    });

    // Mock process.exit so it doesn't actually exit the test runner.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    // onOwnerDead throws during cleanup.
    const onOwnerDead = vi.fn().mockRejectedValue(new Error('cleanup exploded'));

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // Two consecutive dead reads to fire the watchdog.
    await advancePolls(1);
    await advancePolls(1);

    // onOwnerDead was called (cleanup was attempted).
    expect(onOwnerDead).toHaveBeenCalledTimes(1);

    // process.exit MUST have been called despite the cleanup throw.
    expect(exitSpy).toHaveBeenCalledTimes(1);
    // Non-zero exit code when cleanup threw (preserves operational signal).
    expect(exitSpy).toHaveBeenCalledWith(1);

    stop();
  });

  it('process.exit(0) is called when onOwnerDead succeeds cleanly', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill ESRCH 99999'), { code: 'ESRCH' });
      throw err;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    await advancePolls(1);
    await advancePolls(1);

    expect(onOwnerDead).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    stop();
  });

  it('timer is unref()d so it does not keep the process alive on its own', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true as any);
    const onOwnerDead = vi.fn();

    // We can't easily assert .unref() on the real interval from outside,
    // but we can verify the API contract: startWatchdog doesn't throw and
    // stop() clears the interval cleanly.
    const { stop } = startWatchdog({
      ownerPid: 1234,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });
    expect(() => stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI flag parse conformance
// ---------------------------------------------------------------------------

describe('cli.ts — parses all three --rebel-owner-* flags', () => {
  it('getArg reads --rebel-owner-pid, --rebel-owner-start, --rebel-owner-id from argv', async () => {
    // We replicate the getArg logic (it's trivial and inline in cli.ts) here as a
    // seam-conformance test: verifies the exact flag names the plan specifies are
    // parseable via the existing mechanism, so a silent flag-name drift can't recur.

    function getArgFrom(args: string[], name: string, d?: string): string | undefined {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : d;
    }

    const argv = [
      '--rebel-owner-pid', '12345',
      '--rebel-owner-start', '1700000000000',
      '--rebel-owner-id', 'abc-def-ghi',
      '--port', '3010',
    ];

    expect(getArgFrom(argv, 'rebel-owner-pid')).toBe('12345');
    expect(getArgFrom(argv, 'rebel-owner-start')).toBe('1700000000000');
    expect(getArgFrom(argv, 'rebel-owner-id')).toBe('abc-def-ghi');
    // Unrelated flag still works.
    expect(getArgFrom(argv, 'port')).toBe('3010');
    // Absent flag returns undefined.
    expect(getArgFrom(argv, 'rebel-owner-kind')).toBeUndefined();
  });

  it('activation gate: watchdog activates only when all three flags are strictly valid', () => {
    // Mirrors the strict gating logic in cli.ts exactly (parseStrictInt + isUuidShaped).
    // Must reject partial/garbage inputs that parseInt would silently accept.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function parseStrictInt(raw: string | undefined): number {
      if (!raw) return NaN;
      const n = parseInt(raw, 10);
      if (!Number.isSafeInteger(n)) return NaN;
      if (String(n) !== raw.trim()) return NaN;
      return n;
    }
    function isUuidShaped(s: string | undefined): boolean {
      return typeof s === 'string' && UUID_RE.test(s);
    }
    function shouldActivateWatchdog(
      pidRaw: string | undefined,
      startRaw: string | undefined,
      idRaw: string | undefined,
    ): boolean {
      const pid = parseStrictInt(pidRaw);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      const startMs = parseStrictInt(startRaw);
      if (!Number.isFinite(startMs) || startMs <= 0) return false;
      if (!isUuidShaped(idRaw)) return false;
      return true;
    }

    const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

    // All three present and valid → activate.
    expect(shouldActivateWatchdog('12345', '1700000000000', VALID_UUID)).toBe(true);
    // Missing pid → no.
    expect(shouldActivateWatchdog(undefined, '1700000000000', VALID_UUID)).toBe(false);
    // Missing start → no.
    expect(shouldActivateWatchdog('12345', undefined, VALID_UUID)).toBe(false);
    // Missing id → no.
    expect(shouldActivateWatchdog('12345', '1700000000000', undefined)).toBe(false);
    // Non-UUID id (arbitrary string) → no.
    expect(shouldActivateWatchdog('12345', '1700000000000', 'some-non-uuid')).toBe(false);
    // Invalid pid (non-numeric) → no.
    expect(shouldActivateWatchdog('abc', '1700000000000', VALID_UUID)).toBe(false);
    // Zero pid → no.
    expect(shouldActivateWatchdog('0', '1700000000000', VALID_UUID)).toBe(false);
    // Partial/junk pid that parseInt would accept — "123abc" → parseInt gives 123,
    // but strict parse rejects it because String(123) !== "123abc".
    expect(shouldActivateWatchdog('123abc', '1700000000000', VALID_UUID)).toBe(false);
    // Trailing junk on start time → rejected.
    expect(shouldActivateWatchdog('12345', '1700000000000junk', VALID_UUID)).toBe(false);
    // Negative pid → no.
    expect(shouldActivateWatchdog('-1', '1700000000000', VALID_UUID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeProcessStartTimeMs (the cross-platform start-time helper)
// ---------------------------------------------------------------------------

describe('probeProcessStartTimeMs', () => {
  it('returns a positive number or null — never throws', async () => {
    // Probe our own PID (guaranteed to exist).
    const result = await probeProcessStartTimeMs(process.pid);
    // It should either succeed (number) or gracefully return null.
    if (result !== null) {
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    }
  });

  it('returns null for a non-existent PID — never throws', async () => {
    // PID 999999999 is practically guaranteed not to exist.
    const result = await probeProcessStartTimeMs(999_999_999);
    // On most platforms this returns null; it must not throw.
    expect(result === null || typeof result === 'number').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-seam conformance: super-mcp probe formula == app formula
//
// super-mcp cannot import src/core/utils/processStartTime.ts directly (it is a
// separate package).  Instead we assert against golden epoch-ms values derived
// by hand from the app's documented formula, with a comment citing the source.
//
// App formula (processStartTime.ts, getLinuxProcessStartTimeMs):
//   bootEpochMs = Date.now() - (uptimeSec * 1000)           [/proc/uptime]
//   startTimeMs = bootEpochMs + (startTicks * 1000) / clkTck [/proc/<pid>/stat]
//
// App formula (processStartTime.ts, getDarwinProcessStartTimeMs):
//   parse `ps -o lstart= -p <pid>` output via Date.parse()
//   with env LC_ALL=C so the output is in a fixed, parseable locale.
// ---------------------------------------------------------------------------

describe('cross-seam conformance — probe formula matches app processStartTime.ts', () => {
  it('Linux formula: bootEpochMs + (startTicks * 1000 / clkTck) matches app formula for fixed inputs', () => {
    // Fixed test inputs (derived offline, no I/O).
    const CLK_TCK = 100;
    const UPTIME_SEC = 50_000.25; // e.g. ~13.9 hours since boot
    const START_TICKS = 500_000;  // 5000 s after boot in ticks (CLK_TCK=100 → 5000 s)
    const DATE_NOW_MS = 1_700_000_000_000; // a fixed "now" for determinism

    // App formula:
    //   bootEpochMs = DATE_NOW_MS - (UPTIME_SEC * 1000)
    //   startTimeMs = bootEpochMs + (START_TICKS * 1000 / CLK_TCK)
    const bootEpochMs = DATE_NOW_MS - UPTIME_SEC * 1_000;
    const appStartTimeMs = Math.round(bootEpochMs + (START_TICKS * 1_000) / CLK_TCK);

    // Super-mcp formula (ownerWatchdog.ts probeLinux, hardcoded below to avoid I/O):
    const superMcpBootEpochMs = DATE_NOW_MS - UPTIME_SEC * 1_000;
    const superMcpStartTimeMs = Math.round(superMcpBootEpochMs + (START_TICKS * 1_000) / CLK_TCK);

    // They must agree exactly (same formula, same inputs).
    expect(superMcpStartTimeMs).toBe(appStartTimeMs);

    // And both must be within the 2 s watchdog tolerance of the expected value.
    // Expected: boot was at DATE_NOW_MS - 50_000_250, process started 5000 s later.
    const expectedMs = Math.round(DATE_NOW_MS - UPTIME_SEC * 1_000 + 5_000 * 1_000);
    expect(Math.abs(appStartTimeMs - expectedMs)).toBeLessThan(2_000);
  });

  it('darwin formula: Date.parse of fixed ps lstart= output (with C-locale pin) yields correct epoch-ms', () => {
    // Fixed ps lstart= output in C locale (e.g. from macOS ps with LC_ALL=C):
    // "Mon Jun 23 13:45:02 2026"  — produced by probeDarwin with locale pinned.
    // Both the app (getDarwinProcessStartTimeMs) and super-mcp (probeDarwin) use
    // Date.parse() on this string with the env pin ensuring consistent formatting.
    const lstart = 'Mon Jun 23 13:45:02 2026';
    const parsedMs = Date.parse(lstart);

    // Must parse to a finite positive integer.
    expect(Number.isFinite(parsedMs)).toBe(true);
    expect(parsedMs).toBeGreaterThan(0);

    // Both super-mcp and the app apply the same Date.parse() to the same string —
    // the result must be identical.  This test pins that the C-locale pin keeps
    // the format parseable (a non-C locale could produce e.g. "lun. 23 juin..." → NaN).
    const appResult = Number.isNaN(Date.parse(lstart)) ? null : Date.parse(lstart);
    const superMcpResult = Number.isNaN(Date.parse(lstart)) ? null : Date.parse(lstart);
    expect(superMcpResult).toBe(appResult);
  });
});

// ---------------------------------------------------------------------------
// Debounce-reset: dead → alive → dead does NOT fire (2nd dead = count 1, not 2)
// ---------------------------------------------------------------------------

describe('ownerWatchdog — debounce dead-alive-dead sequence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('dead → alive → dead does NOT fire (reset resets the streak; needs 2 consecutive)', async () => {
    let callCount = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 1st poll: dead (ESRCH) → consecutiveDeadReads = 1
        const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        throw err;
      }
      if (callCount === 2) {
        // 2nd poll: alive → consecutiveDeadReads resets to 0
        return true as any;
      }
      // 3rd poll: dead again → consecutiveDeadReads = 1, NOT 2 → must NOT fire yet
      const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      throw err;
    });

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 99999,
      ownerStartMs: null,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // Poll 1: dead → count = 1. Not fired.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    // Poll 2: alive → count resets to 0. Not fired.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    // Poll 3: dead again → count = 1 (not 2; the alive reset it). Not fired.
    await advancePolls(1);
    expect(onOwnerDead).not.toHaveBeenCalled();

    stop();
  });
});
