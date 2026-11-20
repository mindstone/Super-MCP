import { z } from 'zod';

// v1 refuses all Cf characters, including ZWNJ/ZWJ (U+200C/U+200D); allowing them later is a backward-compatible loosening.

export const STREAMED_RESULT_META = 'com.mindstone/stream';
const portableRef = z.string().min(1).max(1024).refine(ref => !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"|?*]/u.test(ref) &&
  ref.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/u.test(part) &&
    !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(part)));
// Concrete type/subtype only: no wildcards, parameters or surrounding whitespace.
const mediaType = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu);
// Strip extra keys for additive v1 compatibility; consumers receive only validated fields.
// A new v1 key must be safely ignorable; anything a consumer must understand needs version 2.
const streamedResultSchema = z.object({
  version: z.literal(1), ref: portableRef, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: mediaType, state: z.enum(['running', 'complete', 'incomplete']),
});
export type StreamedResult = z.infer<typeof streamedResultSchema>;
export type StreamedResultRefusal = 'absent' | 'shape' | keyof StreamedResult;
export type ParsedStreamedResult = { ok: true; value: StreamedResult } | { ok: false; reason: StreamedResultRefusal };

/** Parse params._meta[STREAMED_RESULT_META]; lexical validation grants no filesystem authority. */
export function parseStreamedResult(value: unknown): ParsedStreamedResult {
  if (value === undefined) return { ok: false, reason: 'absent' };
  const parsed = streamedResultSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  const reason = field === 'version' || field === 'ref' || field === 'bytes' || field === 'mime' || field === 'state' ? field : 'shape';
  return { ok: false, reason };
}

/** Put on standard progress params._meta; progress is a per-call ordinal, not bytes. Omit unknown total. */
export function buildStreamedResultMeta(value: Omit<StreamedResult, 'version'>): { [STREAMED_RESULT_META]: StreamedResult } {
  return { [STREAMED_RESULT_META]: streamedResultSchema.parse({ ...value, version: 1 }) };
}
