import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { captureToolDispatch } from '../src/fileReadProtocol.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { Validator } from '../src/validator.js';
import { ERROR_CODES } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// A missing file is decided by its filesystem code, never by words in its path (FOX-8286).
const declaration = { version: 1, inputs: [{ selector: ['file'], base: 'connectorCwdNative', expandTilde: false }] };
const tool = { name: 'upload', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }, _meta: { 'files/readInputs': declaration } };
// Keep the `..` segment: path.join would collapse it and skip the realpath walk.
const nativePath = (...parts: string[]) => parts.join(path.sep);

let root: string;
const cleanup: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-fox8286-'));
  await fs.mkdir(path.join(root, 'auth', 'link'), { recursive: true });
  await fs.writeFile(path.join(root, 'auth', 'present.html'), '<html><body>ok</body></html>');
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function harness(sendRequest = vi.fn(), callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'read ok' }] })) {
  const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused' } } });
  cleanup.push(() => registry.closeAll());
  vi.spyOn(registry, 'getClient').mockResolvedValue({
    connect: vi.fn(), close: vi.fn(), listTools: async () => [tool], callTool,
    getToolMetadata: async () => tool._meta,
    getFileInputBases: () => ({ connectorCwd: root, workspace: root, home: root, temp: root }),
  });
  const catalog = new Catalog(registry);
  catalog.commitReady('fixture', [tool], catalog.getConfigurationGeneration());
  vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
  const context = { dispatch: captureToolDispatch({ version: 1 }, { 'files/invocation': { version: 1, invocationId: 'active' } }, { sendRequest, signal: new AbortController().signal }) };
  const run = (file: string) => handleUseTool({ package_id: 'fixture', tool_id: 'upload', args: { file } }, registry, catalog, new Validator(), context);
  return { run, sendRequest, callTool };
}

async function rejection(promise: Promise<unknown>): Promise<{ code: number; message: string; data: { original_error: string } }> {
  try { await promise; } catch (error) { return error as never; }
  throw new Error('Expected handleUseTool to reject');
}

describe('use_tool diagnosis of a missing file whose path mentions auth', () => {
  it.each([
    { label: 'ENOENT', file: nativePath('auth', 'link', '..', 'missing.html'), code: 'ENOENT', name: 'missing.html' },
    // Windows resolves `file/../x` without walking through the file, so this fixture gives ENOTDIR only on POSIX.
    ...(process.platform === 'win32' ? [] : [{ label: 'ENOTDIR', file: nativePath('auth', 'present.html', '..', 'x.html'), code: 'ENOTDIR', name: 'present.html' }]),
  ])('reports $label as the file error, not as a sign-in failure', async ({ file, code, name }) => {
    const fixture = harness();
    const error = await rejection(fixture.run(file));
    expect(error.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(error.message).toContain(code);
    expect(error.message).toContain(name);
    expect(error.message).not.toContain('Authentication/Authorization error');
    expect(error.message).not.toContain('authenticate(');
    expect(error.data.original_error).toContain(code);
    expect(fixture.callTool).not.toHaveBeenCalled();
    expect(fixture.sendRequest).not.toHaveBeenCalled();
  });

  it('still reads a present file through the same auth path', async () => {
    const file = nativePath('auth', 'link', '..', 'present.html');
    const canonicalPath = await fs.realpath(path.join(root, 'auth', 'present.html'));
    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads: [{ location: ['file'], rawPath: file, canonicalPath }] });
    const fixture = harness(sendRequest);
    const result = await fixture.run(file);
    expect(result.isError).not.toBe(true);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0][0].params.operands[0]).toMatchObject({ rawPath: file, resolvedPath: canonicalPath });
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps a denied read denied', async () => {
    const reason = 'The source folder is blocked.';
    const fixture = harness(vi.fn().mockResolvedValue({ version: 1, outcome: 'denied', reason }));
    const result = await fixture.run(nativePath('auth', 'link', '..', 'present.html'));
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: reason }] });
    expect(fixture.callTool).not.toHaveBeenCalled();
  });

  it.each(['HTTP 401 Unauthorized', 'authentication required'])('keeps sign-in guidance for a provider failure: %s', async text => {
    const canonicalPath = await fs.realpath(path.join(root, 'auth', 'present.html'));
    const file = path.join(root, 'auth', 'present.html');
    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads: [{ location: ['file'], rawPath: file, canonicalPath }] });
    const fixture = harness(sendRequest, vi.fn().mockRejectedValue(new Error(text)));
    const error = await rejection(fixture.run(file));
    expect(error.code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(error.message).toContain('Authentication/Authorization error');
    expect(error.message).toContain('authenticate(');
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
  });
});
