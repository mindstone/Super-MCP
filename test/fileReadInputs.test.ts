import fs, { readFile, writeFile, mkdtemp, mkdir, symlink, realpath, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expandReadInputs, getReadInputs, readInputsSchema, replaceReadLocations } from '../src/fileReadInputs.js';
import * as fileReadInputs from '../src/fileReadInputs.js';
import { calculateInputBases, effectiveInputBases } from '../src/fileReadPreflight.js';
import * as fileReadPreflight from '../src/fileReadPreflight.js';
import { authorizeReadsRequestSchema, authorizeReadsResultSchema, readModeSchema } from '../src/fileReadProtocol.js';

const bases = { connectorCwd: '/connector', workspace: '/workspace', home: '/home/synthetic' };
const declaration = (inputs: unknown[]) => readInputsSchema.parse({ version: 1, inputs });
const input = { selector: ['file'], base: 'connectorCwd', expandTilde: false };

describe('plain JSON file input semantics', () => {
  it.each(['connectorCwd', 'connectorCwdNative', 'workspace', 'workspaceRealpath', 'workspaceRealpathOrTmp'])('accepts the version 1 %s base without changing the example wire fixture', base => {
    expect(declaration([{ ...input, base }]).inputs[0].base).toBe(base);
  });

  it('pins the version 1 wire independently of TypeScript types', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/file-read/wire-v1.json', import.meta.url), 'utf8'));
    expect(authorizeReadsRequestSchema.parse(fixture.request)).toEqual(fixture.request);
    for (const key of ['allowed', 'pending', 'pendingStaged', 'denied', 'unavailable']) expect(authorizeReadsResultSchema.parse(fixture[key])).toEqual(fixture[key]);
    for (const key of ['central', 'standalone']) expect(readModeSchema.parse(fixture[key])).toEqual(fixture[key]);
    expect(readInputsSchema.parse(fixture.declaration)).toEqual(fixture.declaration);
    expect(authorizeReadsResultSchema.safeParse({ ...fixture.denied, reads: fixture.allowed.reads }).success).toBe(false);
    for (const presentation of [{ kind: 'queued' }, 'unknown', null, undefined]) {
      expect(authorizeReadsResultSchema.safeParse({ ...fixture.pending, presentation }).success).toBe(false);
    }
  });

  it('expands scalar and array operands, retaining original spelling and concrete locations', async () => {
    const result = await expandReadInputs({ file: './a', attachments: [{ path: '../b' }, { path: '/c' }], output: '/ignored' }, declaration([
      input, { ...input, selector: ['attachments', '*', 'path'], base: 'workspace' },
    ]), bases);
    expect(result).toEqual([
      { location: ['file'], rawPath: './a', resolvedPath: path.resolve('/connector', './a') },
      { location: ['attachments', 0, 'path'], rawPath: '../b', resolvedPath: path.resolve('/workspace', '../b') },
      { location: ['attachments', 1, 'path'], rawPath: '/c', resolvedPath: path.resolve('/c') },
    ]);
  });

  it.each([
    ['undefined', [undefined], ['missing']],
    ['falsy', [undefined, null, '', false, 0], ['missing', 'null', 'empty', 'false', 'zero']],
    ['equals', ['inline'], ['text']],
  ])('distinguishes sibling %s conditions', async (test, _values, expected) => {
    const attachments = [{ path: 'missing' }, { path: 'null', content: null }, { path: 'empty', content: '' }, { path: 'false', content: false }, { path: 'zero', content: 0 }, { path: 'text', content: 'inline' }];
    const result = await expandReadInputs({ attachments }, declaration([{ ...input, selector: ['attachments', '*', 'path'], when: [{ relativeTo: 'parent', selector: ['content'], test, ...(test === 'equals' ? { value: 'inline' } : {}) }] }]), bases);
    expect(result.map(value => value.rawPath)).toEqual(expected);
  });

  it('distinguishes root conditions from each element and ignores inactive branches', async () => {
    const spec = declaration([{ ...input, selector: ['files', '*'], when: [{ relativeTo: 'root', selector: ['kind'], test: 'equals', value: 'local' }] }]);
    expect(await expandReadInputs({ kind: 'remote', files: ['/file'] }, spec, bases)).toEqual([]);
    expect((await expandReadInputs({ kind: 'local', files: ['/file'] }, spec, bases))[0].rawPath).toBe('/file');
  });

  it('preserves per-input tilde and exact URI-prefix behavior', async () => {
    const spec = declaration([{ ...input, selector: ['files', '*'], expandTilde: true, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }, { ...input, selector: ['literal'] }]);
    const result = await expandReadInputs({ files: ['~/x', '~suffix', 'https://x', 'http://x', 'data:x', 'runway://x', 'HTTPS://x'], literal: '~/x' }, spec, bases);
    expect(result.map(value => value.resolvedPath)).toEqual([path.resolve('/home/synthetic/x'), path.resolve('/home/synthetic/suffix'), path.resolve('/connector', 'http://x'), path.resolve('/connector', 'HTTPS://x'), path.resolve('/connector', '~/x')]);
  });

  it('does not invent a missing workspace', async () => {
    expect(await expandReadInputs({ file: 'x' }, declaration([{ ...input, base: 'workspace' }]), { connectorCwd: '/cwd' })).toEqual([]);
    expect(await expandReadInputs({ file: '/absolute' }, declaration([{ ...input, base: 'workspace' }]), { connectorCwd: '/cwd' })).toEqual([]);
    expect(await expandReadInputs({ file: '~/x' }, declaration([{ ...input, base: 'workspace', expandTilde: true }]), { connectorCwd: '/cwd' })).toEqual([]);
  });

  it.each([
    { name: 'workspace resolves library from the child cwd', base: 'workspace', workspace: 'library', expected: 'library', physical: false },
    { name: 'workspace omits an operand for a blank workspace', base: 'workspace', workspace: ' \t ', expected: undefined, physical: false },
    { name: 'workspaceRealpath refuses an existing relative workspace', base: 'workspaceRealpath', workspace: 'existing-relative-library', expected: undefined, physical: false },
    { name: 'workspaceRealpathOrTmp selects the physical child library', base: 'workspaceRealpathOrTmp', workspace: 'library', expected: 'library', physical: true },
    { name: 'workspaceRealpathOrTmp selects physical child temp when workspace is unset', base: 'workspaceRealpathOrTmp', workspace: undefined, expected: 'tmp', physical: true },
    { name: 'connectorCwd selects the child cwd file', base: 'connectorCwd', workspace: 'library', expected: 'cwd', physical: false },
  ] as const)('$name', async ({ base, workspace: workspaceValue, expected, physical }) => {
    const actualCwd = process.cwd();
    // Keep the relative Computers workspace on the actual cwd's volume on Windows.
    const root = await mkdtemp(path.join(actualCwd, '.read-child-bases-'));
    try {
      const childCwd = path.join(root, 'connector');
      const library = path.join(childCwd, 'library');
      const files = {
        library: path.join(library, 'image.png'),
        tmp: path.join(childCwd, 'tmp', 'image.png'),
        cwd: path.join(childCwd, 'image.png'),
      };
      const bytes = { library: 'child library bytes', tmp: 'child temp bytes', cwd: 'child cwd bytes' };
      for (const key of ['library', 'tmp', 'cwd'] as const) {
        await mkdir(path.dirname(files[key]), { recursive: true });
        await writeFile(files[key], bytes[key]);
      }
      const relativeLibrary = path.relative(actualCwd, library);
      expect(path.isAbsolute(relativeLibrary)).toBe(false);
      const workspace = workspaceValue === 'existing-relative-library' ? relativeLibrary : workspaceValue;
      const childBases = calculateInputBases(childCwd, {
        MCP_WORKSPACE_PATH: workspace, TEMP: 'tmp', TMPDIR: 'tmp', TMP: 'tmp',
      }, process.platform, root);
      const operands = await expandReadInputs({ file: 'image.png' }, declaration([{ ...input, base }]), childBases);
      if (expected === undefined) {
        expect(operands).toEqual([]);
        return;
      }
      const expectedPath = physical ? path.join(await realpath(path.dirname(files[expected])), 'image.png') : files[expected];
      expect(operands).toHaveLength(1);
      expect(operands[0].resolvedPath).toBe(expectedPath);
      expect(await readFile(operands[0].resolvedPath)).toEqual(Buffer.from(bytes[expected]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves canonical-workspace base semantics across aliases and parent segments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'read-bases-'));
    try {
      await mkdir(path.join(root, 'actual')); await symlink(path.join(root, 'actual'), path.join(root, 'alias'));
      const workspace = path.join(root, 'alias');
      const result = await expandReadInputs({ file: 'x' }, declaration([{ ...input, base: 'workspaceRealpath' }]), { connectorCwd: '/cwd', workspace });
      expect(result[0].resolvedPath).toBe(path.join(await realpath(workspace), 'x'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('nominates the original physical-base bytes through a workspace alias and .. while retaining lexical workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'read-physical-base-'));
    try {
      const physical = path.join(root, 'B', 'library');
      const lexical = path.join(root, 'A', 'library');
      const alias = path.join(root, 'A', 'alias');
      await mkdir(physical, { recursive: true }); await mkdir(lexical, { recursive: true });
      await symlink(physical, alias, 'dir');
      await writeFile(path.join(physical, 'report.txt'), 'expected physical bytes');
      await writeFile(path.join(lexical, 'report.txt'), 'different lexical bytes');
      const rawPath = '../library/report.txt';
      const expectedPath = path.join(await realpath(physical), 'report.txt');
      const spec = declaration([{ ...input, base: 'workspaceRealpathOrTmp' }]);
      for (const workspace of [alias, ` ${alias} `, path.relative(root, alias)]) {
        const [operand] = await expandReadInputs({ file: rawPath }, spec, { connectorCwd: root, workspace });
        expect(operand).toEqual({ location: ['file'], rawPath, resolvedPath: expectedPath });
        expect(await readFile(operand.resolvedPath, 'utf8')).toBe('expected physical bytes');
      }
      const [lexicalOperand] = await expandReadInputs({ file: rawPath }, declaration([{ ...input, base: 'workspace' }]), { connectorCwd: root, workspace: alias });
      expect(lexicalOperand.resolvedPath).toBe(path.join(lexical, 'report.txt'));
      expect(await readFile(lexicalOperand.resolvedPath, 'utf8')).toBe('different lexical bytes');

      const [absolute, tilde, literal] = await expandReadInputs({ absolute: expectedPath, tilde: '~/report.txt', literal: '~/report.txt' }, declaration([
        { ...input, base: 'workspaceRealpathOrTmp', selector: ['absolute'] },
        { ...input, base: 'workspaceRealpathOrTmp', selector: ['tilde'], expandTilde: true },
        { ...input, base: 'workspaceRealpathOrTmp', selector: ['literal'] },
      ]), { connectorCwd: root, workspace: alias, home: physical });
      expect(absolute.resolvedPath).toBe(expectedPath);
      expect(await readFile(tilde.resolvedPath, 'utf8')).toBe('expected physical bytes');
      expect(literal.resolvedPath).toBe(path.join(await realpath(physical), '~/report.txt'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('canonicalizes the effective child temp alias before .. for unset and blank workspaces', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'read-temp-base-'));
    try {
      const physical = path.join(root, 'B', 'library');
      const alias = path.join(root, 'A', 'alias');
      await mkdir(physical, { recursive: true }); await mkdir(path.dirname(alias));
      await symlink(physical, alias, 'dir');
      await writeFile(path.join(physical, 'report.txt'), 'child temp bytes');
      const spec = declaration([{ ...input, base: 'workspaceRealpathOrTmp' }]);
      for (const workspace of [undefined, '', ' \t ']) {
        const childBases = calculateInputBases(root, { MCP_WORKSPACE_PATH: workspace, TMPDIR: alias, TEMP: alias }, process.platform, root);
        const [operand] = await expandReadInputs({ file: '../library/report.txt' }, spec, childBases);
        expect(operand.resolvedPath).toBe(path.join(await realpath(physical), 'report.txt'));
        expect(await readFile(operand.resolvedPath, 'utf8')).toBe('child temp bytes');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails on an unavailable configured canonical-or-temp root even for absolute or tilde operands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'read-missing-base-'));
    try {
      await writeFile(path.join(root, 'report.txt'), 'temp must not be selected');
      await writeFile(path.join(root, 'not-directory'), 'file');
      const spec = declaration([{ ...input, base: 'workspaceRealpathOrTmp', expandTilde: true }]);
      for (const [workspace, code] of [[path.join(root, 'missing'), 'ENOENT'], [path.join(root, 'not-directory', 'child'), 'ENOTDIR']] as const) {
        const childBases = { connectorCwd: root, workspace, home: root, temp: root };
        for (const file of ['report.txt', path.join(root, 'report.txt'), '~/report.txt']) {
          await expect(expandReadInputs({ file }, spec, childBases)).rejects.toMatchObject({ code });
        }
        expect(await expandReadInputs({ file: 'report.txt' }, declaration([{ ...input, base: 'workspaceRealpath' }]), childBases)).toEqual([]);
        expect((await expandReadInputs({ file: 'report.txt' }, declaration([{ ...input, base: 'workspace' }]), childBases))[0].resolvedPath).toBe(path.join(workspace, 'report.txt'));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats future declarations as undeclared and rejects malformed matched semantics', () => {
    expect(getReadInputs({ 'files/readInputs': { version: 2, invalid: true } })).toBeUndefined();
    expect(() => getReadInputs({ 'files/readInputs': { version: 1, inputs: [{ ...input, arbitraryCondition: 'code' }] } })).toThrow();
    expect(() => declaration([{ ...input, when: [{ relativeTo: 'parent', selector: ['*'], test: 'falsy' }] }])).toThrow();
    expect(() => declaration([{ ...input, when: [{ relativeTo: 'root', selector: ['kind'], test: 'equals', value: {} }] }])).toThrow();
  });

  it('mutates declared locations in a clone and leaves literal/output equal strings intact', async () => {
    const args = { file: '/source', literal: '/source', output: '/source', nested: ['/source'] };
    const operands = await expandReadInputs(args, declaration([input]), bases);
    expect(replaceReadLocations(args, operands, new Map([['/source', '/copy']]))).toEqual({ ...args, file: '/copy' });
    expect(args.file).toBe('/source');
  });
});

describe('native symlink-then-parent path semantics', () => {
  let root: string;
  let a: string;
  let physicalCwd: string;
  let spelledLibrary: string;
  const config = { id: 'fixture', name: 'Fixture', transport: 'stdio' as const, visibility: 'default' as const, command: 'unused' };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'read-native-parent-')));
    a = path.join(root, 'a');
    physicalCwd = path.join(root, 'x', 'y');
    spelledLibrary = [a, 'link', '..', 'lib'].join(path.sep);
    await mkdir(path.join(a, 'lib'), { recursive: true });
    await mkdir(physicalCwd, { recursive: true });
    await mkdir(path.join(root, 'x', 'lib'));
    await symlink(physicalCwd, path.join(a, 'link'), 'dir');
    await writeFile(path.join(a, 'lib', 'source.html'), 'lexical-A');
    await writeFile(path.join(root, 'x', 'lib', 'source.html'), 'physical-B');
    await writeFile(path.join(a, 'lib', 'only-lexical.html'), 'lexical-only');
  });

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('Computers root walks the symlink physically', async () => {
    const [operand] = await expandReadInputs({ file: 'source.html' }, declaration([{ ...input, base: 'workspaceRealpath' }]), {
      connectorCwd: root, workspace: spelledLibrary,
    });
    expect(operand.resolvedPath).toBe(path.join(root, 'x', 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('physical-B');
  });

  it('Canvas absolute operand walks the symlink physically', async () => {
    const file = [spelledLibrary, 'source.html'].join(path.sep);
    const [operand] = await expandReadInputs({ file }, declaration([{ ...input, base: 'connectorCwdNative' }]), { connectorCwd: root });
    expect(operand.resolvedPath).toBe(path.join(root, 'x', 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('physical-B');
  });

  it('Canvas relative operand walks from the physical child cwd', async () => {
    const file = ['..', 'lib', 'source.html'].join(path.sep);
    const [operand] = await expandReadInputs({ file }, declaration([{ ...input, base: 'connectorCwdNative' }]), { connectorCwd: physicalCwd });
    expect(operand.resolvedPath).toBe(path.join(root, 'x', 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('physical-B');
  });

  it('Canvas never falls back to lexical bytes when the physical target is missing', async () => {
    const file = [spelledLibrary, 'only-lexical.html'].join(path.sep);
    await expect(expandReadInputs({ file }, declaration([{ ...input, base: 'connectorCwdNative' }]), { connectorCwd: root }))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Canvas path without a parent segment does no router filesystem call', async () => {
    const file = path.join(a, 'lib', 'missing.html');
    const realpathSpy = vi.spyOn(fs, 'realpath');
    try {
      const [operand] = await expandReadInputs({ file }, declaration([{ ...input, base: 'connectorCwdNative' }]), { connectorCwd: root });
      expect(operand.resolvedPath).toBe(file);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally { realpathSpy.mockRestore(); }
  });

  it.each([
    { name: 'Windows rooted path takes the child drive without collapsing parents', target: '\\lib\\link\\..\\x', cwd: 'D:\\cwd', paths: path.win32, expected: 'D:\\lib\\link\\..\\x' },
    { name: 'Windows absolute path keeps its own drive and parents', target: 'C:\\lib\\link\\..\\x', cwd: 'D:\\cwd', paths: path.win32, expected: 'C:\\lib\\link\\..\\x' },
    { name: 'Windows relative path retains parents under the child cwd', target: 'link\\..\\x', cwd: 'D:\\cwd', paths: path.win32, expected: 'D:\\cwd\\link\\..\\x' },
    { name: 'Windows drive-relative path uses native lexical resolution', target: 'D:link\\..\\x', cwd: 'D:\\cwd', paths: path.win32, expected: 'D:\\cwd\\x' },
    { name: 'POSIX absolute path retains parents', target: '/a/link/../lib', cwd: '/c', paths: path.posix, expected: '/a/link/../lib' },
    { name: 'POSIX relative path retains parents under the child cwd', target: 'link/../x', cwd: '/c', paths: path.posix, expected: '/c/link/../x' },
  ])('childSpelling: $name', ({ target, cwd, paths, expected }) => {
    // Look up the unpublished export inside the case so its absence cannot prevent collection.
    const childSpelling: unknown = Reflect.get(fileReadInputs, 'childSpelling');
    if (typeof childSpelling !== 'function') throw new TypeError('childSpelling is not a function');
    expect(childSpelling(target, cwd, paths)).toBe(expected);
  });

  it.each(['symlink', 'symlink then parent'] as const)("matches the spawned child's physical cwd: %s", async kind => {
    const spelled = kind === 'symlink' ? path.join(a, 'link') : spelledLibrary;
    const childCwd = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: spelled, encoding: 'utf8' });
    const childBases = effectiveInputBases({ ...config, cwd: spelled });
    expect(childBases.connectorCwd).toBe(childCwd);
    expect(childCwd).toBe(kind === 'symlink' ? physicalCwd : path.join(root, 'x', 'lib'));
    const file = kind === 'symlink' ? ['..', 'lib', 'source.html'].join(path.sep) : 'source.html';
    const [operand] = await expandReadInputs({ file }, declaration([input]), childBases);
    expect(operand.resolvedPath).toBe(path.join(root, 'x', 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('physical-B');
  });

  it('childProcessCwd keeps the Windows spelling', () => {
    const childProcessCwd: unknown = Reflect.get(fileReadPreflight, 'childProcessCwd');
    if (typeof childProcessCwd !== 'function') throw new TypeError('childProcessCwd is not a function');
    const spelled = path.join(a, 'link');
    expect(childProcessCwd(spelled, 'win32')).toBe(path.resolve(spelled));
    expect(childProcessCwd(spelled, 'linux')).toBe(physicalCwd);
  });

  it('connectorCwd retains lexical operand resolution', async () => {
    const file = [spelledLibrary, 'source.html'].join(path.sep);
    const [operand] = await expandReadInputs({ file }, declaration([input]), { connectorCwd: root });
    expect(operand.resolvedPath).toBe(path.join(a, 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('lexical-A');
  });

  it('workspace retains lexical workspace resolution', async () => {
    const [operand] = await expandReadInputs({ file: 'source.html' }, declaration([{ ...input, base: 'workspace' }]), {
      connectorCwd: root, workspace: spelledLibrary,
    });
    expect(operand.resolvedPath).toBe(path.join(a, 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('lexical-A');
  });

  it('workspaceRealpathOrTmp retains Browser lexical workspace resolution', async () => {
    const [operand] = await expandReadInputs({ file: 'source.html' }, declaration([{ ...input, base: 'workspaceRealpathOrTmp' }]), {
      connectorCwd: root, workspace: spelledLibrary,
    });
    expect(operand.resolvedPath).toBe(path.join(a, 'lib', 'source.html'));
    expect(await readFile(operand.resolvedPath, 'utf8')).toBe('lexical-A');
  });

  it('uses the router cwd when no child cwd is configured', () => {
    expect(effectiveInputBases({ ...config, cwd: undefined }).connectorCwd).toBe(process.cwd());
  });
});
