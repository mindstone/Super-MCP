import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';

type EnvSnapshot = {
  version: string;
  mcpWorkspacePath: string | null;
  rebelWorkspacePath: string | null;
  customMarker: string | null;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', 'workspace-env-mcp-server.mjs');

let originalRebelWorkspacePath: string | undefined;
let originalMcpWorkspacePath: string | undefined;
let lastKnownPid: number | null = null;

function restoreWorkspaceEnv() {
  if (originalRebelWorkspacePath === undefined) {
    delete process.env.REBEL_WORKSPACE_PATH;
  } else {
    process.env.REBEL_WORKSPACE_PATH = originalRebelWorkspacePath;
  }

  if (originalMcpWorkspacePath === undefined) {
    delete process.env.MCP_WORKSPACE_PATH;
  } else {
    process.env.MCP_WORKSPACE_PATH = originalMcpWorkspacePath;
  }
}

function createFixtureClient(env: Record<string, string>) {
  return new StdioMcpClient('workspace-env-fixture', {
    id: 'workspace-env-fixture',
    name: 'Workspace Env Fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env,
    visibility: 'default',
  });
}

function captureSubprocessPid(client: StdioMcpClient): number {
  const pid = (client as any).transport?.pid;
  if (typeof pid !== 'number') {
    throw new Error('Failed to capture subprocess PID from StdioMcpClient transport.');
  }
  return pid;
}

function parseSnapshot(result: any): EnvSnapshot {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Expected MCP tool response with content[0].text.');
  }
  return JSON.parse(text) as EnvSnapshot;
}

describe('StdioMcpClient real-subprocess workspace env integration', () => {
  beforeEach(() => {
    originalRebelWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    originalMcpWorkspacePath = process.env.MCP_WORKSPACE_PATH;
    lastKnownPid = null;
  });

  afterEach(() => {
    restoreWorkspaceEnv();

    if (lastKnownPid !== null) {
      try {
        process.kill(lastKnownPid, 0);
        process.kill(lastKnownPid, 'SIGKILL');
        throw new Error(`Leaked workspace-env fixture subprocess detected (pid: ${lastKnownPid}).`);
      } catch (e: any) {
        if (e.code !== 'ESRCH') {
          throw e;
        }
      }
    }
  });

  it(
    'happy path — parent REBEL_WORKSPACE_PATH propagates to child as MCP_WORKSPACE_PATH; REBEL_ not leaked; catalog env passes through',
    { timeout: 5000 },
    async () => {
      process.env.REBEL_WORKSPACE_PATH = '/test-workspace/d17-happy';
      delete process.env.MCP_WORKSPACE_PATH;

      const client = createFixtureClient({
        CUSTOM_MARKER: 'd17-marker-value',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d17-happy');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d17-marker-value');
      } finally {
        if (lastKnownPid === null) {
          // Best-effort PID capture if connect() hung/timed out before line above set it.
          // Closes the behavioral-safety gap: a hung connect() would otherwise leave afterEach blind.
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        try {
          await client.close();
          // Clean close succeeded → killProcessTree() + SDK close ran. Trust the contract;
          // don't probe the PID (avoids the OS-reaper race where kill(pid, 0) can report alive
          // for a milliseconds-old zombie). If close() threw, lastKnownPid stays set and afterEach
          // still probes for a genuine leak.
          lastKnownPid = null;
        } catch (closeError) {
          throw closeError;
        }
      }
    },
  );

  it(
    "router-over-catalog precedence — catalog's MCP_WORKSPACE_PATH is overridden by parent-derived value",
    { timeout: 5000 },
    async () => {
      delete process.env.REBEL_WORKSPACE_PATH;
      process.env.MCP_WORKSPACE_PATH = '/test-workspace/d17-parent-mcp';

      const client = createFixtureClient({
        MCP_WORKSPACE_PATH: '/catalog-value-should-lose',
        CUSTOM_MARKER: 'd17-router-wins',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d17-parent-mcp');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d17-router-wins');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        try {
          await client.close();
          lastKnownPid = null;
        } catch (closeError) {
          throw closeError;
        }
      }
    },
  );
});

describe('PackageRegistry workspace file execution in a real subprocess', () => {
  it.each(['absolute cwd', 'relative cwd', 'no workspace', 'absolute input', 'missing workspace unrelated call'])('preserves launch and input behavior: %s', async scenario => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-launch-'));
    const install = path.join(root, 'install');
    const explicit = path.join(install, 'connector');
    const workspace = path.join(root, 'workspace');
    const hasCwd = scenario.endsWith('cwd');
    const childCwd = hasCwd ? explicit : install;
    const rawPath = 'General/report.txt';
    for (const [dir, bytes] of [[install, 'installation bytes'], [explicit, 'explicit bytes'], [workspace, 'workspace bytes']]) {
      await mkdir(path.join(dir, 'General'), { recursive: true });
      await writeFile(path.join(dir, rawPath), bytes);
    }
    // A relative launch script must still be found from the original child cwd.
    await writeFile(path.join(childCwd, 'launch.mjs'), `import ${JSON.stringify(new URL('./fixtures/workspace-env-mcp-server.mjs', import.meta.url).href)};`);
    const file = scenario === 'absolute input' ? `${install}${path.sep}General${path.sep}..${path.sep}General${path.sep}report.txt` : rawPath;
    const cwd = scenario === 'absolute cwd' ? explicit : scenario === 'relative cwd' ? 'connector' : undefined;
    const unrelated = scenario === 'missing workspace unrelated call';
    const script = `
      import { PackageRegistry } from ${JSON.stringify(new URL('../dist/registry.js', import.meta.url).href)};
      import assert from 'node:assert/strict';
      const registry = new PackageRegistry({ mcpServers: { fixture: {
        command: process.execPath, args: ['./launch.mjs'], cwd: ${JSON.stringify(cwd)},
      } } });
      const args = Object.freeze(${JSON.stringify(unrelated ? {} : { file })});
      const original = structuredClone(args);
      try {
        const result = await registry.callTool('fixture', ${JSON.stringify(unrelated ? 'get-env-snapshot' : 'read-file')}, args, { kind: 'standalone' });
        assert.deepStrictEqual(args, original);
        process.stdout.write(JSON.stringify({ result, original: args, routerPid: process.pid }));
      } finally { await registry.closeAll(); }
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.REBEL_WORKSPACE_PATH; delete env.MCP_WORKSPACE_PATH;
    if (scenario !== 'no workspace') env.MCP_WORKSPACE_PATH = unrelated ? path.join(root, 'missing') : workspace;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: install, env, timeout: 10000 });
      const { result, original, routerPid } = JSON.parse(stdout);
      expect(result.isError).not.toBe(true);
      const receipt = JSON.parse(result.content[0].text);
      if (unrelated) {
        expect(receipt.version).toBe('d17-fixture-v1');
        return;
      }
      expect(receipt.cwd).toBe(await realpath(childCwd));
      expect(receipt.pid).toEqual(expect.any(Number));
      expect(receipt.pid).not.toBe(routerPid);
      expect(receipt.reads).toBe(1);
      expect(receipt.file).toBe(file);
      expect(original).toEqual({ file });
      expect(receipt.bytes).toBe(hasCwd ? 'explicit bytes' : 'installation bytes');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it('reads workspace bytes on the first relative call without changing child cwd or original arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-workspace-'));
    const install = path.join(root, 'install');
    const workspace = path.join(root, 'workspace');
    const rawPath = 'General/report.txt';
    for (const [dir, bytes] of [[install, 'installation bytes'], [workspace, 'workspace bytes']]) {
      await mkdir(path.join(dir, 'General'), { recursive: true });
      await writeFile(path.join(dir, rawPath), bytes);
    }
    // A separate router process supplies a distinct installation cwd without process.chdir().
    const script = `
      import { PackageRegistry } from ${JSON.stringify(new URL('../dist/registry.js', import.meta.url).href)};
      import assert from 'node:assert/strict';
      const registry = new PackageRegistry({ mcpServers: { fixture: {
        command: process.execPath, args: [${JSON.stringify(fixturePath)}],
      } } });
      const args = Object.freeze({ file: 'General/report.txt', literal: 'General/report.txt' });
      const original = structuredClone(args);
      try {
        const result = await registry.callTool('fixture', 'read-file', args, { kind: 'standalone' });
        assert.deepStrictEqual(args, original);
        process.stdout.write(JSON.stringify({ result, original: args, routerPid: process.pid }));
      } finally { await registry.closeAll(); }
    `;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        cwd: install, timeout: 10000,
        env: { ...process.env, HOME: root, USERPROFILE: root, REBEL_WORKSPACE_PATH: workspace, MCP_WORKSPACE_PATH: workspace },
      });
      const { result, original, routerPid } = JSON.parse(stdout);
      expect(result.isError).not.toBe(true);
      const receipt = JSON.parse(result.content[0].text);
      expect(receipt.cwd).toBe(await realpath(install));
      expect(receipt.pid).toEqual(expect.any(Number));
      expect(receipt.pid).not.toBe(routerPid);
      expect(receipt.reads).toBe(1);
      expect(original).toEqual({ file: rawPath, literal: rawPath });
      expect(receipt.literal).toBe(rawPath);
      expect(receipt.bytes).toBe('workspace bytes');
      expect(receipt.file).toBe(path.join(workspace, rawPath));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
});
