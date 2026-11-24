// FOX-11496: the marker a package endpoint puts in a JSON-RPC error's `data`
// when its own registry has closed, so the call was refused before dispatch.
// Only the endpoint's own `instanceof RegistryClosedError` may set it; the
// endpoint strips this key from any other error any of its handlers passes on.
export const HOME_MARKER_KEY = 'rebelHome';

export interface RegistryClosedMarker {
  v: 1;
  disposition: 'registry_closed';
}

export const REGISTRY_CLOSED_MARKER: RegistryClosedMarker = { v: 1, disposition: 'registry_closed' };

// The experimental capability a package endpoint declares, `{ version: 1 }`, to say it strips the marker above from
// every error but its own refusal. Without it (an older cloud) the marker on an error proves nothing.
export const HOME_MARKER_GUARD = 'rebel/homeMarkerGuard';

export function isRegistryClosedMarker(value: unknown): value is RegistryClosedMarker {
  return isExactRecord(value, ['v', 'disposition']) && value.v === 1 && value.disposition === 'registry_closed';
}

// The cloud route's refusal of a call it did not pass on: HTTP 503 with this header and the body below.
export const ADMISSION_HEADER = 'rebel-admission';
export const NOT_ADMITTED_V1 = 'not-admitted; v=1';

/** The refusal's reason when `body` is exactly the v1 refusal body; anything else is not a refusal. */
export function readNotAdmitted(body: unknown): 'shutting_down' | undefined {
  if (!isExactRecord(body, ['admission'])) return undefined;
  const admission = body.admission;
  if (!isExactRecord(admission, ['v', 'disposition', 'reason', 'retryAfterMs'])) return undefined;
  const { v, disposition, reason, retryAfterMs } = admission;
  return v === 1 && disposition === 'not_admitted' && reason === 'shutting_down' &&
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? reason : undefined;
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
