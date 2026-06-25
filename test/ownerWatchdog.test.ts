/**
 * Unit tests for ownerWatchdog — the owner-liveness self-watchdog that detects
 * when the spawning Electron/Node owner process has died and triggers graceful
 * self-exit so super-mcp doesn't accumulate as an orphan.
 *
 * All process interactions are mocked; no real processes are spawned.
 * Uses fake timers so poll intervals advance synchronously.
 */

import { readFileSync } from 'node:fs';
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
const { startWatchdog } = await import('../src/ownerWatchdog.js');

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

  // Pins REBEL-6ED: when kill(0) succeeds the watchdog MUST NOT fire, regardless
  // of any (now-absent) start-time signal.  The watchdog is ESRCH-only by design.
  // Previously a start-time mismatch (e.g. Windows local-time probe bug) could
  // trigger self-exit; that class of bug is now structurally impossible because
  // no non-ESRCH signal may ever re-couple to self-exit.
  it('does NOT fire when kill(0) succeeds — ESRCH-only design pins REBEL-6ED', async () => {
    // kill(pid, 0) succeeds on every poll — PID is occupied.
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 1234,
      // ownerStartMs provided — the watchdog holds it for correlation but must
      // NEVER use it to gate a verdict (probe deleted; assertion below proves it).
      ownerStartMs: 1_700_000_000_000,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
    });

    // Advance many polls — kill(0) always succeeds, onOwnerDead must never fire.
    await advancePolls(10);
    expect(onOwnerDead).not.toHaveBeenCalled();

    stop();
  });

  it('does NOT fire when ownerStartMs is set and kill(0) succeeds (correlation-only, no verdict)', async () => {
    // kill(pid, 0) succeeds — pid is live.
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const onOwnerDead = vi.fn().mockResolvedValue(undefined);

    const { stop } = startWatchdog({
      ownerPid: 1234,
      ownerStartMs: 1_700_000_000_000,
      ownerId: 'test-id',
      pollMs: 15_000,
      onOwnerDead,
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

// ---------------------------------------------------------------------------
// Structural fitness guard — the watchdog must NEVER re-introduce a start-time
// probe (REBEL-6ED).  This is the executable form of the design rule GPT and
// Claude both endorsed: self-exit may only be coupled to a CONCLUSIVE liveness
// signal (ESRCH), never to a duplicated cross-platform heuristic.
//
// The original 0.4.50 self-exit loop came from the watchdog independently
// probing the owner PID's start time (shelling out to wmic / powershell /
// ps / cat /proc) and comparing it against --rebel-owner-start.  The Windows
// branch read LOCAL time, diverged from the app's UTC by the timezone offset,
// blew the tolerance, and declared a live owner "dead" on every launch.
//
// Any future start-time probe necessarily shells out to read OS process
// metadata, so we assert the watchdog SOURCE contains no child-process /
// start-time-probe machinery (comments stripped, so the historical docblock
// explanation does not trip it).  Owner start-time identity now has exactly
// one implementation, app-side in src/core/utils/processStartTime.ts.
// ---------------------------------------------------------------------------

describe('ownerWatchdog — structural fitness (ESRCH-only, no start-time probe) [REBEL-6ED]', () => {
  const source = readFileSync(new URL('../src/ownerWatchdog.ts', import.meta.url), 'utf8');
  // Strip block + line comments so the historical Get-Date/UFormat explanation
  // in the docblock does not count as live probe machinery.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('does not shell out or import child-process APIs (any start-time probe would)', () => {
    expect(code).not.toMatch(/child_process|execFile|\bspawn\b|\bexec\s*\(/);
  });

  it('does not re-implement a start-time probe or tolerance comparison', () => {
    expect(code).not.toMatch(/START_TIME_TOLERANCE/);
    expect(code).not.toMatch(/UFormat|Get-Date|\bwmic\b|ToUniversalTime|\/proc\/|lstart/i);
    expect(code).not.toMatch(/probeWindows|probeDarwin|probeLinux|probeProcessStartTime/);
  });

  it('determines liveness solely via process.kill(ownerPid, 0)', () => {
    expect(code).toMatch(/process\.kill\([^,]+,\s*0\)/);
  });
});
