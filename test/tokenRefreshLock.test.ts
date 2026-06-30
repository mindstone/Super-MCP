import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => mockLogger,
}));

import {
  withTokenRefreshLock,
  TokenRefreshLockBusyError,
  TokenRefreshLockCompromisedError,
  TokenRefreshLockError,
} from "../src/auth/tokenRefreshLock.js";

// ---------------------------------------------------------------------------
// MA3 — REAL coverage for the cross-process lock primitive (tokenRefreshLock.ts).
//
// The FM1/FM3 race tests run both "processes" in ONE OS process and share the
// SAME packageId, so they serialize on the in-process mutex (keyed by packageId)
// and NEVER contend on proper-lockfile. These tests exercise the actual
// proper-lockfile layer two ways:
//
//   1) In-process, BYPASSING the mutex: two acquirers with DIFFERENT packageIds
//      but the SAME tokenFilePath. The in-process mutex (per packageId) does not
//      serialize them, so they genuinely race for the on-disk lock. This covers
//      busy/contention, stale-holder break, compromised hard-fail, and the
//      infrastructure-vs-busy classification — all against the real lockfile.
//
//   2) A genuine SECOND OS PROCESS (child_process) that holds the file lock while
//      the parent tries to acquire it — the gold-standard cross-process test,
//      proving the lock is honoured across process boundaries (not just within
//      one event loop).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("tokenRefreshLock — cross-process lock primitive (MA3)", () => {
  let tempDir: string;
  let tokenFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-lock-"));
    tokenFile = path.join(tempDir, "pkg_tokens.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("serializes two contenders on the SAME token-file path (different packageIds bypass the in-process mutex)", async () => {
    const order: string[] = [];
    let overlap = false;
    let active = 0;

    const body = (name: string) => async () => {
      active += 1;
      if (active > 1) overlap = true;
      order.push(`${name}:start`);
      await sleep(50);
      order.push(`${name}:end`);
      active -= 1;
    };

    // Different packageIds → different in-process mutex chains → genuine
    // proper-lockfile contention on the shared tokenFile.
    const [a, b] = await Promise.allSettled([
      withTokenRefreshLock("pkgA", tokenFile, body("A")),
      withTokenRefreshLock("pkgB", tokenFile, body("B")),
    ]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    // The on-disk lock must have prevented overlapping critical sections.
    expect(overlap).toBe(false);
    // Each ran to completion without interleaving.
    expect(order).toEqual(
      expect.arrayContaining(["A:start", "A:end", "B:start", "B:end"]),
    );
  });

  it("throws TokenRefreshLockBusyError when contention exceeds a tightened retry budget", async () => {
    let releaseHeld!: () => void;
    const heldUntil = new Promise<void>((r) => {
      releaseHeld = r;
    });

    // Holder keeps the lock; contender gets a 0-retry budget so it fails fast.
    const holder = withTokenRefreshLock("holder", tokenFile, async () => {
      await heldUntil;
    });

    // Give the holder a moment to acquire.
    await sleep(20);

    await expect(
      withTokenRefreshLock("contender", tokenFile, async () => "unreachable", {
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(TokenRefreshLockBusyError);

    releaseHeld();
    await holder;
  });

  it("TokenRefreshLockBusyError is marked retryable; TokenRefreshLockError is not", () => {
    expect(new TokenRefreshLockBusyError("p").retryable).toBe(true);
    expect(new TokenRefreshLockError("p").retryable).toBe(false);
  });

  it("breaks a STALE lock left by a crashed holder (proper-lockfile stale window)", async () => {
    // Simulate a crashed holder: create the .lock dir with an old mtime so it is
    // past the stale window, then acquire with a short stale setting.
    const lockDir = `${tokenFile}.lock`;
    await fs.writeFile(tokenFile, "");
    await fs.mkdir(lockDir);
    // Backdate the lock dir well beyond the (tiny) stale window.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);

    let ran = false;
    await withTokenRefreshLock(
      "afterCrash",
      tokenFile,
      async () => {
        ran = true;
      },
      { staleMs: 1_000 },
    );
    expect(ran).toBe(true);
  });

  it("hard-fails via assertLockHealthy when the .lock dir disappears mid-section (compromised)", async () => {
    const lockDir = `${tokenFile}.lock`;

    await expect(
      withTokenRefreshLock("compromise", tokenFile, async (assertLockHealthy) => {
        // Lock acquired; now simulate the lock being broken out from under us.
        await fs.rm(lockDir, { recursive: true, force: true });
        assertLockHealthy(); // must throw — the lock dir is gone
        return "should-not-reach";
      }),
    ).rejects.toBeInstanceOf(TokenRefreshLockCompromisedError);
  });

  it("classifies an infrastructural failure (lock target path not creatable) as TokenRefreshLockError, not busy", async () => {
    // Make the would-be parent directory a FILE so creating the lock target
    // (mkdir + writeFile) fails with ENOTDIR/EEXIST — an infrastructure error,
    // not contention.
    const asFile = path.join(tempDir, "blocker");
    await fs.writeFile(asFile, "x");
    const impossibleTokenFile = path.join(asFile, "nested", "pkg_tokens.json");

    await expect(
      withTokenRefreshLock("infra", impossibleTokenFile, async () => "unreachable"),
    ).rejects.toBeInstanceOf(TokenRefreshLockError);
  });

  // Spawns a real child process and waits up to 10s for it to confirm it holds
  // the lock, so it needs a per-test timeout comfortably above vitest's 5s
  // default (otherwise the inner 10s child wait can never elapse). 20s gives the
  // child time to boot + lock + release on a slow/loaded CI machine.
  it("GOLD STANDARD: honours a lock held by a SECOND OS process", async () => {
    await fs.writeFile(tokenFile, "");

    // Resolve proper-lockfile's entry point from THIS package and import it into
    // the child by ABSOLUTE file:// URL. A bare `import 'proper-lockfile'` in the
    // child would resolve relative to the child SCRIPT's directory (the temp dir,
    // which has no node_modules) — Node's ESM resolver ignores `cwd` for bare
    // specifiers — so the child would crash before locking and the parent would
    // time out waiting for LOCKED. Resolving here (where resolution works) and
    // injecting the absolute path makes the spawn robust regardless of where the
    // temp script lives.
    const requireFromTest = createRequire(import.meta.url);
    const properLockfileUrl = pathToFileURL(
      requireFromTest.resolve("proper-lockfile"),
    ).href;

    // Spawn a child that acquires the proper-lockfile on the same path and holds
    // it until told to release (via stdin), printing LOCKED when held. On any
    // import/lock failure it prints CHILD_ERR + the message to stderr and exits
    // non-zero, so the parent surfaces a real diagnosis instead of a bare timeout.
    const childScript = `
      try {
        const properLockfile = (await import(${JSON.stringify(properLockfileUrl)})).default;
        const file = process.argv[2];
        const release = await properLockfile.lock(file, { realpath: false, stale: 90000 });
        process.stdout.write('LOCKED\\n');
        process.stdin.resume();
        process.stdin.on('data', async () => { await release(); process.exit(0); });
      } catch (err) {
        process.stderr.write('CHILD_ERR ' + (err && err.message ? err.message : String(err)) + '\\n');
        process.exit(1);
      }
    `;
    const childPath = path.join(tempDir, "child-lock.mjs");
    await fs.writeFile(childPath, childScript);

    const child = spawn(process.execPath, [childPath, tokenFile], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    // Wait for the child to confirm it holds the lock. If the child exits before
    // printing LOCKED (e.g. an import/lock failure), reject immediately with its
    // exit code rather than waiting out the whole timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not lock in time")), 10_000);
      child.stdout.on("data", (buf: Buffer) => {
        if (buf.toString().includes("LOCKED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`child exited (code ${code}) before acquiring the lock`));
        }
      });
    });

    // Parent cannot acquire while the OTHER PROCESS holds it (fast budget → busy).
    await expect(
      withTokenRefreshLock("parent", tokenFile, async () => "unreachable", { retries: 0 }),
    ).rejects.toBeInstanceOf(TokenRefreshLockBusyError);

    // Release the child, then the parent can acquire.
    child.stdin.write("release\n");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    let ran = false;
    await withTokenRefreshLock("parent", tokenFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  }, 20000);
});
