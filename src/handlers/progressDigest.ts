import { createHash } from 'node:crypto';

/** Private producer control, computed on the complete result before any rewrite. */
export interface ProgressDigestV1 { version: 1; digest: string }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported canonical result');
}

export function computeProgressDigest(result: unknown): ProgressDigestV1 {
  return { version: 1, digest: `sha256:${createHash('sha256').update(canonicalJson(result), 'utf8').digest('hex')}` };
}
