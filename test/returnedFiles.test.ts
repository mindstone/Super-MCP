import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as returnedFiles from '../src/returnedFiles.js';
import { collectReturnedFiles, installReturnedFiles, rewriteReturnedResult, RETURNED_FILES_META, RETURNED_FILES_LIMITS } from '../src/returnedFiles.js';
import { MAX_FORWARDED_FILE_BYTES } from '../src/forwardedFiles.js';
import { PackageHomeClient } from '../src/clients/packageHomeClient.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
let root: string, cloud: string, desktop: string, temp: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(tmpdir(), 'returned-files-'));
  [cloud, desktop, temp] = ['cloud', 'desktop', 'temp'].map(name => path.join(root, name));
  await Promise.all([cloud, desktop, temp].map(dir => fs.mkdir(dir)));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function write(name: string, bytes = 'file bytes', directory = cloud) {
  const target = path.join(directory, name);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return target;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const file = (name = 'report.txt', extra = {}) => ({ source: `/cloud/${name}`, root: 'workspace', relativePath: name, name, contentBase64: Buffer.from('file bytes').toString('base64'), ...extra });
const answer = (files: Array<Record<string, unknown>> = [file()], extra = {}) => ({ ...result({ filePath: files[0]?.source }), _meta: { keep: true, ui: { resourceUri: 'ui://test' }, [RETURNED_FILES_META]: { version: 1, files, references: [], ...extra } } });

describe('returned file collection', () => {
  it.each([
    ['prose', '.'], ['prose', '),'],
    ['mixed JSON', '.'], ['mixed JSON', '),'],
  ])('collects and rewrites a Markdown link in %s followed by %s', async (format, suffix) => {
    const source = await write('report.pdf');
    const local = path.join(desktop, 'report.pdf');
    const note = `Saved [report](${source})${suffix} Read it now.`;
    const localNote = `Saved [report](${local})${suffix} Read it now.`;
    const original = result(format === 'prose' ? note : { path: source, note });
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.files.map(file => file.source)).toEqual([source]);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed).toEqual({ ...result(format === 'prose' ? localNote : { path: local, note: localNote }), _meta: {} });
    expect(await fs.readFile(local, 'utf8')).toBe('file bytes');
  });
  it('keeps a closing parenthesis in the longest existing filename', async () => {
    await write('report.pdf');
    const source = await write('report.pdf)');
    const original = result(`Saved [report](${source}). Read it now.`);
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.files.map(file => file.source)).toEqual([source]);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    const local = path.join(desktop, 'report.pdf)');
    expect(installed).toEqual({ ...result(`Saved [report](${local}). Read it now.`), _meta: {} });
    expect(await fs.readFile(local, 'utf8')).toBe('file bytes');
  });
  it.each(["'", '`'])('collects and rewrites %s-delimited paths in prose and mixed JSON', async delimiter => {
    const source = await write('saved report.pdf');
    const note = `Saved to ${delimiter}${source}${delimiter}. Again ${delimiter}${source}${delimiter}.`;
    const localNote = note.replaceAll(source, path.join(desktop, 'saved report.pdf'));
    for (const value of [note, { path: source, note }]) {
      const original = result(value);
      const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
      expect(envelope.files).toHaveLength(1);
      const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
      expect(installed).toEqual({ ...result(typeof value === 'string' ? localNote : { path: path.join(desktop, 'saved report.pdf'), note: localNote }), _meta: {} });
    }
  });
  it.each(["'", '`'])('keeps literal %s characters in the longest existing filename', async delimiter => {
    await write('saved');
    const source = await write(`saved${delimiter} report.pdf`);
    const original = result(`Saved to ${delimiter}${source}${delimiter}.`);
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.files.map(file => file.source)).toEqual([source]);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed.content[0].text).toBe(`Saved to ${delimiter}${path.join(desktop, `saved${delimiter} report.pdf`)}${delimiter}.`);
  });
  it('rewrites all 80 mentions in an 80 KB answer without repeating its text in the envelope', async () => {
    const source = await write('report.pdf');
    const text = `Saved to ${source}. ${'Details '.repeat(120)}\n`.repeat(80);
    expect(text.length).toBeGreaterThan(80000);
    const original = result(text);
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.truncated).toBeUndefined();
    expect(JSON.stringify(envelope).length).toBeLessThan(text.length * 2);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed).toEqual({ ...result(text.replaceAll(source, path.join(desktop, 'report.pdf'))), _meta: {} });
  });
  it('reports reference exhaustion instead of silently leaving paths untranslated', async () => {
    const source = await write('report.pdf');
    const original = result(`Saved to ${source}.\n`.repeat(513));
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.truncated).toBe(true);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed.isError).toBe(true);
    expect(installed.content.at(-1).text).toContain('may not have copied every file');
  });
  it.each([0, 1500])('admits an extensionless relative output with %i ms timestamp rounding', async rounding => {
    const startedAt = Date.now();
    const source = await write('Report');
    if (rounding) await fs.utimes(source, new Date(startedAt - rounding), new Date(startedAt - rounding));
    const original = result({ library_path: 'Report' });
    const envelope = await collectReturnedFiles(original, cloud, temp, startedAt);
    expect(envelope.files.map(file => file.source)).toEqual(['Report']);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed).toEqual({ ...result({ library_path: path.join(desktop, 'Report') }), _meta: {} });
    expect(await fs.readFile(path.join(desktop, 'Report'), 'utf8')).toBe('file bytes');
  });
  it('accepts fresh relative files at the real call-start timestamp and rejects stale ones', async () => {
    const stale = await write('stale');
    const startedAt = Date.now();
    await fs.utimes(stale, new Date(startedAt - 3000), new Date(startedAt - 3000));
    for (let i = 0; i < 5; i++) {
      const callStartedAt = Date.now();
      const name = `fresh-${i}.pdf`;
      await write(name);
      const envelope = await collectReturnedFiles(result({ path: name, stale: 'stale' }), cloud, temp, callStartedAt);
      expect(envelope.files.map(file => file.source)).toEqual([name]);
    }
  });
  it('reports skipped candidates only for unscanned root text or the file cap', async () => {
    const text = 'x'.repeat(RETURNED_FILES_LIMITS.text) + cloud + '/saved.pdf';
    const envelope = await collectReturnedFiles(result(text), cloud, temp, 0);
    expect(envelope.truncated).toBe(true);
    const installed = await installReturnedFiles({ ...result(text), _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed.content.at(-1).text).toBe("The action finished, but Rebel may not have copied every file it saved to this computer. Check before using any path above that isn't on this computer.");
    const sources = await Promise.all(Array.from({ length: 129 }, (_, i) => write(`${i}.txt`)));
    const capped = await collectReturnedFiles(result(sources), cloud, temp, 0);
    expect(capped.files).toHaveLength(128);
    expect(capped.truncated).toBe(true);
  });
  it.each([
    ['2000 plain strings', () => result(Array.from({ length: 2000 }, (_, i) => `subject ${i}`))],
    ['probe-bound missing relative paths', () => result(Array.from({ length: 2000 }, (_, i) => `missing-${i}.pdf`))],
    ['over 1 MB without paths', () => result('x'.repeat(RETURNED_FILES_LIMITS.text + 1))],
    ['over the node limit without paths', () => ({ structuredContent: Array(9000).fill('subject') })],
    ['a long snippet ending with a URL', () => result(`${'A long sentence. '.repeat(20)}See https://example.com/x`)],
  ])('leaves %s byte-identical without isError', async (_name, make) => {
    const original = make();
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop))
      .toEqual({ ...original, _meta: {} });
  });
  it('ignores root-prefix lookalikes in text beyond the discovery limit', async () => {
    const original = result('x'.repeat(RETURNED_FILES_LIMITS.text) + `${cloud}files/report.pdf ${temp}l/example`);
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(envelope.truncated).toBeUndefined();
    expect(await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop))
      .toEqual({ ...original, _meta: {} });
  });
  it('delivers a prose path followed by a long sentence without false copy failures', async () => {
    const source = await write('saved.pdf');
    const sentence = 'You can now read the saved document. '.repeat(10);
    const original = result(`Saved to ${source}. ${sentence}`);
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(envelope.files).toHaveLength(1);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed).toEqual({ ...result(`Saved to ${path.join(desktop, 'saved.pdf')}. ${sentence}`), _meta: {} });
    expect(await fs.readFile(path.join(desktop, 'saved.pdf'), 'utf8')).toBe('file bytes');
  });
  it.each(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL', 'ELOOP', 'EACCES', 'EIO'])('ignores %s when probing a candidate', async code => {
    const source = path.join(cloud, 'not-a-file.pdf');
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (args[0] === source) throw Object.assign(new Error('not a candidate'), { code });
      return lstat(...args);
    }) as typeof lstat);
    const original = result(source);
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(envelope.files).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
    expect(await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop))
      .toEqual({ ...original, _meta: {} });
  });
  it.each(['EACCES', 'EIO'])('ignores a failed parent walk without repeating its %s probe or claiming a saved file', async code => {
    const denied = path.join(cloud, 'private');
    const lstat = fs.lstat.bind(fs);
    const stat = vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (args[0] === denied) throw Object.assign(new Error('cannot search parent'), { code });
      return lstat(...args);
    }) as typeof lstat);
    const original = result(`See ${denied}/maybe saved file.pdf for more details. Again ${denied}/other.pdf.`);
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(envelope.files).toEqual([]);
    expect(envelope.truncated).toBeUndefined();
    expect(stat.mock.calls.filter(([target]) => target === denied)).toHaveLength(1);
    expect(await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop))
      .toEqual({ ...original, _meta: {} });
  });
  it('skips overlong path parts before probing two root mentions followed by long paragraphs', async () => {
    const stat = vi.spyOn(fs, 'lstat');
    const paragraph = 'A long paragraph with no slash. '.repeat(130).slice(0, 4000);
    const original = result(`See ${cloud}/${paragraph} Then ${temp}/${paragraph}`);
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    expect(envelope.files).toEqual([]);
    expect(envelope.truncated).toBeUndefined();
    expect(stat.mock.calls.every(([target]) => String(target).split(path.sep).every(part => Buffer.byteLength(part) <= 255))).toBe(true);
    expect(await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop))
      .toEqual({ ...original, _meta: {} });
  });
  it('checks path component length in bytes rather than characters', async () => {
    const stat = vi.spyOn(fs, 'lstat');
    const original = result(path.join(cloud, 'é'.repeat(128)));
    expect((await collectReturnedFiles(original, cloud, temp, 0)).files).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });
  it('memoises missing probes and inspects each successful leaf once', async () => {
    const source = await write('found.pdf');
    const stat = vi.spyOn(fs, 'lstat');
    await collectReturnedFiles(result(['missing.pdf', 'missing.pdf', path.join(cloud, 'missing.pdf'), source, source]), cloud, temp, 0);
    expect(stat.mock.calls.filter(([target]) => target === path.join(cloud, 'missing.pdf'))).toHaveLength(1);
    expect(stat.mock.calls.filter(([target]) => target === source)).toHaveLength(1);
  });
  it('reports a read failure after opening an eligible cloud file', async () => {
    const source = await write('unreadable.pdf');
    const handle = await fs.open(source, 'r');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    vi.spyOn(handle, 'read').mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'EIO' }));
    const envelope = await collectReturnedFiles(result(source), cloud, temp, 0);
    expect(envelope.files).toEqual([{ source, root: 'workspace', error: "the file couldn't be read" }]);
    expect(logger.warn).toHaveBeenCalledWith('Returned file delivery failed', { code: 'EIO' });
  });
  it.each(['realpath', 'open'] as const)('reports unexpected %s errors for eligible paths', async operation => {
    const source = await write('unreadable.pdf');
    const original = fs[operation].bind(fs);
    vi.spyOn(fs, operation).mockImplementation((async (...args: Parameters<typeof original>) => {
      if (args[0] === source) throw Object.assign(new Error('read failed'), { code: 'EIO' });
      return original(...args);
    }) as typeof original);
    const envelope = await collectReturnedFiles(result(source), cloud, temp, 0);
    expect(envelope.files).toEqual([{ source, root: 'workspace', error: "the file couldn't be read" }]);
    const installed = await installReturnedFiles({ ...result(source), _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed.isError).toBe(true);
    expect(installed.content.at(-1).text).toContain("the file couldn't be read");
  });
  it.each(['realpath', 'open'] as const)('stops shortening a prose span after an eligible file has a %s failure', async operation => {
    const source = await write('unreadable file.pdf');
    const original = fs[operation].bind(fs);
    vi.spyOn(fs, operation).mockImplementation((async (...args: Parameters<typeof original>) => {
      if (args[0] === source) throw Object.assign(new Error('read failed'), { code: 'ENOENT' });
      return original(...args);
    }) as typeof original);
    const stat = vi.spyOn(fs, 'lstat');
    const envelope = await collectReturnedFiles(result(`Saved to ${source}.`), cloud, temp, 0);
    expect(envelope.files).toEqual([{ source, root: 'workspace', error: "the file couldn't be read" }]);
    expect(stat.mock.calls.some(([target]) => target === path.join(cloud, 'unreadable'))).toBe(false);
  });
  it('rewrites every qualifying parent occurrence after a file path and repeated mentions', async () => {
    const source = await write('folder/x.pdf'); const parent = path.dirname(source);
    const original = result({ path: source, note: `Saved ${source} in ${parent}. Again in ${parent}.` });
    const envelope = await collectReturnedFiles(original, cloud, temp, 0);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(JSON.parse(installed.content[0].text).note).toBe(`Saved ${path.join(desktop, 'folder/x.pdf')} in ${path.join(desktop, 'folder')}. Again in ${path.join(desktop, 'folder')}.`);
  });
  it('collects nested attachment.path, savedTo and temp filePath/file_path, several files and prose with spaces', async () => {
    const a = await write('attachments/a.pdf'); const b = await write('pictures/my picture.png');
    const c = await write('invoice.pdf', 'invoice', temp); const d = await write('export.csv', 'export', temp);
    const original = { ...result({ attachment: { path: a }, savedTo: a, message: `Attachment saved in ${path.dirname(a)}`, filePath: c, file_path: d }), structuredContent: { message: `Image saved to: ${b}.`, files: [a, c] } };
    const envelope = await collectReturnedFiles(original, cloud, temp, Date.now());
    expect(envelope.files).toHaveLength(4);
    expect(envelope.files.map(f => f.source)).toEqual(expect.arrayContaining([a, b, c, d]));
    expect(envelope.files.find(f => f.source === c)).toMatchObject({ root: 'temp', name: 'invoice.pdf' });
    expect(original.content[0].text).toContain(a);
    const installed = await installReturnedFiles({ ...original, _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    const json = JSON.parse(installed.content[0].text);
    expect(json.attachment.path).toBe(path.join(desktop, 'attachments/a.pdf'));
    expect(json.savedTo).toBe(json.attachment.path);
    expect(json.message).toBe(`Attachment saved in ${path.join(desktop, 'attachments')}`);
    expect(installed.structuredContent.message).toBe(`Image saved to: ${path.join(desktop, 'pictures/my picture.png')}.`);
    expect(await fs.readFile(json.filePath, 'utf8')).toBe('invoice');
  });
  it('admits only relative whole values modified during the call, but admits cached absolute files', async () => {
    const old = await write('old.txt'); await fs.utimes(old, 1, 1);
    await write('new.txt');
    const collected = await collectReturnedFiles(result({ old: 'old.txt', new: 'new.txt', cached: old, prose: 'see new.txt' }), cloud, temp, Date.now() - 1000);
    expect(collected.files.map(f => f.source)).toEqual(['new.txt', old]);
  });
  it('rejects forwarded input copies, directories, symlinks, missing and outside files even when temp contains workspace', async () => {
    const input = await write('.rebel/forwarded-files/call/input.txt'); const outside = await write('outside.txt', 'secret', root);
    const good = await write('good.txt'); await fs.symlink(good, path.join(cloud, 'link.txt'));
    await fs.symlink(path.dirname(good), path.join(cloud, 'linked'), 'dir');
    const sources = [input, cloud, outside, path.join(cloud, 'link.txt'), path.join(cloud, 'linked/good.txt'), path.join(cloud, 'missing')];
    expect((await collectReturnedFiles(result(sources), cloud, temp, 0)).files).toEqual([]);
    expect((await collectReturnedFiles(result(input), cloud, root, 0)).files).toEqual([]);
  });
  it('bounds probes, string inspection, path length and nesting', async () => {
    const stat = vi.spyOn(fs, 'lstat');
    const huge = result(Array.from({ length: 2000 }, (_, i) => `saved to ${cloud}/missing ${i} ${'x '.repeat(40)}`));
    expect((await collectReturnedFiles(huge, cloud, temp, 0)).truncated).toBe(true);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(RETURNED_FILES_LIMITS.probes);
    const cached = await write('existing.txt');
    expect((await collectReturnedFiles(result(`${cached}.backup`), cloud, temp, 0)).files).toEqual([]);
    const long = path.join(cloud, 'x'.repeat(4100));
    expect((await collectReturnedFiles(result(long), cloud, temp, 0)).files).toEqual([]);
    expect((await collectReturnedFiles(result('x'.repeat(RETURNED_FILES_LIMITS.text + 1)), cloud, temp, 0)).truncated).toBeUndefined();
    let deep: unknown = 'file.txt'; for (let i = 0; i < 100; i++) deep = [deep];
    expect((await collectReturnedFiles({ structuredContent: deep }, cloud, temp, 0)).truncated).toBeUndefined();
  });
  it('reports oversized files and aggregate exhaustion while retaining earlier deliveries', async () => {
    const a = await write('a.bin'); const b = await write('b.bin');
    for (const f of [a, b]) { const handle = await fs.open(f, 'r+'); await handle.truncate(30 * 1024 * 1024); await handle.close(); }
    const envelope = await collectReturnedFiles(result([a, b]), cloud, temp, 0);
    expect(envelope.files[0]).toHaveProperty('contentBase64'); expect(envelope.files[1]).toMatchObject({ source: b, tooLarge: true, bytes: 30 * 1024 * 1024 });
    const installed = await installReturnedFiles({ ...result([a, b]), _meta: { [RETURNED_FILES_META]: envelope } }, desktop);
    expect(installed.isError).toBe(true); expect(installed.content[1].text).toContain('too large to copy');
    expect(installed.content[1].text).toContain("Don't repeat the action just to get the file.");
  });
});

describe('returned file installation', () => {
  it.each(['con', 'bad.', 'bad ', 'what?.pdf', 'a<b>|"*.pdf'])('sanitises Windows-only names %j only on win32', async name => {
    const posix = await installReturnedFiles(answer([file(name)]), desktop, undefined, 'linux');
    expect(JSON.parse(posix.content[0].text).filePath).toBe(path.join(desktop, name));
    const windows = await installReturnedFiles(answer([file(name)]), desktop, undefined, 'win32');
    const target = JSON.parse(windows.content[0].text).filePath;
    expect(target).toContain(path.join(desktop, '.rebel/tool-outputs') + path.sep);
    expect(path.basename(target)).not.toMatch(/[:?"<>|*]|[. ]$/u);
    expect(windows.isError).toBeUndefined();
  });
  it('uses exact temporary-file failure wording and a plain oversized reason', async () => {
    const installed = await installReturnedFiles(answer([{ source: '/cloud/invoice.pdf', root: 'temp', tooLarge: true, bytes: 60 * 1024 * 1024 }]), desktop);
    expect(installed.content.at(-1).text).toBe('The action finished, but Rebel couldn\'t copy "invoice.pdf" to this computer (too large to copy). It was only saved temporarily (at /cloud/invoice.pdf) and isn\'t in the Library. Run the action again only if the file is needed.');
  });
  it('explains a clash exactly once while preserving the existing file', async () => {
    await write('report.txt', 'existing', desktop);
    const installed = await installReturnedFiles(answer(), desktop);
    const target = JSON.parse(installed.content[0].text).filePath;
    expect(installed.content.slice(1)).toEqual([{ type: 'text', text: `A different file already had the name "report.txt" on this computer, so this copy is at ${target}.` }]);
    expect(installed.isError).toBeUndefined();
    expect(await fs.readFile(path.join(desktop, 'report.txt'), 'utf8')).toBe('existing');
  });
  it.each(['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS'])('stages outside sync and publishes exclusively without hard links (%s)', async code => {
    const link = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code }));
    const open = vi.spyOn(fs, 'open');
    const installed = await installReturnedFiles(answer(), desktop);
    expect(installed.isError).toBeUndefined();
    expect(await fs.readFile(path.join(desktop, 'report.txt'), 'utf8')).toBe('file bytes');
    expect(link.mock.calls[0][0]).toContain(path.join(desktop, '.rebel/forwarded-files/.returned-staging') + path.sep);
    expect(open).toHaveBeenCalledWith(path.join(desktop, 'report.txt'), 'wx', 0o600);
    expect(await fs.readdir(path.join(desktop, '.rebel/forwarded-files/.returned-staging'))).toEqual([]);
  });
  it('keeps EEXIST exclusive during copy fallback and chooses a free output name', async () => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOSYS' }));
    const realOpen = fs.open.bind(fs); let count = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (flags === 'wx' && ++count <= 2) await fs.writeFile(target, 'racing bytes', { flag: 'wx' });
      return realOpen(target, flags, mode);
    });
    const installed = await installReturnedFiles(answer(), desktop);
    const target = JSON.parse(installed.content[0].text).filePath;
    expect(path.basename(target)).toBe('1-report.txt');
    expect(await fs.readFile(path.join(desktop, 'report.txt'), 'utf8')).toBe('racing bytes');
    expect(await fs.readFile(target, 'utf8')).toBe('file bytes');
  });
  it('preserves an existing file when hard links are unavailable and source copying would fail with EMFILE', async () => {
    const existing = await write('report.txt', 'existing user bytes', desktop);
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOSYS' }));
    const copy = vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('source open failed'), { code: 'EMFILE' }));
    const installed = await installReturnedFiles(answer(), desktop);
    expect(await fs.readFile(existing, 'utf8')).toBe('existing user bytes');
    expect(installed.isError).toBeUndefined();
    expect(await fs.readFile(JSON.parse(installed.content[0].text).filePath, 'utf8')).toBe('file bytes');
    expect(copy).not.toHaveBeenCalled();
  });
  it('preserves an existing target when exclusive open fails before creating anything', async () => {
    const existing = await write('report.txt', 'existing user bytes', desktop);
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOSYS' }));
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (target === existing && flags === 'wx') throw Object.assign(new Error('open failed'), { code: 'EMFILE' });
      return realOpen(target, flags, mode);
    });
    const installed = await installReturnedFiles(answer(), desktop);
    expect(installed.isError).toBe(true);
    expect(await fs.readFile(existing, 'utf8')).toBe('existing user bytes');
  });
  it.each(['workspace', 'temp'])('removes a partial %s target after exclusive write fails', async root => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOSYS' }));
    let target: string | undefined;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (to, flags, mode) => {
      const handle = await realOpen(to, flags, mode);
      if (flags === 'wx') {
        target = String(to);
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write('partial');
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    const installed = await installReturnedFiles(answer([file('report.txt', { root })]), desktop);
    expect(installed.isError).toBe(true);
    expect(installed.content.at(-1).text).toContain('couldn\'t copy "report.txt"');
    expect(target).toBeDefined();
    await expect(fs.lstat(target!)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readdir(path.join(desktop, '.rebel/forwarded-files/.returned-staging'))).toEqual([]);
  });
  it('does not create refused same-place parents before falling back', async () => {
    const mkdir = vi.spyOn(fs, 'mkdir');
    const installed = await installReturnedFiles(answer([file('Agenda: Q4.pdf', { relativePath: 'nested/Agenda: Q4.pdf' })]), desktop, undefined, 'win32');
    expect(installed.isError).toBeUndefined();
    expect(mkdir.mock.calls.some(([target]) => target === path.join(desktop, 'nested'))).toBe(false);
  });
  it('maps Stop with a custom abort reason to copying was stopped', async () => {
    const controller = new AbortController(); controller.abort(new Error('custom Stop reason'));
    const installed = await installReturnedFiles(answer(), desktop, controller.signal);
    expect(installed.content.at(-1).text).toContain('copying was stopped');
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it.each(['linux', 'win32'] as const)('delivers a colon name beside a normal file on %s', async platform => {
    const entries = [file('Agenda: Q4.pdf'), file('notes.pdf')];
    const original = { ...answer(entries), ...result(entries.map(entry => entry.source)) };
    const installed = await installReturnedFiles(original, desktop, undefined, platform);
    const targets = JSON.parse(installed.content[0].text);
    expect(installed.isError).toBeUndefined();
    expect(targets[0]).toEqual(platform === 'linux' ? path.join(desktop, 'Agenda: Q4.pdf') : expect.stringContaining(path.join(desktop, '.rebel/tool-outputs') + path.sep));
    expect(path.basename(targets[0])).toBe(platform === 'linux' ? 'Agenda: Q4.pdf' : 'Agenda_ Q4.pdf');
    expect(targets[1]).toBe(path.join(desktop, 'notes.pdf'));
    for (const target of targets) expect(await fs.readFile(target, 'utf8')).toBe('file bytes');
  });
  it.each(['workspace', 'temp'])('allows a drive-like colon name in a %s file on POSIX only', async root => {
    const entry = file('A: agenda.pdf', { root });
    const posix = await installReturnedFiles(answer([entry]), desktop, undefined, 'linux');
    const target = JSON.parse(posix.content[0].text).filePath;
    expect(posix.isError).toBeUndefined();
    expect(path.basename(target)).toBe(entry.name);
    expect(await fs.readFile(target, 'utf8')).toBe('file bytes');
  });
  it.each(['workspace', 'temp'])('sanitises a drive-like %s basename while retaining relative-path validation', async root => {
    const entry = file('A: agenda.pdf', { root, relativePath: 'safe/agenda.pdf' });
    const installed = await installReturnedFiles(answer([entry]), desktop, undefined, 'win32');
    const target = JSON.parse(installed.content[0].text).filePath;
    expect(installed.isError).toBeUndefined();
    expect(target).toContain(path.join(desktop, '.rebel/tool-outputs') + path.sep);
    expect(path.basename(target)).toBe('A_ agenda.pdf');
    expect(await fs.readFile(target, 'utf8')).toBe('file bytes');
  });
  it('rejects one hostile entry without losing the good entry', async () => {
    const installed = await installReturnedFiles(answer([file('bad', { relativePath: '../escape' }), file('good.pdf')]), desktop);
    expect(installed.isError).toBe(true);
    expect(await fs.readFile(path.join(desktop, 'good.pdf'), 'utf8')).toBe('file bytes');
    expect(installed.content).toHaveLength(2);
  });
  it('preserves JSON formatting and big integers in unchanged and rewritten blocks', () => {
    const unchanged = '{"id": 12345678901234567890, "note": "hello"}';
    const changed = '{"id": 12345678901234567890, "path": "/cloud/a.pdf"}';
    const original = { content: [unchanged, changed].map(text => ({ type: 'text', text })) };
    const rewritten = rewriteReturnedResult(original, new Map([['/cloud/a.pdf', '/desktop/a.pdf']]), []);
    expect(rewritten.content[0].text).toBe(unchanged);
    expect(rewritten.content[1].text).toBe(changed.replace('/cloud/a.pdf', '/desktop/a.pdf'));
  });
  it('installs at a free relative place, reuses identical bytes, keeps unrelated metadata and existing isError', async () => {
    const first = await installReturnedFiles(answer(), desktop);
    const target = path.join(desktop, 'report.txt'); const ino = (await fs.stat(target)).ino;
    expect(JSON.parse(first.content[0].text).filePath).toBe(target);
    const second = await installReturnedFiles({ ...answer(), isError: true }, desktop);
    expect((await fs.stat(target)).ino).toBe(ino); expect(second.isError).toBe(true);
    expect(second._meta).toEqual({ keep: true, ui: { resourceUri: 'ui://test' } });
  });
  it('keeps different existing bytes and uses tool-outputs for collisions and temp files', async () => {
    await write('report.txt', 'original', desktop);
    for (const entry of [file(), file('temp.txt', { root: 'temp', relativePath: 'nested/temp.txt' })]) {
      const installed = await installReturnedFiles(answer([entry]), desktop);
      const target = JSON.parse(installed.content[0].text).filePath;
      expect(target).toContain(path.join(desktop, '.rebel/tool-outputs') + path.sep);
      expect(await fs.readFile(target, 'utf8')).toBe('file bytes');
    }
    expect(await fs.readFile(path.join(desktop, 'report.txt'), 'utf8')).toBe('original');
  });
  it.each(['../escape', '/absolute', 'C:\\file', '\\\\server\\share', 'a\0b', 'a/../b', 'a\\b'])('rejects hostile relative path %j before disk work', async relativePath => {
    const installed = await installReturnedFiles(answer([file('report.txt', { relativePath })]), desktop);
    expect(installed.isError).toBe(true); expect(installed._meta).not.toHaveProperty(RETURNED_FILES_META);
    expect(installed.content.at(-1).text).toContain('couldn\'t copy "report.txt"');
    expect(installed.content.at(-1).text).toContain('/cloud/report.txt');
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it.each(['../bad', '/bad', 'C:\\bad', '\\\\server\\share', 'a\0b', 'a/b'])('rejects hostile temp basename %j', async name => {
    expect((await installReturnedFiles(answer([file(name, { root: 'temp' })]), desktop)).isError).toBe(true);
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it.each(['workspace', 'temp'])('rejects a Windows drive or stream form in a %s file before disk work', async root => {
    const installed = await installReturnedFiles(answer([file('a:stream', { root })]), desktop, undefined, 'win32');
    expect(installed.isError).toBe(true);
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it.each(['YQ', 'YR==', 'YQ==\n', '@@@@'])('rejects noncanonical base64 %j', async contentBase64 => {
    expect((await installReturnedFiles(answer([file('x', { contentBase64 })]), desktop)).isError).toBe(true);
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it('rejects wrong version and oversized decoded totals before any writes', async () => {
    expect((await installReturnedFiles(answer(undefined, { version: 2 }), desktop)).isError).toBe(true);
    const contentBase64 = Buffer.alloc(26 * 1024 * 1024).toString('base64');
    const installed = await installReturnedFiles(answer([file('one', { contentBase64 }), file('two', { contentBase64 })]), desktop);
    expect(installed.isError).toBe(true); expect(await fs.readdir(desktop)).toEqual([]);
    expect(MAX_FORWARDED_FILE_BYTES).toBe(50 * 1024 * 1024);
  });
  it('refuses symlinked parents and falls back without writing through them', async () => {
    await fs.symlink(temp, path.join(desktop, 'linked'), 'dir');
    const installed = await installReturnedFiles(answer([file('report.txt', { relativePath: 'linked/report.txt' })]), desktop);
    expect(JSON.parse(installed.content[0].text).filePath).toContain('.rebel');
    expect(await fs.readdir(temp)).toEqual([]);
    await fs.symlink(temp, path.join(desktop, '.rebel/tool-outputs/bad'), 'dir');
    await fs.rm(path.join(desktop, '.rebel/tool-outputs'), { recursive: true });
    await fs.symlink(temp, path.join(desktop, '.rebel/tool-outputs'), 'dir');
    expect((await installReturnedFiles(answer([file('x', { root: 'temp' })]), desktop)).isError).toBe(true);
    expect(await fs.readdir(temp)).toEqual([]);
  });
  it('handles EEXIST at publication without replacing the racing file', async () => {
    const realLink = fs.link.bind(fs); let first = true;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (first) { first = false; await fs.writeFile(to, 'racing bytes', { flag: 'wx' }); }
      return realLink(from, to);
    });
    const installed = await installReturnedFiles(answer(), desktop);
    expect(await fs.readFile(path.join(desktop, 'report.txt'), 'utf8')).toBe('racing bytes');
    expect(await fs.readFile(JSON.parse(installed.content[0].text).filePath, 'utf8')).toBe('file bytes');
  });
  it('keeps delivered files on a later write failure and cleans staging', async () => {
    const realWrite = fs.writeFile.bind(fs); let count = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => { if (++count === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return realWrite(...args); });
    const installed = await installReturnedFiles(answer([file('one'), file('two')]), desktop);
    expect(installed.isError).toBe(true); expect(await fs.readFile(path.join(desktop, 'one'), 'utf8')).toBe('file bytes');
    expect(installed.content.at(-1).text).toBe('The action finished, but Rebel couldn\'t copy "two" to this computer (the file couldn\'t be written here). It\'s saved in the Library (at /cloud/two) and should reach this computer with the next sync. Don\'t repeat the action just to get the file.');
    expect(await fs.readdir(desktop)).toEqual(['.rebel', 'one']);
    expect(await fs.readdir(path.join(desktop, '.rebel/forwarded-files/.returned-staging'))).toEqual([]); expect(installed._meta).not.toHaveProperty(RETURNED_FILES_META);
  });
  it('cleans staging and strips the envelope on cancellation', async () => {
    const controller = new AbortController(); const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => { await realWrite(...args); controller.abort(); });
    const installed = await installReturnedFiles(answer(), desktop, controller.signal);
    expect(installed.isError).toBe(true);
    expect(await fs.readdir(path.join(desktop, '.rebel/forwarded-files/.returned-staging'))).toEqual([]);
    expect(installed.content.at(-1).text).toContain('copying was stopped');
    expect(installed._meta).not.toHaveProperty(RETURNED_FILES_META);
  });
  it('rewrites exact values and reported spans once, preserving Windows JSON escaping and longer undelivered paths', () => {
    const source = '/cloud/report.txt'; const local = 'C:\\Library\\report.txt';
    const original = { ...result({ path: source, other: `${source}.backup`, note: `saved to: ${source}.` }), structuredContent: { path: source } };
    const rewritten = rewriteReturnedResult(original, new Map([[source, local]]), [{ value: `saved to: ${source}.`, spans: [{ source, start: 10, end: 10 + source.length }] }]);
    expect(JSON.parse(rewritten.content[0].text)).toEqual({ path: local, other: `${source}.backup`, note: `saved to: ${local}.` });
    expect(rewritten.structuredContent.path).toBe(local);
  });
  it('fails explicitly without a configured desktop workspace and never falls back to cwd', async () => {
    const installed = await installReturnedFiles(answer(), '');
    expect(installed.isError).toBe(true); expect(installed._meta).not.toHaveProperty(RETURNED_FILES_META);
    expect(installed.content.at(-1).text).toContain("Don't repeat the action just to get the file.");
    expect(await fs.readdir(desktop)).toEqual([]);
  });
  it('strips the private envelope if the installer itself throws, without replaying', async () => {
    const client = new PackageHomeClient({ id: 'notebook', name: 'Notes', transport: 'stdio' }, { url: 'https://cloud.example.test/mcp' });
    const dispatch = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue(answer());
    vi.spyOn(returnedFiles, 'installReturnedFiles').mockRejectedValueOnce(new Error('unexpected installer failure'));
    try {
      const installed = await client.callTool('save', {});
      expect(installed.isError).toBe(true); expect(installed._meta).toEqual({ keep: true, ui: { resourceUri: 'ui://test' } });
      expect(installed.content.at(-1).text).toContain("The action finished");
      expect(installed.content.at(-1).text).toContain("Rebel may not have copied every file");
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
  it('leaves old-cloud answers unchanged and strips metadata even if installation unexpectedly throws', async () => {
    const old = result('old cloud'); expect(await installReturnedFiles(old, desktop)).toBe(old);
    vi.stubEnv('REBEL_WORKSPACE_PATH', desktop);
    const client = new PackageHomeClient({ id: 'notebook', name: 'Notes', transport: 'stdio' }, { url: 'https://cloud.example.test/mcp' });
    const dispatch = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue(answer());
    vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('unexpected'));
    try {
      const installed = await client.callTool('save', {});
      expect(installed.isError).toBe(true); expect(installed._meta).not.toHaveProperty(RETURNED_FILES_META);
      expect(installed.content.at(-1).text).toContain("Don't repeat the action just to get the file."); expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0][0]._meta).toHaveProperty('rebel/returnFiles', { version: 1 });
    } finally { await client.close(); }
  });
});
