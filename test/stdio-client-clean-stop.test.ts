/**
 * StdioMcpClient.close() stops a connector cleanly: it closes the child's stdin,
 * gives it CLEAN_STOP_GRACE_MS to tidy up and exit, then kills whatever is left
 * of the process tree it read beforehand. Also covers holdsLiveState(), which
 * keeps a keep-alive connector from being idle-reaped once it has been used.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEAN_STOP_GRACE_MS, StdioMcpClient } from '../src/clients/stdioClient.js';
import type { PackageConfig } from '../src/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'clean-stop-mcp-server.mjs');

let dir: string;
const strays: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeClient(mode: 'tidy' | 'stubborn' | 'orphaning', marker: string): StdioMcpClient {
  const config: PackageConfig = {
    id: `clean-stop-${mode}`,
    name: 'Clean stop fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, mode, marker],
    visibility: 'default',
  };
  return new StdioMcpClient(config.id, config);
}

function rootPid(client: StdioMcpClient): number {
  const pid = (client as unknown as { transport: { pid: number | null } }).transport.pid;
  if (!pid) throw new Error('connector did not start');
  strays.push(pid);
  return pid;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'super-mcp-clean-stop-'));
});

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('StdioMcpClient clean stop', () => {
  it('lets a connector that exits on stdin end tidy up before any kill', async () => {
    const marker = path.join(dir, 'tidied');
    const client = makeClient('tidy', marker);
    await client.connect();
    const pid = rootPid(client);

    const started = Date.now();
    await client.close();

    expect(readFileSync(marker, 'utf8')).toBe('tidied');
    expect(Date.now() - started).toBeLessThan(CLEAN_STOP_GRACE_MS);
    expect(isAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'kills a connector that ignores stdin end, and its children, after the grace',
    async () => {
      const marker = path.join(dir, 'child-pid');
      const client = makeClient('stubborn', marker);
      await client.connect();
      const pid = rootPid(client);
      const childPid = Number(readFileSync(marker, 'utf8'));
      strays.push(childPid);
      expect(isAlive(childPid)).toBe(true);

      const started = Date.now();
      await client.close();

      expect(Date.now() - started).toBeGreaterThanOrEqual(CLEAN_STOP_GRACE_MS - 50);
      expect(isAlive(pid)).toBe(false);
      // SIGKILL delivery is asynchronous; allow the kernel a moment to reap.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isAlive(childPid)).toBe(false);
    },
  );
});

describe('StdioMcpClient clean stop, children left behind', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a child the connector leaves behind when it exits within the grace',
    async () => {
      const marker = path.join(dir, 'orphan-pid');
      const client = makeClient('orphaning', marker);
      await client.connect();
      rootPid(client);
      const childPid = Number(readFileSync(marker, 'utf8'));
      strays.push(childPid);

      const started = Date.now();
      await client.close();
      expect(Date.now() - started).toBeLessThan(CLEAN_STOP_GRACE_MS);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isAlive(childPid)).toBe(false);
    },
  );
});

describe('StdioMcpClient.holdsLiveState', () => {
  it('is false until a keep-alive connector serves a tool call, then true', async () => {
    const client = makeClient('tidy', path.join(dir, 'tidied'));
    await client.connect();
    rootPid(client);

    expect(client.holdsLiveState()).toBe(false);
    await client.callTool('ping', {});
    expect(client.holdsLiveState()).toBe(true);

    await client.close();
  });

  it('stays false for a connector that does not declare keep-alive', async () => {
    const marker = path.join(dir, 'child-pid');
    const client = makeClient('stubborn', marker);
    await client.connect();
    rootPid(client);
    if (existsSync(marker)) strays.push(Number(readFileSync(marker, 'utf8')));

    await client.callTool('ping', {});
    expect(client.holdsLiveState()).toBe(false);

    await client.close();
  });
});
