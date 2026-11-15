import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FORWARDED_FILES_RELATIVE_DIR, getWorkspacePath, MAX_FORWARDED_FILE_BYTES } from './forwardedFiles.js';
import { getLogger } from './logging.js';

export const RETURNED_FILES_META = 'rebel/returnedFiles';
export const RETURNED_FILES_LIMITS = { text: 1024 * 1024, probes: 1024, files: 128, nodes: 8192, depth: 32 };
// Filesystem clocks can trail Date.now(); FAT rounds modification times to two seconds.
const MTIME_TOLERANCE_MS = 2000;
const boundedPath = z.string().min(1).max(4096);
const safePart = (part: string) => Boolean(part) && part !== '.' && part !== '..' &&
  !part.includes('\0') && !/[\\/]/u.test(part);
const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
function windowsName(part: string): string {
  const safe = Array.from(part, char => char.charCodeAt(0) < 32 || /[:?"<>|*]/u.test(char) ? '_' : char)
    .join('').replace(/[. ]+$/u, suffix => '_'.repeat(suffix.length));
  return windowsDevice.test(safe) ? `_${safe}` : safe;
}
const spanSchema = z.object({ source: boundedPath, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict();
const referenceSchema = z.object({ value: z.string().max(RETURNED_FILES_LIMITS.text), spans: z.array(spanSchema).max(512) }).strict()
  .refine(r => r.spans.every(span => span.end > span.start && r.value.slice(span.start, span.end) === span.source));
type Reference = z.infer<typeof referenceSchema>;
const fileSchema = z.union([
  z.object({ source: boundedPath, root: z.enum(['workspace', 'temp']), relativePath: boundedPath, name: boundedPath,
    contentBase64: z.string().max(Math.ceil(MAX_FORWARDED_FILE_BYTES / 3) * 4).refine(value => Buffer.from(value, 'base64').toString('base64') === value) }).strict(),
  z.object({ source: boundedPath, root: z.enum(['workspace', 'temp']).optional(), tooLarge: z.literal(true), bytes: z.number().int().nonnegative() }).strict(),
  z.object({ source: boundedPath, root: z.enum(['workspace', 'temp']).optional(), error: z.string().max(256) }).strict(),
]);
const envelopeSchema = z.object({ version: z.literal(1), files: z.array(z.unknown()).max(RETURNED_FILES_LIMITS.files),
  references: z.array(referenceSchema).max(512), truncated: z.literal(true).optional(), collectionFailed: z.literal(true).optional() }).strict()
  .refine(value => value.references.reduce((total, r) => total + r.value.length, 0) <= RETURNED_FILES_LIMITS.text * 4 &&
    value.references.reduce((total, r) => total + r.spans.length, 0) <= 512);
type File = z.infer<typeof fileSchema>;
type Envelope = Omit<z.infer<typeof envelopeSchema>, 'files'> & { files: File[] };
type Result = { content?: unknown; structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean; [key: string]: unknown };
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
function warn(error: unknown) { getLogger().warn('Returned file delivery failed', { code: code(error) }); }
function reason(error: unknown, signal?: AbortSignal): string {
  return signal?.aborted || (error instanceof Error && error.name === 'AbortError')
    ? 'copying was stopped' : "the file couldn't be written here";
}
function mapLeaves(value: unknown, transform: (text: string) => string, depth = 0): unknown {
  if (depth > RETURNED_FILES_LIMITS.depth) return value;
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(item => mapLeaves(item, transform, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapLeaves(item, transform, depth + 1)]));
  return value;
}
/** Replace JSON value tokens only; preserve numeric precision and all untouched text. */
function rewriteJsonStringTokens(text: string, transform: (text: string) => string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/gu, (token: string, offset: number) => {
    if (/^\s*:/u.test(text.slice(offset + token.length))) return token;
    const value = JSON.parse(token) as string;
    const changed = transform(value);
    return changed === value ? token : JSON.stringify(changed);
  });
}
function transformResult<T extends Result>(result: T, transform: (text: string) => string): T {
  const output = { ...result };
  if (Array.isArray(result.content)) {
    output.content = result.content.map(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block;
      try { JSON.parse(block.text); } catch { return { ...block, text: transform(block.text) }; }
      const text = rewriteJsonStringTokens(block.text, transform);
      return text === block.text ? block : { ...block, text };
    });
  }
  if ('structuredContent' in result) output.structuredContent = mapLeaves(result.structuredContent, transform);
  return output;
}
function looksLikeRelativePath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) &&
    value.length <= 4096 && !/[\n\r\0]/u.test(value);
}
function spanEnds(tail: string): number[] {
  return [...tail.matchAll(/(?=[\s.,;:!?)\]}"'`]|$)/gu)]
    .map(match => match.index!)
    .filter(end => end > 0 && end <= 4096 && (
      end === tail.length || /[\s"'`]/u.test(tail[end]) || /^[.,;:!?)\]}"'`]+(?:\s|$)/u.test(tail.slice(end))
    )).reverse();
}

/** Discovery is a per-user path heuristic, not proof that this call owns a temp file. */
export async function collectReturnedFiles(result: Result, workspacePath = getWorkspacePath(), tempPath = tmpdir(), startedAt = Date.now()): Promise<Envelope> {
  const envelope: Envelope = { version: 1, files: [], references: [] };
  let probes = 0, inspected = 0, nodes = 0, bytes = 0;
  let limited = false;
  const probe = async <T>(run: () => Promise<T>): Promise<T> => {
    if (probes >= RETURNED_FILES_LIMITS.probes) {
      limited = true;
      throw Object.assign(new Error('Discovery bound reached'), { code: 'EDISCOVERYLIMIT' });
    }
    probes++;
    return run();
  };
  const roots: Array<{ kind: 'workspace' | 'temp'; lexical: string; real: string }> = [];
  for (const [kind, value] of [['workspace', workspacePath], ['temp', tempPath]] as const) {
    if (!value) continue;
    try { roots.push({ kind, lexical: path.resolve(value), real: await probe(() => fs.realpath(value)) }); }
    catch (error) { getLogger().debug('Returned file root is unavailable', { code: code(error) }); }
  }
  const workspace = roots.find(root => root.kind === 'workspace');
  const excluded = workspace && path.join(workspace.real, FORWARDED_FILES_RELATIVE_DIR);
  const prefixes = [...new Set(roots.flatMap(root => [root.lexical, root.real]))];
  const skipText = (text: string) => {
    limited = true;
    if (prefixes.some(prefix => text.includes(prefix + path.sep))) envelope.truncated = true;
  };
  const strings: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (nodes >= RETURNED_FILES_LIMITS.nodes || depth > RETURNED_FILES_LIMITS.depth) {
      limited = true;
      if (typeof value === 'string') skipText(value);
      return;
    }
    nodes++;
    if (typeof value === 'string') {
      if (inspected + value.length > RETURNED_FILES_LIMITS.text) {
        skipText(value);
        return;
      }
      inspected += value.length;
      strings.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  if (Array.isArray(result.content)) for (const block of result.content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.length > RETURNED_FILES_LIMITS.text - inspected) {
      skipText(block.text);
      continue;
    }
    try { visit(JSON.parse(block.text)); } catch { visit(block.text); }
  }
  visit(result.structuredContent);
  const seen = new Set<string>();
  const failed = new Set<string>();
  const inspections = new Map<string, ReturnType<typeof fs.lstat>>();
  const inspect = async (target: string) => {
    const cached = inspections.get(target);
    if (cached) return cached;
    const stat = probe(() => fs.lstat(target)).catch(error => {
      getLogger().debug('Returned file candidate could not be inspected', { code: code(error) });
      throw error;
    });
    inspections.set(target, stat);
    return stat;
  };
  const admit = async (source: string, relative = false): Promise<boolean> => {
    if (seen.has(source)) return true;
    if (failed.has(source)) return false;
    failed.add(source);
    if (!source || source.length > 4096 || source.includes('\0') || source.split(path.sep).some(part => Buffer.byteLength(part) > 255)) return false;
    const lexical = relative && workspace ? path.resolve(workspace.lexical, source) : path.resolve(source);
    const owner = roots.find(root => (!relative || root.kind === 'workspace') && (within(root.lexical, lexical) || within(root.real, lexical)));
    if (!owner) return false;
    const base = within(owner.lexical, lexical) ? owner.lexical : owner.real;
    const target = path.join(owner.real, path.relative(base, lexical));
    if (excluded && within(excluded, target)) return false;
    if (envelope.files.length >= RETURNED_FILES_LIMITS.files) {
      envelope.truncated = true;
      limited = true;
      return false;
    }
    let eligible = false;
    try {
      let current = owner.real;
      const parts = path.relative(owner.real, target).split(path.sep).filter(Boolean);
      for (const part of parts) {
        current = path.join(current, part);
        const stat = await inspect(current);
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) return false;
      }
      const leaf = await inspect(target);
      if (!leaf.isFile() || leaf.isSymbolicLink() || (relative && leaf.mtimeMs < startedAt - MTIME_TOLERANCE_MS)) return false;
      eligible = true;
      const real = await probe(() => fs.realpath(target));
      // Exclude forwarded inputs after canonical resolution even if temp contains workspace.
      if (!within(owner.real, real) || (excluded && within(excluded, real))) return false;
      seen.add(source);
      const handle = await probe(() => fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.ino !== leaf.ino || stat.dev !== leaf.dev) throw new Error('Source changed');
        const remaining = MAX_FORWARDED_FILE_BYTES - bytes;
        if (stat.size > remaining) {
          envelope.files.push({ source, root: owner.kind, tooLarge: true, bytes: stat.size });
          return true;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const scratch = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining + 1));
        while (true) {
          const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, remaining - total + 1), null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > remaining) {
            envelope.files.push({ source, root: owner.kind, tooLarge: true, bytes: total });
            return true;
          }
          chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
        }
        envelope.files.push({ source, root: owner.kind, relativePath: path.relative(owner.real, real).split(path.sep).join('/'), name: path.basename(real), contentBase64: Buffer.concat(chunks).toString('base64') });
        bytes += total;
      } finally { await handle.close(); }
      return true;
    } catch (error) {
      if (code(error) === 'EDISCOVERYLIMIT') {
        skipText(source);
        return false;
      }
      if (!eligible) return false;
      // Preserve a single descriptor even if closing the handle failed after reading.
      const prior = envelope.files.findIndex(file => file.source === source);
      if (prior >= 0) envelope.files.splice(prior, 1);
      envelope.files.push({ source, root: owner.kind, error: "the file couldn't be read" });
      seen.add(source);
      warn(error);
      return true;
    }
  };
  const referencesByValue = new Map<string, Reference>();
  let referenceCount = 0, referenceText = 0;
  const addReference = (value: string, source: string, start: number, end: number) => {
    let reference = referencesByValue.get(value);
    if (reference?.spans.some(span => span.source === source && span.start === start && span.end === end)) return;
    if (referenceCount >= 512 || referenceText + (reference ? 0 : value.length) > RETURNED_FILES_LIMITS.text * 4) {
      limited = true;
      envelope.truncated = true;
      return;
    }
    if (!reference) {
      reference = { value, spans: [] };
      referencesByValue.set(value, reference);
      envelope.references.push(reference);
      referenceText += value.length;
    }
    reference.spans.push({ source, start, end });
    referenceCount++;
  };
  for (const value of strings) {
    if (probes >= RETURNED_FILES_LIMITS.probes) {
      skipText(value);
      continue;
    }
    if (path.isAbsolute(value) && await admit(value)) continue;
    if (looksLikeRelativePath(value) && await admit(value, true)) continue;
    // Start only at a known root, then shorten on token/punctuation boundaries.
    for (let start = 0; start < value.length; start++) {
      if (!prefixes.some(prefix => value.startsWith(prefix + path.sep, start))) continue;
      // Quotes are span boundaries, not hard stops: a longer existing filename may contain them.
      const tail = value.slice(start, start + 4097).split(/[\n\r<>]/u)[0];
      for (const end of spanEnds(tail)) {
        if (probes >= RETURNED_FILES_LIMITS.probes) {
          skipText(value);
          break;
        }
        const source = tail.slice(0, end);
        if (await admit(source)) {
          addReference(value, source, start, start + end);
          start += end - 1;
          break;
        }
      }
    }
  }
  // A folder is a reference only, never a file candidate. Installation decides whether it maps.
  const parents = new Set(envelope.files.filter(f => 'root' in f && f.root === 'workspace' && path.isAbsolute(f.source)).map(f => path.dirname(f.source)));
  for (const value of strings) for (const parent of parents) {
    if (value === parent) continue;
    for (let start = value.indexOf(parent); start >= 0; start = value.indexOf(parent, start + parent.length)) {
      if ((start === 0 || /[\s"'`(]/u.test(value[start - 1])) && (start + parent.length === value.length || /[\s.,;!?)"'`]/u.test(value[start + parent.length])))
        addReference(value, parent, start, start + parent.length);
    }
  }
  if (limited) getLogger().warn('Returned file discovery reached a bound', { probes, nodes, inspected, candidateSkipped: Boolean(envelope.truncated) });
  return envelope;
}

export function stripReturnedFiles<T extends Result>(result: T): T {
  if (!result._meta || !(RETURNED_FILES_META in result._meta)) return result;
  const meta = { ...result._meta };
  delete meta[RETURNED_FILES_META];
  return { ...result, _meta: meta };
}
export function returnedFileFailure<T extends Result>(result: T, source?: string, why?: string, filename = source && path.posix.basename(source), root?: 'workspace' | 'temp'): T {
  let text = "The action finished, but Rebel may not have copied every file it saved to this computer. Check before using any path above that isn't on this computer.";
  if (source && filename && root) {
    const location = root === 'workspace'
      ? `It's saved in the Library (at ${source}) and should reach this computer with the next sync. Don't repeat the action just to get the file.`
      : `It was only saved temporarily (at ${source}) and isn't in the Library. Run the action again only if the file is needed.`;
    text = `The action finished, but Rebel couldn't copy "${filename}" to this computer (${why}). ${location}`;
  }
  return { ...stripReturnedFiles(result), isError: true, content: [...(Array.isArray(result.content) ? result.content : []), { type: 'text',
    text }] };
}
export function rewriteReturnedResult<T extends Result>(result: T, replacements: Map<string, string>, references: Reference[]): T {
  const byValue = new Map<string, Reference['spans']>();
  for (const reference of references) byValue.set(reference.value, reference.spans);
  return transformResult(result, text => {
    if (replacements.has(text)) return replacements.get(text)!;
    let end = 0, output = '';
    for (const r of (byValue.get(text) ?? []).sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (r.start < end || !replacements.has(r.source)) continue;
      output += text.slice(end, r.start) + replacements.get(r.source);
      end = r.end;
    }
    return output + text.slice(end);
  });
}
/** Verify/create one real ancestor at a time, including canonical containment. */
async function directories(root: string, directory: string, signal?: AbortSignal, create = true): Promise<void> {
  if (!within(root, directory)) throw new Error('Destination escapes workspace');
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await fs.realpath(root) !== root)
    throw Object.assign(new Error('Destination requires a real workspace'), { code: 'EUNSAFE' });
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    signal?.throwIfAborted();
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
    }
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create && code(error) === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !within(root, await fs.realpath(current))) throw Object.assign(new Error('Destination requires real directories'), { code: 'EUNSAFE' });
  }
}
async function identical(root: string, target: string, bytes: Buffer, signal?: AbortSignal): Promise<boolean> {
  await directories(root, path.dirname(target), signal, false);
  let handle;
  try {
    const leaf = await fs.lstat(target);
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.size !== bytes.length) return false;
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== leaf.ino || stat.dev !== leaf.dev) return false;
    const existing = Buffer.alloc(bytes.length + 1);
    let total = 0;
    while (total < existing.length) {
      const read = await handle.read(existing, total, existing.length - total, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    return total === bytes.length && existing.subarray(0, total).equals(bytes);
  } catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
  finally { await handle?.close(); }
}
async function publish(root: string, target: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  const stagingRoot = path.join(root, FORWARDED_FILES_RELATIVE_DIR, '.returned-staging');
  await directories(root, stagingRoot, signal);
  signal?.throwIfAborted();
  const staging = await fs.mkdtemp(path.join(stagingRoot, 'call-'));
  try {
    const file = path.join(staging, 'file');
    signal?.throwIfAborted();
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600, signal });
    signal?.throwIfAborted();
    await directories(root, path.dirname(target), signal);
    signal?.throwIfAborted();
    try { await fs.link(file, target); }
    catch (error) {
      if (!['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(code(error) ?? '')) throw error;
      getLogger().debug('Returned file publication uses exclusive copy', { code: code(error) });
      signal?.throwIfAborted();
      let output;
      try {
        output = await fs.open(target, 'wx', 0o600);
        try { await output.writeFile(bytes, { signal }); }
        finally { await output.close(); }
      }
      catch (copyError) {
        if (output) {
          try { await fs.rm(target, { force: true }); } catch (cleanupError) { warn(cleanupError); }
        }
        throw copyError;
      }
    }
  } finally {
    try { await fs.rm(staging, { recursive: true, force: true }); } catch (error) { warn(error); }
  }
}

/** Consume the private envelope before materialisation, caches or model serialization. */
export async function installReturnedFiles<T extends Result>(answer: T, workspacePath = getWorkspacePath(), signal?: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<T> {
  const raw = answer._meta?.[RETURNED_FILES_META];
  let result = stripReturnedFiles(answer);
  if (raw === undefined) return result;
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return returnedFileFailure(result);
  const envelope = parsed.data;
  const files: File[] = [];
  for (const entry of envelope.files) {
    const parsedFile = fileSchema.safeParse(entry);
    if (!parsedFile.success) {
      const identity = z.object({ source: boundedPath, name: boundedPath.optional(), root: z.enum(['workspace', 'temp']).optional() }).safeParse(entry);
      result = identity.success
        ? returnedFileFailure(result, identity.data.source, "the file couldn't be written here", identity.data.name, identity.data.root)
        : returnedFileFailure(result);
      continue;
    }
    const file = parsedFile.data;
    if ('contentBase64' in file && (!safePart(file.name) || !file.relativePath.split('/').every(part => safePart(part) && (platform !== 'win32' || !/^[a-z]:/iu.test(part))))) {
      result = returnedFileFailure(result, file.source, 'this computer refused the file name', file.name, file.root);
      continue;
    }
    files.push(file);
  }
  const total = files.reduce((sum, file) => sum + ('contentBase64' in file ? Buffer.byteLength(file.contentBase64, 'base64') : 0), 0);
  if (total > MAX_FORWARDED_FILE_BYTES) return returnedFileFailure(result);
  const genericFailure = envelope.truncated || envelope.collectionFailed;
  if (!files.length && !genericFailure) return result;
  const replacements = new Map<string, string>();
  let root: string;
  try {
    signal?.throwIfAborted();
    if (!workspacePath?.trim()) throw new Error('Workspace directory is not configured');
    root = await fs.realpath(workspacePath);
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid workspace');
  } catch (error) {
    warn(error);
    for (const file of files) result = returnedFileFailure(result, file.source, reason(error, signal), 'name' in file ? file.name : undefined, file.root);
    return genericFailure ? returnedFileFailure(result) : result;
  }
  const call = randomUUID();
  for (const file of files) {
    if ('tooLarge' in file) { result = returnedFileFailure(result, file.source, 'too large to copy', undefined, file.root); continue; }
    if ('error' in file) { result = returnedFileFailure(result, file.source, "the file couldn't be read", undefined, file.root); continue; }
    try {
      signal?.throwIfAborted();
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const samePlace = path.join(root, ...file.relativePath.split('/'));
      const outputName = platform === 'win32' ? windowsName(file.name) : file.name;
      const samePlaceAllowed = platform !== 'win32' || (outputName === file.name && file.relativePath.split('/').every(part => windowsName(part) === part));
      let delivered: string | undefined;
      let clash = false;
      if (file.root === 'workspace' && samePlaceAllowed) {
        try {
          if (await identical(root, samePlace, bytes, signal)) delivered = samePlace;
          else {
            await publish(root, samePlace, bytes, signal);
            delivered = samePlace;
          }
        } catch (error) {
          signal?.throwIfAborted();
          // A refused/taken original destination uses the shared output directory.
          if (!['EEXIST', 'EUNSAFE', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes(code(error) ?? '')) throw error;
          clash = code(error) === 'EEXIST';
          if (!clash) warn(error);
        }
      }
      if (!delivered) {
        const directory = path.join(root, '.rebel', 'tool-outputs', call);
        for (let attempt = 0; attempt < 128; attempt++) {
          const target = path.join(directory, attempt ? `${attempt}-${outputName}` : outputName);
          try {
            await publish(root, target, bytes, signal);
            delivered = target;
            break;
          }
          catch (error) { if (code(error) !== 'EEXIST') throw error; }
        }
        if (!delivered) throw new Error('No free output name');
      }
      replacements.set(file.source, delivered);
      if (clash) result = { ...result, content: [...(Array.isArray(result.content) ? result.content : []), { type: 'text',
        text: `A different file already had the name "${file.name}" on this computer, so this copy is at ${delivered}.` }] };
      if (file.root === 'workspace' && delivered === samePlace && path.isAbsolute(file.source)) replacements.set(path.dirname(file.source), path.dirname(delivered));
    } catch (error) {
      warn(error);
      result = returnedFileFailure(result, file.source, reason(error, signal), file.name, file.root);
    }
  }
  if (genericFailure) result = returnedFileFailure(result);
  return rewriteReturnedResult(result, replacements, envelope.references);
}
