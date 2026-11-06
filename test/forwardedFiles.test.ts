import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectForwardedFiles, FORWARDED_FILES_RELATIVE_DIR, getWorkspacePath, MAX_FORWARDED_FILE_BYTES, runWithForwardedFiles } from '../src/forwardedFiles.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { PackageRegistry } from '../src/registry.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
let root: string, desktop: string, cloud: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'forwarded-files-'));
  desktop = path.join(root, 'desktop'); cloud = path.join(root, 'cloud');
  await fs.mkdir(desktop); await fs.mkdir(cloud);
  vi.stubEnv('REBEL_WORKSPACE_PATH', desktop);
  vi.stubEnv('MCP_WORKSPACE_PATH', cloud);
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  setSecurityPolicy(new SecurityPolicy({}));
  await fs.rm(root, { recursive: true, force: true });
});
async function write(relative: string, text = 'fictional file') {
  const file = path.join(desktop, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}
const entry = (name = 'report.txt') => ({ path: '/fictional/desktop/report.txt', name, contentBase64: Buffer.from('fictional bytes').toString('base64') });
function homeClient() {
  const client = new PackageHomeClient({ id: 'notebook', name: 'Fictional Notes', transport: 'stdio', visibility: 'default' }, { url: 'https://cloud.example.test/mcp' });
  const dispatch = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] });
  cleanup.push(() => client.close());
  return { client, dispatch };
}

describe('forwarded workspace files', () => {
  it('uses the same trimmed workspace precedence as subprocesses', () => {
    expect(getWorkspacePath()).toBe(desktop);
    vi.stubEnv('REBEL_WORKSPACE_PATH', '  ');
    vi.stubEnv('MCP_WORKSPACE_PATH', ` ${cloud} `);
    expect(getWorkspacePath()).toBe(cloud);
    vi.stubEnv('MCP_WORKSPACE_PATH', '');
    expect(getWorkspacePath()).toBeUndefined();
  });

  it('does no disk work for ordinary arguments and leaves non-file and substring paths alone', async () => {
    const source = await write('report.txt');
    const realpath = vi.spyOn(fs, 'realpath');
    expect(await collectForwardedFiles({ text: `See ${source}`, relative: 'report.txt' })).toEqual({ files: [], bytes: 0 });
    expect(realpath).not.toHaveBeenCalled();
    const stat = vi.spyOn(fs, 'lstat');
    expect((await collectForwardedFiles({ path: '/Documents/x' })).files).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    expect((await collectForwardedFiles({ directory: desktop, missing: path.join(desktop, 'missing') })).files).toEqual([]);
  });

  it('deduplicates repeated paths and swaps only exact matches, including text fields', async () => {
    const source = await write('report.txt', 'report bytes');
    const args = { attachments: [{ path: source }, { path: source }], note: source, text: `See ${source}` };
    const collected = await collectForwardedFiles(args);
    expect(collected.files).toHaveLength(1);
    expect(collected.bytes).toBe(12);
    const result = { providerId: 'fictional-id' };
    expect(await runWithForwardedFiles(args, collected.files, async received => {
      const actual = received as typeof args;
      const target = actual.attachments[0].path;
      expect(target).not.toBe(source);
      expect(actual.attachments[1].path).toBe(target);
      expect(actual.note).toBe(target);
      expect(actual.text).toBe(args.text);
      expect(await fs.readFile(target, 'utf8')).toBe('report bytes');
      if (process.platform !== 'win32') {
        expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(path.dirname(target)))).mode & 0o777).toBe(0o700);
      }
      return result;
    }, cloud)).toBe(result);
    expect(args.attachments[0].path).toBe(source);
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('keeps two files with the same basename distinct', async () => {
    const paths = [await write('one/report.txt', 'one'), await write('two/report.txt', 'two')];
    const { files } = await collectForwardedFiles(paths);
    await runWithForwardedFiles(paths, files, async received => {
      const targets = received as string[];
      expect(targets[0]).not.toBe(targets[1]);
      expect(targets.map(target => path.basename(target))).toEqual(['report.txt', 'report.txt']);
      expect(await Promise.all(targets.map(target => fs.readFile(target, 'utf8')))).toEqual(['one', 'two']);
    }, cloud);
  });

  it('refuses outside paths and symlink leaves or ancestors', async () => {
    const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'private');
    const source = await write('report.txt');
    await fs.symlink(outside, path.join(desktop, 'outside-link'));
    await fs.symlink(source, path.join(desktop, 'inside-link'));
    await fs.symlink(root, path.join(desktop, 'linked-folder'), 'dir');
    const args = [outside, path.join(desktop, 'outside-link'), path.join(desktop, 'inside-link'), path.join(desktop, 'linked-folder', 'outside.txt')];
    const { files } = await collectForwardedFiles(args);
    expect(files).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps warnings for real read errors without logging paths', async () => {
    const source = await write('report.txt');
    vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    expect((await collectForwardedFiles({ file_path: source })).files).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Forwarded file could not be read safely', { code: 'EACCES' });
  });

  it.skipIf(process.platform === 'win32')('leaves a desktop filename refused by the cloud unchanged', async () => {
    const source = await write('folder\\file.txt');
    const { client, dispatch } = homeClient();
    const args = { file_path: source };
    await client.callTool('upload_file', args);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ name: 'upload_file', arguments: args }, undefined, expect.any(Object));
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('_meta');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('accepts both the configured workspace alias and its real path', async () => {
    const source = await write('report.txt');
    const alias = path.join(root, 'workspace-alias'); await fs.symlink(desktop, alias, 'dir');
    expect((await collectForwardedFiles([source, path.join(alias, 'report.txt')], alias)).files).toHaveLength(2);
  });

  it('cleans up when a tool throws, leaving its result and error untouched', async () => {
    const failure = new Error('fictional provider failure');
    await expect(runWithForwardedFiles({ path: entry().path }, [entry()], async () => { throw failure; }, cloud)).rejects.toBe(failure);
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('removes the call folder when writing the second cloud file fails', async () => {
    const realWrite = fs.writeFile.bind(fs);
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let writes = 0;
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (++writes === 2) throw failure;
      return realWrite(...args);
    });
    const run = vi.fn();
    await expect(runWithForwardedFiles({}, [entry('one.txt'), entry('two.txt')], run, cloud)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('passes no-files calls through by identity, even without a workspace', async () => {
    const args = { text: 'hello' };
    const run = vi.fn().mockResolvedValue({ content: [] });
    await runWithForwardedFiles(args, undefined, run, '');
    expect(run).toHaveBeenCalledWith(args);
    await runWithForwardedFiles(args, [], run, '');
    expect(run.mock.calls[1][0]).toBe(args);
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it('refuses a file replaced between checking and opening, and closes the handle', async () => {
    const source = await write('report.txt');
    const replacement = await write('replacement.txt', 'replacement bytes');
    const realOpen = fs.open.bind(fs);
    let opened!: Awaited<ReturnType<typeof fs.open>>;
    vi.spyOn(fs, 'open').mockImplementationOnce(async () => { opened = await realOpen(replacement, 'r'); return opened; });
    expect((await collectForwardedFiles({ path: source })).files).toEqual([]);
    await expect(opened.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('bounds reads of a file growing after fstat to the remaining allowance plus one byte', async () => {
    const source = await write('growing.txt');
    const realOpen = fs.open.bind(fs);
    let totalRead = 0;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: unknown[]) => {
        const [buffer, offset, length] = readArgs;
        // This sink uses the positional Buffer overload; fail if that changes.
        if (!Buffer.isBuffer(buffer) || typeof offset !== 'number' || typeof length !== 'number') {
          throw new Error('Expected a positional Buffer read');
        }
        totalRead += length;
        buffer.fill(0, offset, offset + length);
        return { bytesRead: length, buffer };
      });
      return handle;
    });
    expect(await collectForwardedFiles({ path: source })).toMatchObject({ tooLarge: true, bytes: MAX_FORWARDED_FILE_BYTES + 1 });
    expect(totalRead).toBe(MAX_FORWARDED_FILE_BYTES + 1);
  });

  it('rejects a sparse oversized file before reading or dispatching and logs only counts', async () => {
    const file = await write('large.bin');
    const handle = await fs.open(file, 'r+'); await handle.truncate(MAX_FORWARDED_FILE_BYTES + 1024 * 1024); await handle.close();
    const realOpen = fs.open.bind(fs);
    const reads = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const opened = await realOpen(...args);
      vi.spyOn(opened, 'read').mockImplementation(reads);
      return opened;
    });
    const { client, dispatch } = homeClient();
    expect(await client.callTool('upload_file', { file_path: file })).toMatchObject({ isError: true, content: [{ text: 'The files for Fictional Notes add up to 51.0 MB, over the 50 MB limit for one send, so nothing was sent. Try fewer or smaller files.' }] });
    expect(reads).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Forwarded connector files', {
      package_id: 'notebook', tool_id: 'upload_file', files: 1, bytes: MAX_FORWARDED_FILE_BYTES + 1024 * 1024, outcome: 'too_large',
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(file);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('large.bin');
  });

  it('rejects two sparse 30 MiB files over the combined cap without dispatching and logs the total', async () => {
    const paths = [await write('one.bin'), await write('two.bin')];
    for (const source of paths) {
      const handle = await fs.open(source, 'r+');
      try { await handle.truncate(30 * 1024 * 1024); }
      finally { await handle.close(); }
    }
    const { client, dispatch } = homeClient();
    expect(await client.callTool('upload_file', { attachments: paths.map(path => ({ path })) })).toMatchObject({ isError: true, content: [{ text: 'The files for Fictional Notes add up to 60.0 MB, over the 50 MB limit for one send, so nothing was sent. Try fewer or smaller files.' }] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Forwarded connector files', {
      package_id: 'notebook', tool_id: 'upload_file', files: 2, bytes: 60 * 1024 * 1024, outcome: 'too_large',
    });
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it('sends original arguments plus metadata and records the attached count', async () => {
    const source = await write('report.txt', 'abc');
    const { client, dispatch } = homeClient();
    const args = { filePath: source };
    await client.callTool('upload_file', args);
    expect(dispatch.mock.calls[0][0]).toEqual({ name: 'upload_file', arguments: args, _meta: { 'rebel/forwardedFiles': [{ path: source, name: 'report.txt', contentBase64: 'YWJj' }] } });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Forwarded connector files', { package_id: 'notebook', tool_id: 'upload_file', files: 1, bytes: 3, outcome: 'attached' });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(source);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('report.txt');
    await client.callTool('write_note', { text: 'hello' });
    expect(dispatch.mock.calls[1][0]).not.toHaveProperty('_meta');
  });

  it('maps a home 413 to the agreed plain message', async () => {
    const { client, dispatch } = homeClient();
    dispatch.mockRejectedValueOnce(new StreamableHTTPError(413, 'too large'));
    await expect(client.callTool('upload_file', {})).rejects.toThrow("Rebel couldn't send that to Fictional Notes, so nothing was sent. An update may be finishing, which needs nothing from you; try again in a few minutes.");
  });

  it.each(['', '.', '..', '../bad', 'folder/file', 'folder\\file', 'bad\0file'])('refuses hostile filename %j without writing', async name => {
    await expect(runWithForwardedFiles({}, [entry(name)], vi.fn(), cloud)).rejects.toThrow('Invalid forwarded file');
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it.each([null, {}, [{ path: 'x', name: 'x', contentBase64: 1 }], [{ ...entry(), contentBase64: 'not base64!' }]])('refuses malformed metadata without writing: %j', async meta => {
    await expect(runWithForwardedFiles({}, meta, vi.fn(), cloud)).rejects.toThrow('Invalid forwarded file');
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it('rejects oversized cloud metadata before creating anything', async () => {
    const contentBase64 = Buffer.alloc(MAX_FORWARDED_FILE_BYTES + 1).toString('base64');
    const run = vi.fn();
    await expect(runWithForwardedFiles({}, [{ ...entry(), contentBase64 }], run, cloud, 'Fictional Notes')).rejects.toThrow('The files for Fictional Notes add up to 50.1 MB, over the 50 MB limit for one send, so nothing was sent. Try fewer or smaller files.');
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it.each(['', '  '])('refuses an empty cloud workspace %j', async workspace => {
    await expect(runWithForwardedFiles({}, [entry()], vi.fn(), workspace)).rejects.toThrow('Workspace directory is not configured');
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it('returns the same plain error for a missing cloud workspace without exposing its path', async () => {
    const run = vi.fn();
    const workspace = path.join(cloud, 'missing');
    await expect(runWithForwardedFiles({}, [entry()], run, workspace)).rejects.toEqual(new Error('Workspace directory is not configured'));
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it.each(['.rebel', FORWARDED_FILES_RELATIVE_DIR])('refuses symlinked cloud directory %s', async relative => {
    await fs.mkdir(path.dirname(path.join(cloud, relative)), { recursive: true });
    await fs.symlink(desktop, path.join(cloud, relative), 'dir');
    await expect(runWithForwardedFiles({}, [entry()], vi.fn(), cloud)).rejects.toThrow('real directory ancestors');
    expect(await fs.readdir(desktop)).toEqual([]);
  });

  it('returns a plain tool error for malformed metadata at the endpoint, and checks access before copying', async () => {
    const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'unused' } } });
    const dispatch = vi.spyOn(registry, 'callTool');
    const server = createPackageServer(registry, 'notebook', cloud);
    const client = new Client({ name: 'fictional-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect(await client.callTool({ name: 'upload_file', arguments: {}, _meta: { 'rebel/forwardedFiles': [{ path: 'x' }] } })).toMatchObject({ isError: true, content: [{ text: 'Invalid forwarded files' }] });
    setSecurityPolicy(new SecurityPolicy({ blockedTools: ['upload_file'] }));
    expect(await client.callTool({ name: 'upload_file', arguments: {}, _meta: { 'rebel/forwardedFiles': [entry()] } })).toMatchObject({ isError: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readdir(cloud)).toEqual([]);
  });

  it('carries metadata through the SDK endpoint and lets the tool read only the cloud copy', async () => {
    const source = await write('report.txt', 'desktop-only bytes');
    const { files } = await collectForwardedFiles({ file_path: source });
    const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'unused' } } });
    vi.spyOn(registry, 'getClient').mockResolvedValue({ getToolMetadata: async () => undefined } as any);
    vi.spyOn(registry, 'callTool').mockImplementation(async (_package, _tool, args) => {
      const target = (args as { file_path: string }).file_path;
      expect(target).not.toBe(source);
      expect(path.relative(cloud, target).startsWith(`.rebel${path.sep}forwarded-files${path.sep}`)).toBe(true);
      return { content: [{ type: 'text', text: await fs.readFile(target, 'utf8') }] };
    });
    const server = createPackageServer(registry, 'notebook', cloud);
    const client = new Client({ name: 'fictional-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect(await client.callTool({ name: 'upload_file', arguments: { file_path: source }, _meta: { 'rebel/forwardedFiles': files } })).toMatchObject({ content: [{ text: 'desktop-only bytes' }] });
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });
});

import { expandReadInputs, readInputsSchema } from '../src/fileReadInputs.js';
import { authorizeReads, DECLARED_FORWARDING, type ToolDispatchContext } from '../src/fileReadProtocol.js';

const declaredInput = readInputsSchema.parse({ version: 1, inputs: [{ selector: ['file'], base: 'connectorCwd', expandTilde: false }] });
const sourceOperands = (args: unknown) => expandReadInputs(args, declaredInput, { connectorCwd: process.cwd() });
function sourceOrigin(outcome: 'allowed' | 'denied' | 'approval_pending' = 'allowed') {
  const sendRequest = vi.fn().mockImplementation(async request => ({ version: 1, outcome, ...(outcome === 'allowed'
    ? { reads: await Promise.all(request.params.operands.map(async (operand: any) => ({ location: operand.location, rawPath: operand.rawPath, canonicalPath: await fs.realpath(operand.resolvedPath) }))) }
    : { reason: 'Source folder is held', ...(outcome === 'approval_pending' ? { presentation: 'queued' } : {}) }) }));
  const context: ToolDispatchContext = { kind: 'origin', authority: { version: 1 }, signal: new AbortController().signal, sendRequest, metadata: { 'files/invocation': { version: 1, invocationId: 'active' } } };
  return { context, sendRequest, authorize: (operands: any) => authorizeReads(operands, context, 1000) };
}

describe('central source preflight and declared forwarding compatibility', () => {
  it.each([false, true])('refuses a real forwarding candidate without binding before bytes or dispatch (declared=%s)', async exact => {
    const file = await write('report.txt');
    const source = sourceOrigin(); source.context.metadata = undefined;
    const { client, dispatch } = homeClient();
    vi.spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue(exact ? { experimental: { [DECLARED_FORWARDING]: { version: 1 } } } : {});
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'upload', inputSchema: { type: 'object' }, _meta: { 'files/readInputs': declaredInput } }] });
    const open = vi.spyOn(fs, 'open');
    await expect(client.callToolFromOrigin('upload', { file }, source.context)).rejects.toThrow('requires an active invocation binding');
    expect(source.sendRequest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches home no-file calls without binding and carries no upstream metadata or cancellation', async () => {
    const source = sourceOrigin(); source.context.metadata = { trace: 'private', progressToken: 'host-progress', 'host/private': 'host-only' };
    const { client, dispatch } = homeClient();
    await client.callToolFromOrigin('write_note', { text: 'hello' }, source.context);
    expect(source.sendRequest).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toEqual({ name: 'write_note', arguments: { text: 'hello' } });
    expect(dispatch.mock.calls[0][2]).not.toHaveProperty('signal');
  });

  it.each(['denied', 'approval_pending'] as const)('checks legacy candidates centrally before opening bytes on %s', async outcome => {
    const file = await write('report.txt'); const source = sourceOrigin(outcome);
    const open = vi.spyOn(fs, 'open');
    await expect(collectForwardedFiles({ attachment: file }, desktop, source)).rejects.toThrow('Source folder is held');
    expect(source.sendRequest).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
  });

  it('preflights the whole legacy batch once before the first byte read', async () => {
    const first = await write('one.txt'), second = await write('two.txt'); const source = sourceOrigin();
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      expect(source.sendRequest).toHaveBeenCalledTimes(1);
      expect(source.sendRequest.mock.calls[0][0].params.operands).toHaveLength(2);
      return realOpen(...args);
    });
    expect((await collectForwardedFiles({ first, second }, desktop, source)).files).toHaveLength(2);
  });

  it('adds linked Library aliases only on the declared route and leaves unrelated paths alone', async () => {
    const outside = path.join(root, 'space'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'report.txt'), 'linked bytes');
    await fs.symlink(outside, path.join(desktop, 'space'));
    const file = path.join(desktop, 'space', 'report.txt'); const source = sourceOrigin();
    expect((await collectForwardedFiles({ file, literal: file }, desktop, source)).files).toEqual([]);
    expect(source.sendRequest).not.toHaveBeenCalled();
    const result = await collectForwardedFiles({ file, literal: file }, desktop, { ...source, operands: await sourceOperands({ file }) });
    expect(result.files).toEqual([{ path: file, name: 'report.txt', contentBase64: Buffer.from('linked bytes').toString('base64') }]);
    expect(source.sendRequest).toHaveBeenCalledTimes(1);
    expect((await collectForwardedFiles({ file: path.join(outside, 'report.txt') }, desktop, { ...source, operands: await sourceOperands({ file: path.join(outside, 'report.txt') }) })).files).toEqual([]);
  });

  it('accepts the old envelope but replaces only local declared locations on a new home', async () => {
    const args = { file: entry().path, literal: entry().path, output: entry().path };
    await runWithForwardedFiles(args, [entry()], async cloned => {
      const actual = cloned as typeof args;
      expect(actual.file).not.toBe(args.file); expect(actual.literal).toBe(args.literal); expect(actual.output).toBe(args.output);
      expect(await fs.readFile(actual.file, 'utf8')).toBe('fictional bytes');
    }, cloud, 'Fixture', await sourceOperands(args));
    expect(args.file).toBe(entry().path);
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('keeps remote-only operands unchanged and the new home dispatch explicitly standalone', async () => {
    const remote = path.join(cloud, 'remote.txt'); await fs.writeFile(remote, 'remote bytes');
    const source = sourceOrigin();
    expect((await collectForwardedFiles({ file: remote }, desktop, { ...source, operands: await sourceOperands({ file: remote }) })).files).toEqual([]);
    expect(source.sendRequest).not.toHaveBeenCalled();
    const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'unused' } } });
    const child = { getToolMetadata: async () => ({ 'files/readInputs': declaredInput }), callTool: vi.fn().mockImplementation(async (_name, args, context) => {
      expect(context.metadata['files/readMode']).toEqual({ version: 1, mode: 'standalone' });
      expect(args.file).toBe(remote);
      return { content: [{ type: 'text', text: 'strict child read' }] };
    }) };
    vi.spyOn(registry, 'getClient').mockResolvedValue(child as any);
    const server = createPackageServer(registry, 'notebook', cloud); const client = new Client({ name: 'fixture', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect(await client.callTool({ name: 'upload', arguments: { file: remote } })).toMatchObject({ content: [{ text: 'strict child read' }] });
    expect(child.callTool).toHaveBeenCalledTimes(1);
  });

  it('negotiates the exact route before execution and keeps the old envelope for old receiver schemas', async () => {
    const sourceFile = await write('report.txt', 'abc'); const source = sourceOrigin();
    source.context.metadata = { ...source.context.metadata, trace: 'private', progressToken: 'host-progress', 'host/private': 'host-only' };
    const { client, dispatch } = homeClient();
    const capability = vi.spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({ experimental: { [DECLARED_FORWARDING]: { version: 1 } } });
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'upload', inputSchema: { type: 'object' }, _meta: { 'files/readInputs': declaredInput } }] });
    await client.callToolFromOrigin('upload', { file: sourceFile, literal: sourceFile }, source.context);
    expect(source.sendRequest.mock.calls[0][0].params.operands).toHaveLength(1);
    const envelope = dispatch.mock.calls[0][0]._meta!['rebel/forwardedFiles'];
    expect(dispatch.mock.calls[0][0]._meta).toEqual({ 'rebel/forwardedFiles': envelope });
    expect(dispatch.mock.calls[0][2]).not.toHaveProperty('signal');
    expect(envelope).toEqual([{ path: sourceFile, name: 'report.txt', contentBase64: 'YWJj' }]);
    expect(Object.keys((envelope as any)[0]).sort()).toEqual(['contentBase64', 'name', 'path']);
    capability.mockReturnValue({}); source.sendRequest.mockClear();
    await client.callToolFromOrigin('upload', { file: sourceFile, literal: sourceFile }, source.context);
    // Old receiver selected legacy before execution; both equal strings remain its known limitation.
    expect(source.sendRequest.mock.calls[0][0].params.operands).toHaveLength(2);
    expect(dispatch.mock.calls[1][0]._meta!['rebel/forwardedFiles']).toEqual(envelope);
  });
});

describe('new package endpoint declaration lookup', () => {
  it('uses the local declaration for an old envelope and preserves literal/output fields', async () => {
    const args = { file: entry().path, literal: entry().path, output: entry().path };
    const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'unused' } } });
    const child = { getToolMetadata: async () => ({ 'files/readInputs': declaredInput }), callTool: vi.fn().mockImplementation(async (_name, execution, context) => {
      expect(context.readMode).toEqual({ version: 1, mode: 'standalone' });
      expect(execution.literal).toBe(args.literal); expect(execution.output).toBe(args.output);
      expect(execution.file).not.toBe(args.file);
      return { content: [{ type: 'text', text: await fs.readFile(execution.file, 'utf8') }] };
    }) };
    vi.spyOn(registry, 'getClient').mockResolvedValue(child as any);
    const server = createPackageServer(registry, 'notebook', cloud); const client = new Client({ name: 'fixture', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect(await client.callTool({ name: 'upload', arguments: args, _meta: { 'rebel/forwardedFiles': [entry()] } })).toMatchObject({ content: [{ text: 'fictional bytes' }] });
    expect(child.callTool).toHaveBeenCalledTimes(1); expect(args.file).toBe(entry().path);
    expect(await fs.readdir(path.join(cloud, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('retains strict source containment for standalone declared forwarding', async () => {
    const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'private');
    const file = path.join(desktop, 'alias.txt'); await fs.symlink(outside, file);
    expect((await collectForwardedFiles({ file }, desktop, { operands: await sourceOperands({ file }) })).files).toEqual([]);
  });
});
