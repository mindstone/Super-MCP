/**
 * Stage 4 / B1: per-package connect diagnostics for stdio MCP clients.
 *
 * The Brave Search `-32000 Connection closed` failure could not be diagnosed
 * because the connector child's stderr was INHERITED, not captured, and the
 * thrown connect-failure error carried no spawn/exit signal. These tests pin
 * the new behaviour in StdioMcpClient.connect():
 *
 *   1. Real-subprocess: a child that writes to stderr then exits non-zero has
 *      its stderr captured and surfaced on the thrown error (message + data),
 *      and the spawn/close markers are set. (RED before the change: stderr was
 *      inherited/uncaptured, so the error contained no `boom-diagnostic`.)
 *   2. The "spawn-observed-this-call" marker distinguishes a fresh child that
 *      spawned then died from a transport that never spawned a child this call.
 *   3. The stderr ring buffer is bounded (line cap) — a chatty child cannot
 *      grow unbounded memory, and we retain the most-recent (most diagnostic)
 *      lines.
 *
 * Reachability note: the installed @modelcontextprotocol/sdk (1.28.0) drops the
 * child's exit CODE in its onclose handler, so the numeric exit code is NOT
 * reachable through the public SDK API. We therefore assert the reachable
 * disambiguators (stderr tail + spawn/close-observed markers) rather than the
 * literal exit code 3.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import type { PackageConfig } from '../src/types.js';

let lastKnownPid: number | null = null;

function makeConfig(args: string[]): PackageConfig {
  return {
    id: 'stderr-probe',
    name: 'Stderr Probe',
    transport: 'stdio',
    command: process.execPath, // node; shell:false so no shell interpretation
    args,
    visibility: 'default',
  };
}

beforeEach(() => {
  lastKnownPid = null;
});

afterEach(() => {
  // PID leak sentinel (same pattern as the workspace integration tests).
  if (lastKnownPid !== null) {
    try {
      process.kill(lastKnownPid, 0);
      // If kill(pid, 0) did not throw, the child survived — kill it so the
      // test run doesn't leak processes, then fail loudly.
      try {
        process.kill(lastKnownPid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      throw new Error(`Child process ${lastKnownPid} survived connect failure`);
    } catch (err) {
      // ESRCH means the process is gone, which is what we want.
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        // Re-throw anything that isn't "no such process".
        if (err instanceof Error && err.message.includes('survived')) throw err;
      }
    }
  }
});

describe('StdioMcpClient connect diagnostics (B1)', () => {
  it('captures child stderr and surfaces it on the thrown connect error', async () => {
    // Child writes a marker to stderr, then exits non-zero. There is no MCP
    // handshake, so client.connect() rejects — and our diagnostics should have
    // captured the stderr.
    const client = new StdioMcpClient(
      'stderr-probe',
      makeConfig(['-e', "process.stderr.write('boom-diagnostic\\n'); process.exit(3)"]),
    );

    let thrown: unknown;
    try {
      await client.connect();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { data?: Record<string, unknown> };

    // The captured stderr tail must reach the surfaced error (message + data),
    // not just super-mcp's internal log.
    expect(error.message).toContain('boom-diagnostic');
    expect(client.getStderrTail()).toContain('boom-diagnostic');
    expect(error.data?.stderrTail).toContain('boom-diagnostic');

    // A real child spawned and died => spawn observed, and the close was seen.
    expect(error.data?.spawnObservedThisCall).toBe(true);
    expect(error.message).toContain('Child spawn observed this attempt: yes');

    // Exit code is not reachable via the installed SDK — documented limitation.
    expect(error.data?.childExitCode).toBeNull();
  });

  it('marks no spawn / no stderr when the command cannot start (ENOENT)', async () => {
    const client = new StdioMcpClient(
      'stderr-probe',
      // A command that does not exist => spawn 'error' (ENOENT), no stderr.
      {
        id: 'stderr-probe',
        name: 'Stderr Probe',
        transport: 'stdio',
        command: '/nonexistent/definitely-not-a-real-binary-xyz',
        args: [],
        visibility: 'default',
      },
    );

    let thrown: unknown;
    try {
      await client.connect();
    } catch (err) {
      thrown = err;
    }

    const error = thrown as Error & { data?: Record<string, unknown> };
    expect(error).toBeInstanceOf(Error);
    // No child stderr captured for a process that never started.
    expect(error.data?.stderrTail ?? null).toBeNull();
    // But the spawn 'error' (ENOENT) IS captured via transport.onerror.
    expect(error.data?.spawnError).toBeTruthy();
  });
});

describe('StdioMcpClient stderr ring buffer bounding', () => {
  it('keeps only the most recent lines under the line cap', async () => {
    // Emit far more than 50 lines, then exit non-zero. The captured tail must
    // be bounded and contain the LAST lines, not the first.
    // The last write carries the exit: `process.stderr.write` to a PIPE is
    // asynchronous, and `process.exit()` tears the process down without
    // flushing what is still queued — so a bare `exit(7)` after the loop
    // truncates the child's own output. Under `gate:ci` load on a 32-core box
    // the tail genuinely stopped at line-121/line-147: those lines were never
    // written, so no amount of waiting on the parent side could recover them.
    // Exiting from the final write's completion callback keeps the non-zero
    // exit this test needs while guaranteeing all 200 lines were handed over.
    const script =
      'for (let i = 0; i < 199; i++) { process.stderr.write("line-" + i + "\\n"); } ' +
      'process.stderr.write("line-199\\n", () => process.exit(7));';
    const client = new StdioMcpClient('stderr-probe', makeConfig(['-e', script]));

    try {
      await client.connect();
    } catch {
      /* expected */
    }

    // `connect()` can reject the moment the child exits, while the parent is
    // still draining its stderr pipe — the ring is filled from an async 'data'
    // handler, so a read taken right here can legitimately stop short of the
    // last line. Observed under `gate:ci` load on a 32-core box: the tail ended
    // at line-121 while the child had written through line-199. Waiting for the
    // drain does not weaken anything the assertions below check (bounding, and
    // that the retained window is the most RECENT one) — it only stops reading
    // mid-stream. If the line genuinely never arrives, the assertions still fail.
    let tail = client.getStderrTail();
    const drainDeadline = Date.now() + 2_000;
    while (!tail?.includes('line-199') && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      tail = client.getStderrTail();
    }

    expect(tail).not.toBeNull();
    const lines = (tail as string).split('\n').filter((l) => l.length > 0);
    // Bounded: at most 50 lines retained.
    expect(lines.length).toBeLessThanOrEqual(50);
    // Most-recent-retained: the very last emitted line is present, the first is not.
    expect(tail).toContain('line-199');
    expect(tail).not.toContain('line-0\n');
  });
});
