import { z } from 'zod';
import { RequestSchema, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ErrorCode, McpError, type Request, type Notification, type Progress } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { getLogger } from './logging.js';

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
export type OriginExtra = Pick<RequestHandlerExtra<Request, Notification>, 'sendRequest' | 'sendNotification' | 'signal'>;
type ProgressContext = { onprogress?: (progress: Progress) => void | Promise<void> };

/** This is request context, never part of model arguments. */
export interface ConnectorDispatchEvidence { started: boolean }
export type ToolDispatchContext = ProgressContext & { connectorDispatch?: ConnectorDispatchEvidence } & (
  | { kind: 'standalone'; signal?: AbortSignal; metadata?: Record<string, unknown> }
  | ({ kind: 'origin'; authority: unknown; metadata?: Record<string, unknown> } & OriginExtra));
export interface ChildToolCallContext extends ProgressContext { readMode: ReadMode | 'unnegotiated'; metadata?: Record<string, unknown>; signal?: AbortSignal; connectorDispatch?: ConnectorDispatchEvidence }
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
  const token = metadata?.progressToken;
  return { kind: 'origin', authority, metadata, signal: extra.signal, sendRequest: extra.sendRequest, sendNotification: extra.sendNotification,
    ...(typeof token === 'string' || typeof token === 'number' ? { onprogress: (progress: Progress) => extra.sendNotification({
      method: 'notifications/progress', params: { ...progress, progressToken: token },
    }) } : {}) };
}

/** Only the router's read decision belongs on a child request. */
export function childCallContext(context: ToolDispatchContext, mode?: ReadMode): ChildToolCallContext {
  return { readMode: mode ?? 'unnegotiated', ...(mode ? { metadata: { 'files/readMode': mode } } : {}), signal: context.signal, ...(context.onprogress ? { onprogress: context.onprogress } : {}), connectorDispatch: context.connectorDispatch };
}

const orderedProgressTransports = new WeakMap<Transport, Transport['onmessage']>();

/** SDK callbacks are synchronous; drain their ordered sends inside the idle call budget. */
export async function relayToolProgress<T>(context: ProgressContext & { signal?: AbortSignal }, timeout: number,
  call: (options: { signal: AbortSignal; onprogress?: (progress: Progress) => void; resetTimeoutOnProgress: true }) => Promise<T>, transport?: Transport): Promise<T> {
  if (transport && orderedProgressTransports.get(transport) !== transport.onmessage) {
    // SDK 1.32.1 defers _onnotification; synchronous _onresponse deletes the progress handler.
    // Give notifications their turn first; re-check this workaround on SDK upgrades.
    const receive = transport.onmessage;
    let incoming = Promise.resolve();
    transport.onmessage = (message, extra) => {
      incoming = incoming.then(() => { receive?.(message, extra); }).catch(error => { transport.onerror?.(error); });
    };
    orderedProgressTransports.set(transport, transport.onmessage);
  }
  const deadline = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
  const expire = () => deadline.abort(new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));
  let timer = setTimeout(expire, timeout);
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  let accepting = true, forwarding = false, succeeded = false, pending = Promise.resolve();
  const shared = Symbol(), queued: { key: string | symbol; progress: Progress }[] = [];
  const slots = new Map<string | symbol, (typeof queued)[number]>();
  const terminals = new Map<string | symbol, (typeof queued)[number]>();
  const onprogress = (progress: Progress) => {
    if (!accepting || signal.aborted) return;
    clearTimeout(timer); timer = setTimeout(expire, timeout);
    const stream = (progress as Progress & { _meta?: Record<string, unknown> })._meta?.['com.mindstone/stream'] as { ref?: unknown; state?: unknown } | undefined;
    const ref = typeof stream?.ref === 'string' ? stream.ref : shared;
    // Delivery markers only; validation belongs to the receiver. Bound terminal
    // slots separately, keeping the latest per ref and routing overflow to shared.
    const terminal = stream?.state === 'complete' || stream?.state === 'incomplete';
    const bucket = terminal && (terminals.has(ref) || terminals.size < 256) ? terminals : slots;
    const key = bucket === terminals || (!terminal && (slots.has(ref) || slots.size < 15)) ? ref : shared;
    const slot = bucket.get(key);
    if (slot) { slot.progress = progress; queued.splice(queued.indexOf(slot), 1); queued.push(slot); }
    else { const next = { key, progress }; bucket.set(key, next); queued.push(next); }
    if (forwarding) return;
    forwarding = true;
    pending = (async () => {
      while (queued.length && !signal.aborted) {
        const next = queued.shift()!;
        if (slots.get(next.key) === next) slots.delete(next.key);
        if (terminals.get(next.key) === next) terminals.delete(next.key);
        try { await context.onprogress?.(next.progress); }
        catch (error) { getLogger().warn({ error_type: error instanceof Error ? error.name : typeof error }, 'Tool progress forwarding failed'); }
      }
      forwarding = false;
    })();
  };
  try {
    signal.throwIfAborted();
    const result = await Promise.race([call({ signal, onprogress, resetTimeoutOnProgress: true }), aborted]);
    succeeded = true;
    return result;
  } finally {
    accepting = false;
    try { await Promise.race([pending, aborted]); }
    catch (error) {
      if (!succeeded) throw error;
      getLogger().warn({ in_flight: forwarding, queued: queued.length > 0 }, 'Tool finished with undelivered progress');
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
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
