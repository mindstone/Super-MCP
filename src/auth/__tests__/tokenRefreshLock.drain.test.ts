import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withTokenRefreshLock,
  drainInFlightTokenRefreshes,
  beginTokenRefreshShutdown,
  isTokenRefreshShutdownStarted,
  __resetTokenRefreshShutdownForTests,
  TokenRefreshShutdownError,
} from "../tokenRefreshLock.js";

// Suppress logger output during tests.
vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

/**
 * FM6 drain (260706_mcp-oauth-fm6-graceful-drain): the router's shutdown() must
 * wait for any in-flight single-use refresh-token rotation to finish its atomic
 * persist before exiting. These tests exercise drainInFlightTokenRefreshes with
 * a caller-controlled gate so the timing is deterministic (no sleep races).
 */
describe("drainInFlightTokenRefreshes", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    // The shutdown flag is set-once by design; reset it so the shutdown test
    // doesn't leak into sibling suites that share this module singleton.
    __resetTokenRefreshShutdownForTests();
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function tokenFile(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `smcp-drain-${prefix}-`));
    dirs.push(dir);
    return join(dir, `${prefix}_tokens.json`);
  }

  it("waits for an in-flight refresh to complete (persist done) before returning", async () => {
    const file = await tokenFile("wait");
    let resolveWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    let workFinished = false;

    // Not awaited: the in-process chain is registered synchronously, so the
    // drain below will observe it as pending until we release the gate.
    const work = withTokenRefreshLock(`wait-${Date.now()}`, file, async () => {
      await gate;
      workFinished = true;
    });

    const drainPromise = drainInFlightTokenRefreshes(2000);
    // Release only after the drain has started waiting.
    resolveWork();
    const result = await drainPromise;

    expect(workFinished).toBe(true);
    expect(result.drained).toBe(true);
    expect(result.tracked).toBeGreaterThanOrEqual(1);
    await work;
  });

  it("returns drained:false when a refresh outlasts the budget (never hangs shutdown)", async () => {
    const file = await tokenFile("timeout");
    let resolveWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    const work = withTokenRefreshLock(`timeout-${Date.now()}`, file, async () => {
      await gate;
    });

    // Short budget; gate is still closed → the timeout must win.
    const result = await drainInFlightTokenRefreshes(30);
    expect(result.drained).toBe(false);
    expect(result.tracked).toBeGreaterThanOrEqual(1);

    // Cleanup: release and let the work settle so it doesn't leak.
    resolveWork();
    await work;
  });

  it("resolves promptly when no refresh is in flight", async () => {
    // Settled chains from prior tests resolve immediately, so this must not hang
    // regardless of tracked count.
    const result = await drainInFlightTokenRefreshes(1000);
    expect(result.drained).toBe(true);
  });

  // FM6 review F1: once shutdown has begun, a NEW refresh must be refused BEFORE
  // it presents a single-use token, so it can't start after the drain snapshot
  // and get interrupted mid-persist (re-opening FM6). Refusing pre-presentation
  // is fail-closed — the on-disk token is untouched and next launch succeeds.
  it("refuses to start a new refresh once shutdown has begun, without running the body", async () => {
    const file = await tokenFile("shutdown");
    expect(isTokenRefreshShutdownStarted()).toBe(false);

    beginTokenRefreshShutdown();
    expect(isTokenRefreshShutdownStarted()).toBe(true);

    let bodyRan = false;
    await expect(
      withTokenRefreshLock(`shutdown-${Date.now()}`, file, async () => {
        bodyRan = true;
      }),
    ).rejects.toBeInstanceOf(TokenRefreshShutdownError);

    // The body never ran → no token was presented/consumed.
    expect(bodyRan).toBe(false);
  });

  // FM6 review F2 invariant: when refresh B replaces A's map entry before A
  // settles, A's delete-on-settle callback must NOT delete B's still-pending
  // chain (it guards on marker identity). If it did, a drain snapshot taken
  // between A settling and B settling would miss B — silently dropping an
  // in-flight refresh. This locks the exact invariant a future edit could break.
  it("does not drop a newer in-flight refresh when the prior one settles (F2 replacement race)", async () => {
    const file = await tokenFile("replace");
    const pkg = `replace-${Date.now()}`;

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    // A registers its chain, then B queues behind A on the SAME package (B
    // replaces the map entry synchronously when withTokenRefreshLock is called).
    const workA = withTokenRefreshLock(pkg, file, async () => {
      await gateA;
    });
    const workB = withTokenRefreshLock(pkg, file, async () => {
      await gateB;
    });

    // Let A finish (and its delete-on-settle microtask run) while B is still
    // pending. B must remain tracked by the drain.
    releaseA();
    await workA;
    // Flush microtasks so A's settle→delete callback has a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    const draining = drainInFlightTokenRefreshes(2000);
    releaseB();
    const result = await draining;

    // B was still in flight → the drain must have tracked and awaited it.
    expect(result.drained).toBe(true);
    expect(result.tracked).toBeGreaterThanOrEqual(1);
    await workB;
  });
});
