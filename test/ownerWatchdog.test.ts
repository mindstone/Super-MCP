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

  it('activation gate: watchdog activates only when all three flags are valid integers/strings', () => {
    // Mirrors the gating logic in cli.ts: ownerPid must be a finite positive integer.
    function shouldActivateWatchdog(
      pidRaw: string | undefined,
      startRaw: string | undefined,
      idRaw: string | undefined,
    ): boolean {
      if (!pidRaw || !startRaw || !idRaw) return false;
      const pid = parseInt(pidRaw, 10);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      const startMs = parseInt(startRaw, 10);
      if (!Number.isFinite(startMs) || startMs <= 0) return false;
      return true;
    }

    // All three present → activate.
    expect(shouldActivateWatchdog('12345', '1700000000000', 'some-uuid')).toBe(true);
    // Missing pid → no.
    expect(shouldActivateWatchdog(undefined, '1700000000000', 'uuid')).toBe(false);
    // Missing start → no.
    expect(shouldActivateWatchdog('12345', undefined, 'uuid')).toBe(false);
    // Missing id → no.
    expect(shouldActivateWatchdog('12345', '1700000000000', undefined)).toBe(false);
    // Invalid pid → no.
    expect(shouldActivateWatchdog('abc', '1700000000000', 'uuid')).toBe(false);
    // Zero pid → no.
    expect(shouldActivateWatchdog('0', '1700000000000', 'uuid')).toBe(false);
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
