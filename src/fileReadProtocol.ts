import { z } from 'zod';
import { RequestSchema, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Request, Notification } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';

export const FILE_READ_MODES = { experimental: { 'files/readModes': { version: 1 } } };
export const DECLARED_FORWARDING = 'files/forwardedInputs';
export const locationSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
export const readOperandSchema = z.object({ location: locationSchema, rawPath: z.string(), resolvedPath: z.string().refine(path.isAbsolute) }).strict();
export const allowedReadSchema = z.object({ location: locationSchema, rawPath: z.string(), canonicalPath: z.string().refine(path.isAbsolute) }).strict();
export const invocationSchema = z.object({ version: z.literal(1), invocationId: z.string().min(1) }).strict();
export const authorizeReadsRequestSchema = RequestSchema.extend({
  method: z.literal('files/authorizeReads'),
  params: invocationSchema.extend({ operands: z.array(readOperandSchema) }),
});
export const authorizeReadsResultSchema = z.discriminatedUnion('outcome', [
  ResultSchema.extend({ version: z.literal(1), outcome: z.literal('allowed'), reads: z.array(allowedReadSchema) }).strict(),
  ResultSchema.extend({ version: z.literal(1), outcome: z.literal('approval_pending'), presentation: z.enum(['queued', 'staged']), reason: z.string() }).strict(),
  ResultSchema.extend({ version: z.literal(1), outcome: z.enum(['denied', 'unavailable']), reason: z.string() }).strict(),
]);
export const readModeSchema = z.discriminatedUnion('mode', [
  z.object({ version: z.literal(1), mode: z.literal('central'), reads: z.array(allowedReadSchema) }).strict(),
  z.object({ version: z.literal(1), mode: z.literal('standalone') }).strict(),
]);
export type ReadOperand = z.infer<typeof readOperandSchema>;
export type AllowedRead = z.infer<typeof allowedReadSchema>;
export type ReadMode = z.infer<typeof readModeSchema>;
export type ReadOutcome = z.infer<typeof authorizeReadsResultSchema>;
export type OriginExtra = Pick<RequestHandlerExtra<Request, Notification>, 'sendRequest' | 'signal'>;

/** This is request context, never part of model arguments. */
export type ToolDispatchContext =
  | { kind: 'standalone'; signal?: AbortSignal; metadata?: Record<string, unknown> }
  | ({ kind: 'origin'; authority: unknown; metadata?: Record<string, unknown> } & OriginExtra);
export interface ChildToolCallContext { readMode: ReadMode | 'unnegotiated'; metadata?: Record<string, unknown>; signal?: AbortSignal }
export const standaloneDispatch: ToolDispatchContext = { kind: 'standalone' };

export function matchesFileVersion(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'version' in value && value.version === 1;
}
export function hasReadAuthority(context: ToolDispatchContext): boolean {
  return context.kind === 'origin' && matchesFileVersion(context.authority);
}
export function assertDispatchActive(context: ToolDispatchContext): void {
  context.signal?.throwIfAborted();
}
export function captureToolDispatch(authority: unknown, metadata: Record<string, unknown> | undefined, extra: OriginExtra): ToolDispatchContext {
  return { kind: 'origin', authority, metadata, signal: extra.signal, sendRequest: extra.sendRequest };
}

/** Only the router's read decision belongs on a child request. */
export function childCallContext(context: ToolDispatchContext, mode?: ReadMode): ChildToolCallContext {
  return { readMode: mode ?? 'unnegotiated', ...(mode ? { metadata: { 'files/readMode': mode } } : {}), signal: context.signal };
}

export class FileReadAdmissionError extends Error {
  constructor(readonly outcome: Exclude<ReadOutcome, { outcome: 'allowed' }>) { super(outcome.reason); }
}

/** One complete batch. The host owns physical canonicalization and policy. */
export async function authorizeReads(operands: ReadOperand[], context: ToolDispatchContext, timeout: number): Promise<AllowedRead[]> {
  assertDispatchActive(context);
  if (!operands.length) return [];
  if (context.kind !== 'origin' || !hasReadAuthority(context)) throw new Error('File read authority is unavailable');
  const binding = invocationSchema.safeParse(context.metadata?.['files/invocation']);
  if (!binding.success) {
    throw new FileReadAdmissionError({ version: 1, outcome: 'unavailable', reason: 'File read authority requires an active invocation binding' });
  }
  const invocation = binding.data;
  const result = authorizeReadsResultSchema.parse(await context.sendRequest({ method: 'files/authorizeReads', params: { ...invocation, operands } }, authorizeReadsResultSchema, { signal: context.signal, timeout }));
  assertDispatchActive(context);
  if (result.outcome !== 'allowed') throw new FileReadAdmissionError(result);
  const key = (value: { location: (string | number)[]; rawPath: string }) => JSON.stringify([value.location, value.rawPath]);
  const requested = new Map(operands.map(operand => [key(operand), operand]));
  const received = new Map(result.reads.map(read => [key(read), read]));
  if (result.reads.length !== requested.size || received.size !== requested.size || [...received.keys()].some(value => !requested.has(value))) {
    throw new Error('File read authority returned an incomplete or mismatched batch');
  }
  return operands.map(operand => received.get(key(operand))!);
}
