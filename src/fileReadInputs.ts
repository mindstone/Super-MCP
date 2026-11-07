import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { matchesFileVersion, type ReadOperand } from './fileReadProtocol.js';

const selectorSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
const conditionBase = { selector: selectorSchema.refine(parts => !parts.includes('*'), 'Conditions require a concrete selector'), relativeTo: z.enum(['root', 'parent']) };
export const readInputsSchema = z.object({ version: z.literal(1), inputs: z.array(z.object({
  selector: selectorSchema,
  base: z.enum(['connectorCwd', 'connectorCwdNative', 'workspace', 'workspaceRealpath', 'workspaceRealpathOrTmp']),
  expandTilde: z.boolean(),
  nonLocalPrefixes: z.array(z.string().min(1)).optional(),
  when: z.array(z.discriminatedUnion('test', [
    z.object({ ...conditionBase, test: z.literal('equals'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
    z.object({ ...conditionBase, test: z.enum(['undefined', 'falsy']) }).strict(),
  ])).optional(),
}).strict()) }).strict();
export type ReadInputs = z.infer<typeof readInputsSchema>;
export interface InputBases { workspace?: string; connectorCwd: string; home?: string; temp?: string }

/** Unknown versions are undeclared. Malformed matched declarations stop execution. */
export function getReadInputs(meta: Record<string, unknown> | undefined): ReadInputs | undefined {
  const value = meta?.['files/readInputs'];
  if (!matchesFileVersion(value)) return undefined;
  return readInputsSchema.parse(value);
}
function at(value: unknown, selector: (string | number)[]): unknown {
  for (const part of selector) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
function expand(value: unknown, selector: (string | number)[], location: (string | number)[] = []): (string | number)[][] {
  if (!selector.length) return [location];
  const [part, ...tail] = selector;
  if (part === '*') return Array.isArray(value) ? value.flatMap((item, index) => expand(item, tail, [...location, index])) : [];
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return [];
  return expand((value as Record<string | number, unknown>)[part], tail, [...location, part]);
}
/** Absolute, as the child's own call would reach it. `..` stays for that call's filesystem walk. */
export function childSpelling(target: string, connectorCwd: string, paths: typeof path = path): string {
  const { root } = paths.parse(target);
  if (!root) return `${connectorCwd}${paths.sep}${target}`;
  if (root.length === 1) return paths.parse(connectorCwd).root + target.slice(1);
  return paths.isAbsolute(target) ? target : paths.resolve(connectorCwd, target);
}

/** Only rootless spellings use the input default; rooted and drive-relative ones keep the child's cwd and drive. */
export function connectorOperandBase(spelling: string, connectorCwd: string, inputBase: string, paths: typeof path = path): string {
  return paths.parse(spelling).root ? connectorCwd : inputBase;
}

async function selectInputRoot(base: ReadInputs['inputs'][number]['base'], bases: InputBases, connectorInputBase: string): Promise<string | undefined> {
  if (base === 'connectorCwd' || base === 'connectorCwdNative') return connectorInputBase;
  const workspace = bases.workspace?.trim();
  if (base === 'workspaceRealpathOrTmp') {
    // Canonicalize before resolving '..'; an unavailable configured root must not select temp.
    return fs.realpath(path.resolve(bases.connectorCwd, workspace || (bases.temp ?? os.tmpdir())));
  }
  if (!workspace || (base === 'workspaceRealpath' && !path.isAbsolute(workspace))) return undefined;
  if (base === 'workspace') return path.resolve(bases.connectorCwd, workspace);
  try { return await fs.realpath(childSpelling(workspace, bases.connectorCwd)); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return undefined;
  }
}

export async function expandReadInputs(args: unknown, declaration: ReadInputs, bases: InputBases, connectorInputBase = bases.connectorCwd, walkNativeParents = true): Promise<ReadOperand[]> {
  const operands = new Map<string, ReadOperand>();
  for (const input of declaration.inputs) {
    for (const location of expand(args, input.selector)) {
      const rawPath = at(args, location);
      if (typeof rawPath !== 'string' || !rawPath || input.nonLocalPrefixes?.some(prefix => rawPath.startsWith(prefix))) continue;
      if (input.when && !input.when.every(condition => {
        const value = at(condition.relativeTo === 'root' ? args : at(args, location.slice(0, -1)), condition.selector);
        if (condition.test === 'undefined') return value === undefined;
        if (condition.test === 'falsy') return !value;
        return condition.test === 'equals' && value === condition.value;
      })) continue;
      const expanded = input.expandTilde && rawPath.startsWith('~') ? path.join(bases.home ?? os.homedir(), rawPath.slice(1)) : rawPath;
      const base = await selectInputRoot(input.base, bases, connectorOperandBase(expanded, bases.connectorCwd, connectorInputBase));
      // Missing roots fail closed with a missing approved operand, not the standalone missing-base error.
      if (!base) continue;
      // Central nomination needs the physical target; standalone leaves the walk to the child.
      const resolvedPath = input.base === 'connectorCwdNative' && expanded.split(/[\\/]/).includes('..')
        ? walkNativeParents ? await fs.realpath(childSpelling(expanded, base)) : childSpelling(expanded, base)
        : path.resolve(base, expanded);
      const key = JSON.stringify(location);
      if (operands.has(key) && operands.get(key)!.resolvedPath !== resolvedPath) throw new Error('Conflicting file input bases');
      operands.set(key, { location, rawPath, resolvedPath });
    }
  }
  return [...operands.values()];
}

/** Clone the execution view; equal literal strings at other locations stay intact. */
export function replaceReadLocations(args: unknown, operands: ReadOperand[], replacements: Map<string, string> | ((operand: ReadOperand) => string | undefined)): unknown {
  let cloned = structuredClone(args);
  for (const operand of operands) {
    const { location, rawPath } = operand;
    const replacement = typeof replacements === 'function' ? replacements(operand) : replacements.get(rawPath);
    if (!replacement) continue;
    if (!location.length) { if (cloned === rawPath) cloned = replacement; continue; }
    const parent = at(cloned, location.slice(0, -1));
    const key = location[location.length - 1];
    if (parent && typeof parent === 'object' && at(parent, [key]) === rawPath) {
      Object.defineProperty(parent, key, { value: replacement, enumerable: true, writable: true, configurable: true });
    }
  }
  return cloned;
}
