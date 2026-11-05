import { replaceReadLocations } from './fileReadInputs.js';
import type { AllowedRead, ReadOperand } from './fileReadProtocol.js';
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getLogger } from "./logging.js";

export const FORWARDED_FILES_RELATIVE_DIR = ".rebel/forwarded-files";
export const MAX_FORWARDED_FILE_BYTES = 50 * 1024 * 1024;
export const forwardedFilesSchema = z.array(z.object({ path: z.string(), name: z.string(), contentBase64: z.string() }));
type ForwardedFile = z.infer<typeof forwardedFilesSchema>[number];

/** First non-empty parent workspace wins, including when the host key is blank. */
export function getWorkspacePath(): string | undefined {
  return process.env.REBEL_WORKSPACE_PATH?.trim() || process.env.MCP_WORKSPACE_PATH?.trim() || undefined;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mapStrings(value: unknown, map: (text: string) => unknown): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
  return value;
}

function visitStrings(value: unknown, visit: (text: string, location: (string | number)[]) => void, location: (string | number)[] = []): void {
  if (typeof value === "string") visit(value, location);
  else if (Array.isArray(value)) { value.forEach((item, index) => visitStrings(item, visit, [...location, index])); }
  else if (value && typeof value === "object") { for (const [key, item] of Object.entries(value)) visitStrings(item, visit, [...location, key]); }
}

/** Forwarding never considers relative strings; avoid discovery for no-file calls. */
export function hasAbsoluteForwardingInput(args: unknown): boolean {
  let found = false;
  visitStrings(args, text => { if (path.isAbsolute(text)) found = true; });
  return found;
}

function validName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !/[/\\\0]/u.test(name);
}

/** No symlinks beneath the canonical root, including the leaf. */
async function checkedStat(root: string, target: string) {
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  let stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("Workspace requires real directory ancestors"), { code: "ENOTDIR" });
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw Object.assign(new Error("Workspace requires real directory ancestors"), { code: "ENOTDIR" });
  }
  return stat;
}

function warnRead(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (!["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(code ?? "")) getLogger().warn("Forwarded file could not be read safely", { code });
}

export interface ForwardingOptions {
  /** Present only for a matched declaration and a capable receiver. */
  operands?: ReadOperand[];
  authorize?: (operands: ReadOperand[]) => Promise<AllowedRead[]>;
  signal?: AbortSignal;
}

/** Select source-owned files first, authorize the batch, then open bytes. */
export async function collectForwardedFiles(args: unknown, workspacePath = getWorkspacePath(), options: ForwardingOptions = {}) {
  const allowLinked = options.operands !== undefined && options.authorize !== undefined;
  const operands: ReadOperand[] = options.operands ?? [];
  if (!options.operands) visitStrings(args, (rawPath, location) => {
    if (rawPath.length <= 4096 && path.isAbsolute(rawPath) && validName(path.basename(rawPath))) operands.push({ location, rawPath, resolvedPath: path.resolve(rawPath) });
  });
  const files: ForwardedFile[] = [];
  let bytes = 0;
  if (!workspacePath || operands.length === 0) return { files, bytes };
  let root: string;
  try { root = await fs.realpath(workspacePath); }
  catch (error) { warnRead(error); return { files, bytes }; }
  const configuredRoot = path.resolve(workspacePath);
  const candidates = new Map<string, { target: string; operands: ReadOperand[] }>();
  for (const operand of operands) {
    const source = operand.rawPath;
    if (source.length > 4096 || !path.isAbsolute(source) || !validName(path.basename(source))) continue;
    const lexical = path.resolve(source);
    const sourceRoot = within(configuredRoot, lexical) ? configuredRoot : within(root, lexical) ? root : undefined;
    if (!sourceRoot) continue;
    const target = path.join(root, path.relative(sourceRoot, lexical));
    try {
      // Legacy discovery retains its old no-symlink candidate set. Only exact
      // declarations add lexical aliases through linked directories.
      const leaf = allowLinked ? await fs.stat(target) : await checkedStat(root, target);
      if (!leaf.isFile()) continue;
      const candidate = candidates.get(source) ?? { target, operands: [] };
      candidate.operands.push({ ...operand, resolvedPath: target });
      candidates.set(source, candidate);
    } catch (error) { warnRead(error); }
  }
  options.signal?.throwIfAborted();
  const batch = [...candidates.values()].flatMap(candidate => candidate.operands);
  const reads = options.authorize && batch.length ? await options.authorize(batch) : undefined;
  options.signal?.throwIfAborted();
  const approved = new Map(reads?.map(read => [read.rawPath, read.canonicalPath]));
  for (const [source, candidate] of candidates) {
    const target = reads ? approved.get(source) : candidate.target;
    if (!target) throw new Error("File read authority omitted a forwarding candidate");
    try {
      options.signal?.throwIfAborted();
      const leaf = await fs.lstat(target);
      if (!leaf.isFile() || leaf.isSymbolicLink()) continue;
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        const recheck = allowLinked ? await fs.lstat(target) : await checkedStat(root, candidate.target);
        if (!stat.isFile() || stat.dev !== leaf.dev || stat.ino !== leaf.ino || stat.dev !== recheck.dev || stat.ino !== recheck.ino || recheck.isSymbolicLink()) continue;
        const remaining = MAX_FORWARDED_FILE_BYTES - bytes;
        if (stat.size > remaining) return { files, bytes: bytes + stat.size, tooLarge: true };
        const chunks: Buffer[] = [];
        let total = 0;
        const scratch = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining + 1));
        while (true) {
          options.signal?.throwIfAborted();
          const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, remaining - total + 1), null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > remaining) return { files, bytes: bytes + total, tooLarge: true };
          chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
        }
        files.push({ path: source, name: path.basename(source), contentBase64: Buffer.concat(chunks).toString("base64") });
        bytes += total;
      } finally { await handle.close(); }
    } catch (error) { options.signal?.throwIfAborted(); warnRead(error); }
  }
  return { files, bytes };
}

export function forwardedFilesTooLargeMessage(bytes: number, name: string): string {
  return `The files for ${name} add up to ${(Math.ceil(bytes / 1024 / 1024 * 10) / 10).toFixed(1)} MB, over the 50 MB limit for one send, so nothing was sent. Try fewer or smaller files.`;
}

/** Run against private per-call copies; callers turn thrown errors into tool errors. */
export async function runWithForwardedFiles<T>(args: unknown, meta: unknown, run: (args: unknown) => Promise<T>, workspacePath = getWorkspacePath(), connectorName = "this connector", operands?: ReadOperand[]): Promise<T> {
  if (meta === undefined) return run(args);
  const parsed = forwardedFilesSchema.safeParse(meta);
  if (!parsed.success) throw new Error("Invalid forwarded files");
  const files = parsed.data;
  if (files.length === 0) return run(args);
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.contentBase64, "base64"), 0);
  if (bytes > MAX_FORWARDED_FILE_BYTES) throw new Error(forwardedFilesTooLargeMessage(bytes, connectorName));
  const decoded = files.map(file => {
    const buffer = Buffer.from(file.contentBase64, "base64");
    if (!validName(file.name) || buffer.toString("base64") !== file.contentBase64) throw new Error("Invalid forwarded file");
    return { ...file, buffer };
  });
  if (!workspacePath?.trim()) throw new Error("Workspace directory is not configured");
  const root = await fs.realpath(workspacePath).catch(error => {
    if (error.code === "ENOENT") throw new Error("Workspace directory is not configured");
    throw error;
  });
  let parent = root;
  for (const part of FORWARDED_FILES_RELATIVE_DIR.split("/")) {
    parent = path.join(parent, part);
    try { await checkedStat(root, parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (!(await checkedStat(root, parent)).isDirectory()) throw new Error("Forwarded files require real directories");
  }
  const call = await fs.mkdtemp(path.join(parent, "call-"));
  try {
    const replacements = new Map<string, string>();
    for (const [index, file] of decoded.entries()) {
      const directory = path.join(call, String(index));
      await fs.mkdir(directory, { mode: 0o700 });
      const target = path.join(directory, file.name);
      await fs.writeFile(target, file.buffer, { flag: "wx", mode: 0o600 });
      replacements.set(file.path, target);
    }
    return await run(operands ? replaceReadLocations(args, operands, replacements) : mapStrings(args, text => replacements.get(text) ?? text));
  } finally {
    try { await fs.rm(call, { recursive: true, force: true }); }
    catch (error) { getLogger().warn("Forwarded file cleanup failed", { code: (error as NodeJS.ErrnoException).code }); }
  }
}
