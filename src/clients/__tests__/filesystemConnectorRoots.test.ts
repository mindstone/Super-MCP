import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PackageConfig } from '../../types.js';

const mocks = vi.hoisted(() => {
  const stderrListeners: Array<(chunk: Buffer | string) => void> = [];
  const transportCtor = vi.fn();
  const clientConnect = vi.fn().mockResolvedValue(undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    clientConnect,
    emitStderr: (chunk: Buffer | string) => {
      for (const listener of stderrListeners) listener(chunk);
    },
    logger,
    resetStderrListeners: () => {
      stderrListeners.length = 0;
    },
    stderrListeners,
    transportCtor,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mocks.clientConnect;
    close = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn();
    callTool = vi.fn();
    readResource = vi.fn();
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>()),
  StdioClientTransport: class MockStdioClientTransport {
    pid = 4321;
    onerror: ((error: Error) => void) | undefined;
    onclose: (() => void) | undefined;
    stderr = {
      on: (event: string, listener: (chunk: Buffer | string) => void) => {
        if (event === 'data') mocks.stderrListeners.push(listener);
      },
    };

    constructor(options: Record<string, unknown>) {
      mocks.transportCtor(options);
    }
  },
}));

vi.mock('../../logging.js', () => ({
  getLogger: () => mocks.logger,
}));

import { StdioMcpClient } from '../stdioClient.js';

const PKG = '@modelcontextprotocol/server-filesystem';
const requireFromTest = createRequire(import.meta.url);
const filesystemServerEntrypoint = requireFromTest.resolve(`${PKG}/dist/index.js`);
const originalEnv = {
  rebelWorkspace: process.env.REBEL_WORKSPACE_PATH,
  mcpWorkspace: process.env.MCP_WORKSPACE_PATH,
  rebelRoots: process.env.REBEL_ALLOWED_SYMLINK_ROOTS,
};

let fixtureRoot: string;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

type PendingRequest = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function restoreEnv(): void {
  if (originalEnv.rebelWorkspace === undefined) delete process.env.REBEL_WORKSPACE_PATH;
  else process.env.REBEL_WORKSPACE_PATH = originalEnv.rebelWorkspace;

  if (originalEnv.mcpWorkspace === undefined) delete process.env.MCP_WORKSPACE_PATH;
  else process.env.MCP_WORKSPACE_PATH = originalEnv.mcpWorkspace;

  if (originalEnv.rebelRoots === undefined) delete process.env.REBEL_ALLOWED_SYMLINK_ROOTS;
  else process.env.REBEL_ALLOWED_SYMLINK_ROOTS = originalEnv.rebelRoots;
}

function createDirectory(name: string): string {
  const directory = path.join(fixtureRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function createClient(command: string, args: string[], cwd?: string): StdioMcpClient {
  const config: PackageConfig = {
    id: 'filesystem-fixture',
    name: 'Filesystem Fixture',
    transport: 'stdio',
    command,
    args,
    visibility: 'default',
    ...(cwd ? { cwd } : {}),
  };
  const client = new StdioMcpClient(config.id, config);
  mocks.transportCtor.mockClear();
  mocks.resetStderrListeners();
  return client;
}

function getConstructedArgs(callIndex = 0): string[] {
  const options: unknown = mocks.transportCtor.mock.calls[callIndex]?.[0];
  if (!isRecord(options) || !Array.isArray(options.args) || !options.args.every((arg) => typeof arg === 'string')) {
    throw new Error('Expected transport construction options with a string args array.');
  }
  return options.args;
}

function rejectPending(pending: Map<number, PendingRequest>, error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    child.once('close', onClose);
  });
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.stdin.end();
  if (await waitForClose(child, 2_000)) return;

  child.kill('SIGKILL');
  if (!(await waitForClose(child, 2_000))) {
    throw new Error('Filesystem fixture subprocess did not close after SIGKILL.');
  }
}

/**
 * Drives the real upstream package over stdio. The router-construction tests
 * below prove our wiring; these tests separately prove the upstream containment
 * contract that wiring relies on.
 */
async function writeThroughConnector(
  args: string[],
  target: string,
): Promise<{ isError: boolean; text: string }> {
  const child = spawn(process.execPath, [filesystemServerEntrypoint, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, PendingRequest>();
  let stdoutBuffer = '';
  let stderrTail = '';

  const failPending = (error: Error) => rejectPending(pending, error);
  child.once('error', failPending);
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      failPending(
        new Error(`Filesystem fixture exited before replying (code=${code}, signal=${signal}).`),
      );
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4_096);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');
      if (!line) continue;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || typeof parsed.id !== 'number') continue;
        const request = pending.get(parsed.id);
        if (!request) continue;
        clearTimeout(request.timer);
        pending.delete(parsed.id);
        request.resolve(parsed);
      } catch {
        // Upstream may emit non-JSON startup output; only JSON-RPC frames matter.
      }
    }
  });

  const send = (id: number, method: string, params: unknown): Promise<JsonRpcResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${stderrTail}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const request = pending.get(id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(id);
          request.reject(error);
        },
      );
    });

  try {
    await send(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'filesystem-fixture', version: '0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const response = await send(2, 'tools/call', {
      name: 'write_file',
      arguments: { path: target, content: 'x' },
    });
    const result = response.result;
    if (!isRecord(result)) {
      throw new Error(`Expected a tools/call result object, received ${JSON.stringify(response)}.`);
    }
    return { isError: result.isError === true, text: JSON.stringify(result) };
  } finally {
    rejectPending(pending, new Error('Filesystem fixture request cancelled during cleanup.'));
    await closeChild(child);
  }
}

describe('filesystem connector allowed-directory supply', () => {
  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-roots-fixture-'));
  });

  beforeEach(() => {
    restoreEnv();
    delete process.env.REBEL_WORKSPACE_PATH;
    delete process.env.MCP_WORKSPACE_PATH;
    delete process.env.REBEL_ALLOWED_SYMLINK_ROOTS;
    mocks.clientConnect.mockReset().mockResolvedValue(undefined);
    mocks.transportCtor.mockClear();
    mocks.resetStderrListeners();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.debug.mockClear();
  });

  afterEach(() => {
    restoreEnv();
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  describe('router transport construction', () => {
    it.each([
      ['documented npx package', 'npx', ['-y', PKG]],
      ['versioned npx package', 'npx', ['--yes', `${PKG}@2026.7.10`]],
      ['direct binary', 'mcp-server-filesystem', []],
      ['resolved Node entrypoint', process.execPath, [filesystemServerEntrypoint]],
      [
        'npx package selection',
        'npx',
        [`--package=${PKG}`, '--', 'mcp-server-filesystem'],
      ],
    ])('appends defaults for a recognised %s invocation', async (_label, command, args) => {
      const suffix = command.replace(/[^a-z0-9]/gi, '-');
      const workspace = createDirectory(`workspace-${suffix}`);
      const declared = createDirectory(`declared-${suffix}`);
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, args);

      await client.connect();

      expect(getConstructedArgs()).toEqual([...args, workspace, declared]);
    });

    it('accepts an absolute npx command whose basename matches', async () => {
      const binDirectory = createDirectory('absolute-npx-bin');
      const command = path.join(binDirectory, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      fs.writeFileSync(command, '');
      const workspace = createDirectory('absolute-npx-workspace');
      const declared = createDirectory('absolute-npx-declared');
      const args = ['-y', PKG];
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, args);

      await client.connect();

      expect(getConstructedArgs()).toEqual([...args, workspace, declared]);
    });

    it('declines an absolute npx path that does not exist on disk', async () => {
      const command = path.join(createDirectory('absent-npx-bin'), 'npx');
      const workspace = createDirectory('absent-npx-workspace');
      const declared = createDirectory('absent-npx-declared');
      const args = ['-y', PKG];
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, args);

      await client.connect();

      // Every other lane proves identity from the disk; without the existence
      // check this lane would recognise a path on its basename alone.
      expect(getConstructedArgs()).toEqual(args);
    });

    it('resolves a relative Node command against the configured child cwd', async () => {
      const cwd = createDirectory('relative-node-cwd');
      const command = path.relative(cwd, fs.realpathSync(process.execPath));
      const workspace = createDirectory('relative-node-workspace');
      const declared = createDirectory('relative-node-declared');
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, [filesystemServerEntrypoint], cwd);

      await client.connect();

      expect(path.isAbsolute(command)).toBe(false);
      expect(getConstructedArgs()).toEqual([filesystemServerEntrypoint, workspace, declared]);
    });

    it('resolves a node_modules bin shim through the sibling stock package', async () => {
      const projectRoot = createDirectory('windows-shim-project');
      const nodeModules = path.join(projectRoot, 'node_modules');
      const binDirectory = path.join(nodeModules, '.bin');
      const packageDirectory = path.join(nodeModules, '@modelcontextprotocol', 'server-filesystem');
      fs.mkdirSync(binDirectory, { recursive: true });
      fs.mkdirSync(packageDirectory, { recursive: true });
      fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: PKG }));
      const command = path.join(binDirectory, 'mcp-server-filesystem.cmd');
      fs.writeFileSync(command, '');
      const workspace = createDirectory('windows-shim-workspace');
      const declared = createDirectory('windows-shim-declared');
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, []);

      await client.connect();

      expect(getConstructedArgs()).toEqual([workspace, declared]);
    });

    it('declines an absolute filesystem-binary lookalike outside the stock package', async () => {
      const commandDirectory = createDirectory('lookalike-filesystem-bin');
      const command = path.join(commandDirectory, 'mcp-server-filesystem');
      fs.writeFileSync(command, '');
      const declared = createDirectory('lookalike-filesystem-declared');
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(command, []);

      await client.connect();

      expect(getConstructedArgs()).toEqual([]);
      expect(JSON.stringify(mocks.transportCtor.mock.calls)).not.toContain(declared);
    });

    it.each([
      ['dash-prefixed directory', ['-y', PKG, '-data']],
      ['separator plus dash-prefixed directory', ['-y', PKG, '--', '-data']],
      ['ordinary directory', ['-y', PKG, 'relative-directory']],
    ])('leaves user argv byte-identical for a %s', async (_label, args) => {
      const suffix = _label.replace(/[^a-z0-9]/gi, '-');
      const workspace = createDirectory(`configured-workspace-${suffix}`);
      const declared = createDirectory(`configured-declared-${suffix}`);
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient('npx', args);

      await client.connect();

      expect(getConstructedArgs()).toEqual(args);
    });

    it('logs argument counts and stock identity without logging a configured directory', async () => {
      const configuredDirectory = createDirectory('configured-log-private');
      const args = ['-y', PKG, configuredDirectory];
      const client = createClient('npx', args);

      await client.connect();

      const logged = JSON.stringify([
        mocks.logger.info.mock.calls,
        mocks.logger.debug.mock.calls,
      ]);
      expect(logged).not.toContain(configuredDirectory);
      expect(mocks.logger.info).toHaveBeenCalledWith(
        'Connecting to stdio MCP',
        expect.objectContaining({
          command: 'npx',
          command_kind: 'npx',
          configured_argument_count: 3,
          filesystem_identity: 'recognized',
          filesystem_package: PKG,
        }),
      );
    });

    it('surfaces only the basename of a configured command path on connect failure', async () => {
      const commandDirectory = createDirectory('private-command-path');
      const command = path.join(commandDirectory, 'missing-connector');
      const client = createClient(command, []);
      mocks.clientConnect.mockRejectedValueOnce(new Error('spawn ENOENT'));

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      const logged = JSON.stringify([
        mocks.logger.info.mock.calls,
        mocks.logger.error.mock.calls,
      ]);
      expect(surfaced).toContain("Command not found: 'missing-connector'");
      expect(logged).toContain('missing-connector');
      expect(surfaced).not.toContain(commandDirectory);
      expect(logged).not.toContain(commandDirectory);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Failed to connect to stdio MCP',
        expect.objectContaining({ command: 'missing-connector' }),
      );
    });

    it('leaves an unrelated wrapper byte-identical and warns only once', async () => {
      const workspace = createDirectory('wrapper-workspace');
      const declared = createDirectory('wrapper-declared');
      const wrapper = path.join(fixtureRoot, 'unrelated-wrapper.mjs');
      const args = [wrapper, PKG];
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient(process.execPath, args);

      await client.connect();
      await client.connect();

      expect(getConstructedArgs(0)).toEqual(args);
      expect(getConstructedArgs(1)).toEqual(args);
      expect(JSON.stringify(mocks.transportCtor.mock.calls)).not.toContain(declared);
      const identityWarnings = mocks.logger.warn.mock.calls.filter(
        ([message]) => message === 'filesystem connector: invocation not recognised; allowed roots were not supplied',
      );
      expect(identityWarnings).toHaveLength(1);
    });

    it('does not claim an npm alias that resolves to another package', async () => {
      const declared = createDirectory('alias-declared');
      const alias = `${PKG}@npm:@example/not-filesystem@1.0.0`;
      const args = ['-y', alias];
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient('npx', args);

      await client.connect();

      expect(getConstructedArgs()).toEqual(args);
      expect(JSON.stringify(mocks.transportCtor.mock.calls)).not.toContain(declared);
    });

    it('drops malformed entries, keeps usable defaults, and warns with counts only', async () => {
      const workspace = createDirectory('partial-workspace');
      const declared = createDirectory('partial-declared');
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([
        declared,
        '..',
        '',
        '   ',
        'bad\0root',
        7,
      ]);
      const client = createClient('npx', ['-y', PKG]);

      await client.connect();

      expect(getConstructedArgs()).toEqual(['-y', PKG, workspace, declared]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'filesystem connector: unusable default roots were ignored',
        {
          package_id: 'filesystem-fixture',
          declared_root_count: 6,
          usable_declared_root_count: 1,
          workspace_root_count: 1,
          usable_workspace_root_count: 1,
          declared_roots_parseable: true,
        },
      );
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(declared);
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(workspace);
    });

    it('treats malformed JSON as unusable, retains a valid workspace, and warns', async () => {
      const workspace = createDirectory('malformed-json-workspace');
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = 'not-json';
      const client = createClient('npx', ['-y', PKG]);

      await client.connect();

      expect(getConstructedArgs()).toEqual(['-y', PKG, workspace]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'filesystem connector: unusable default roots were ignored',
        expect.objectContaining({
          declared_root_count: 0,
          usable_declared_root_count: 0,
          declared_roots_parseable: false,
        }),
      );
    });

    it('drops an invalid workspace while retaining valid declared roots', async () => {
      const declared = createDirectory('invalid-workspace-declared');
      process.env.REBEL_WORKSPACE_PATH = 'relative-workspace';
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient('npx', ['-y', PKG]);

      await client.connect();

      expect(getConstructedArgs()).toEqual(['-y', PKG, declared]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'filesystem connector: unusable default roots were ignored',
        expect.objectContaining({
          workspace_root_count: 1,
          usable_workspace_root_count: 0,
        }),
      );
    });

    it('fails closed before transport construction when no usable root remains', async () => {
      process.env.REBEL_WORKSPACE_PATH = 'relative-workspace';
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify(['..', '', 'bad\0root']);
      const client = createClient('npx', ['-y', PKG]);

      await expect(client.connect()).rejects.toThrow('no usable allowed directories');

      expect(mocks.transportCtor).not.toHaveBeenCalled();
      expect(mocks.clientConnect).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('does not place configured or inferred roots in logs or surfaced stderr', async () => {
      const workspace = createDirectory('redaction-workspace');
      const declared = createDirectory('redaction-declared');
      process.env.REBEL_WORKSPACE_PATH = workspace;
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declared]);
      const client = createClient('npx', ['-y', PKG]);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr(`Cannot access ${workspace} or ${declared}\n`);
        throw new Error(`Startup failed for ${workspace}`);
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      const logged = JSON.stringify([
        mocks.logger.info.mock.calls,
        mocks.logger.warn.mock.calls,
        mocks.logger.error.mock.calls,
        mocks.logger.debug.mock.calls,
      ]);
      for (const sensitivePath of [workspace, declared]) {
        expect(surfaced).not.toContain(sensitivePath);
        expect(logged).not.toContain(sensitivePath);
      }
      expect(surfaced).toContain('[filesystem root redacted]');
      expect(logged).toContain('[filesystem root redacted]');
    });

    it('redacts canonical diagnostics when an inferred root resolves through a symlink', async () => {
      const target = createDirectory('canonical-redaction-target');
      const declaredLink = path.join(fixtureRoot, 'canonical-redaction-link');
      fs.symlinkSync(target, declaredLink, process.platform === 'win32' ? 'junction' : 'dir');
      const canonicalRoot = fs.realpathSync(declaredLink);
      process.env.REBEL_ALLOWED_SYMLINK_ROOTS = JSON.stringify([declaredLink]);
      const client = createClient('npx', ['-y', PKG]);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr(`Cannot access ${canonicalRoot}\n`);
        throw new Error(`Startup failed for ${canonicalRoot}`);
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(canonicalRoot).not.toBe(declaredLink);
      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      const logged = JSON.stringify(mocks.logger.error.mock.calls);
      expect(surfaced).toContain('Cannot access [filesystem root redacted]');
      expect(surfaced).not.toContain(canonicalRoot);
      expect(logged).not.toContain(canonicalRoot);
    });

    it('redacts normalized forms of configured directories', async () => {
      const trailingSeparatorDirectory = createDirectory('normalized-trailing-separator');
      const whitespaceDirectory = createDirectory('normalized-whitespace');
      const quotedDirectory = createDirectory('normalized-quote');
      const configuredDirectories = [
        `${trailingSeparatorDirectory}${path.sep}`,
        `${whitespaceDirectory} `,
        `${quotedDirectory}\"`,
      ];
      const client = createClient('npx', ['-y', PKG, ...configuredDirectories]);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr(
          `Cannot access ${trailingSeparatorDirectory}, ${whitespaceDirectory}, ${quotedDirectory}\n`,
        );
        throw new Error(
          `Startup failed for ${trailingSeparatorDirectory}, ${whitespaceDirectory}, ${quotedDirectory}`,
        );
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(getConstructedArgs()).toEqual(['-y', PKG, ...configuredDirectories]);
      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      expect(surfaced).toContain(
        'Cannot access [filesystem root redacted], [filesystem root redacted], [filesystem root redacted]',
      );
      for (const sensitivePath of [trailingSeparatorDirectory, whitespaceDirectory, quotedDirectory]) {
        expect(surfaced).not.toContain(sensitivePath);
      }
    });

    it('redacts longer configured roots before a strict prefix', async () => {
      const prefixRoot = createDirectory('redaction-prefix');
      const longerRoot = path.join(prefixRoot, 'longer-root-segment');
      fs.mkdirSync(longerRoot);
      const client = createClient('npx', ['-y', PKG, prefixRoot, longerRoot]);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr(`Cannot access ${longerRoot}\n`);
        throw new Error(`Startup failed for ${longerRoot}`);
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      expect(surfaced).toContain('Cannot access [filesystem root redacted]');
      expect(surfaced).not.toContain('longer-root-segment');
    });

    it('redacts a configured directory carrying a leading quote or leading whitespace', async () => {
      const target = createDirectory('leading-junk-target');
      const args = ['-y', PKG, `"${target}"`, ` ${target}`];
      const client = createClient('npx', args);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr(`Cannot access directory ${target}, skipping\n`);
        throw new Error(`spawn failed for ${target}`);
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      // The raw forms fail path.isAbsolute, so without normalising before the
      // usability gate neither contributes a token and the path is surfaced whole.
      expect(getConstructedArgs()).toEqual(args);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      expect(surfaced).not.toContain(target);
      expect(surfaced).toContain('[filesystem root redacted]');
    });

    it('does not use unusable or filesystem-root arguments as redaction tokens', async () => {
      const args = ['-y', PKG, '/', '.'];
      const client = createClient('npx', args);
      mocks.clientConnect.mockImplementationOnce(async () => {
        mocks.emitStderr('Diagnostic path: /tmp/missing.file.\n');
        throw new Error('spawn ENOENT: /tmp/missing.file.');
      });

      let thrown: unknown;
      try {
        await client.connect();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(getConstructedArgs()).toEqual(args);
      expect(thrown).toBeInstanceOf(Error);
      const surfaced = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);
      expect(surfaced).toContain("Command not found: 'npx'");
      expect(surfaced).toContain('Diagnostic path: /tmp/missing.file.');
      expect(surfaced).not.toContain('[filesystem root redacted]');
    });
  });

  describe('real upstream containment', () => {
    it('refuses a write when no directory argument is supplied', async () => {
      const targetRoot = createDirectory('deny-no-root');
      const result = await writeThroughConnector([], path.join(targetRoot, 'note.md'));

      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside allowed directories');
    }, 30_000);

    it('writes directly into a supplied root', async () => {
      const targetRoot = createDirectory('direct-success');
      const target = path.join(targetRoot, 'note.md');
      const result = await writeThroughConnector([targetRoot], target);

      expect(result.isError).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
    }, 30_000);

    it('writes through a workspace symlink whose target is a declared root', async () => {
      const workspace = createDirectory('symlink-workspace');
      const declared = createDirectory('symlink-declared');
      const link = path.join(workspace, 'declared-space-link');
      fs.symlinkSync(declared, link, process.platform === 'win32' ? 'junction' : 'dir');
      const target = path.join(link, 'note.md');

      const result = await writeThroughConnector([workspace, declared], target);

      expect(result.isError).toBe(false);
      expect(fs.readFileSync(path.join(declared, 'note.md'), 'utf8')).toBe('x');
    }, 30_000);

    it('denies a symlink whose target is not a supplied root', async () => {
      const allowed = createDirectory('outside-link-allowed');
      const outside = createDirectory('outside-link-target');
      const link = path.join(allowed, 'outside-link');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

      const result = await writeThroughConnector([allowed], path.join(link, 'note.md'));

      expect(result.isError).toBe(true);
    }, 30_000);

    it('denies traversal above the supplied root', async () => {
      const traversalParent = createDirectory('traversal-parent');
      const allowed = path.join(traversalParent, 'allowed');
      fs.mkdirSync(allowed);

      const result = await writeThroughConnector(
        [allowed],
        path.join(allowed, '..', 'escaped.md'),
      );

      expect(result.isError).toBe(true);
      expect(fs.existsSync(path.join(traversalParent, 'escaped.md'))).toBe(false);
    }, 30_000);
  });
});
