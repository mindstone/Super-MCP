import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  buildStreamedResultMeta, parseStreamedResult, STREAMED_RESULT_META,
  type StreamedResult, type StreamedResultRefusal,
} from '../src/streamedResultProtocol.js';

// Independently authored wire value: do not derive the expected contract from the builder.
const stream: StreamedResult = {
  version: 1, ref: 'outputs/sample.mp3', bytes: 6, mime: 'audio/mpeg', state: 'running',
};
const fields = { ref: stream.ref, bytes: stream.bytes, mime: stream.mime, state: stream.state };

describe('streamed result v1 wire contract', () => {
  it('builds only the namespaced v1 fields', () => {
    expect(buildStreamedResultMeta(fields)).toEqual({ [STREAMED_RESULT_META]: stream });
    expect(() => buildStreamedResultMeta({ ...fields, bytes: -1 })).toThrow();
  });

  it.each([0, 'stream-token'])('survives the installed SDK schema with token %s', progressToken => {
    const message = { method: 'notifications/progress', params: {
      progressToken, progress: 1, message: 'File started', _meta: { [STREAMED_RESULT_META]: stream },
    } };
    const parsed = ProgressNotificationSchema.parse(message);
    expect(parsed).toEqual(message);
    expect(parseStreamedResult(parsed.params._meta?.[STREAMED_RESULT_META])).toEqual({ ok: true, value: stream });
    const plain = { method: 'notifications/progress', params: { progressToken, progress: 2, message: 'Working' } };
    expect(ProgressNotificationSchema.parse(plain)).toEqual(plain);
    expect(parseStreamedResult(ProgressNotificationSchema.parse(plain).params._meta?.[STREAMED_RESULT_META]))
      .toEqual({ ok: false, reason: 'absent' });
  });

  it.each(['running', 'complete', 'incomplete'] as const)('accepts %s with zero or the largest safe byte count', state => {
    for (const bytes of [0, Number.MAX_SAFE_INTEGER]) {
      const value = { ...stream, state, bytes };
      expect(parseStreamedResult(value)).toEqual({ ok: true, value });
    }
  });

  it.each(['file.mp3', 'my files/音声.mp3', 'outputs/.clip', 'outputs/a..b.mp3', 'a'.repeat(1024)])('accepts portable reference %s', ref => {
    expect(parseStreamedResult({ ...stream, ref })).toEqual({ ok: true, value: { ...stream, ref } });
  });

  it.each(['audio/L16', 'video/mp4', 'image/svg+xml', 'application/vnd.example+json', 'text/plain'])('accepts concrete MIME %s', mime => {
    expect(parseStreamedResult({ ...stream, mime })).toEqual({ ok: true, value: { ...stream, mime } });
  });

  const refusals: Array<{ label: string; value?: unknown; reason: StreamedResultRefusal }> = JSON.parse(
    readFileSync(new URL('./fixtures/streamed-result-refusals.json', import.meta.url), 'utf8'));
  it.each(refusals)('refuses $label: $value', ({ value, reason }) => {
    expect(parseStreamedResult(value)).toEqual({ ok: false, reason });
  });

  it.each([NaN, Infinity, undefined])('also refuses non-JSON byte counts: %s', bytes => {
    expect(parseStreamedResult({ ...stream, bytes })).toEqual({ ok: false, reason: 'bytes' });
  });

  it('ignores additive keys without returning them to consumers', () => {
    expect(parseStreamedResult({ ...stream, futureField: { nested: 'value' } })).toEqual({ ok: true, value: stream });
  });

  it('requires the receiver guard even when the SDK accepts opaque metadata', () => {
    const parsed = ProgressNotificationSchema.parse({ method: 'notifications/progress', params: {
      progressToken: 0, progress: 1, _meta: { [STREAMED_RESULT_META]: { ...stream, version: 2 } },
    } });
    expect(parseStreamedResult(parsed.params._meta?.[STREAMED_RESULT_META])).toEqual({ ok: false, reason: 'version' });
  });
});

it('parses the connector serialized v1 conformance fixture', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/streamed-result-v1.json', import.meta.url), 'utf8'));
  for (const row of rows) expect(parseStreamedResult(row)).toEqual({ ok: true, value: row });
});
