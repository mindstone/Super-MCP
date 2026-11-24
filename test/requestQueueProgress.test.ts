import { describe, expect, it, vi } from 'vitest';
import { RequestQueueProgress, CONNECTOR_WAIT_META } from '../src/clients/requestQueueProgress.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

describe('RequestQueueProgress wait notices', () => {
  it.each([
    ['a display name', { id: 'acme', name: 'Acme' }, 'Acme'],
    // Rebel writes the connector's display name as its key and its name alike.
    ['its id for a name', { id: 'Acme Notes', name: 'Acme Notes' }, 'Acme Notes'],
  ])('names the connector a queued call waits for when it has %s', async (_case, connector, expected) => {
    const seen: Array<{ _meta?: Record<string, unknown> }> = [];
    new RequestQueueProgress().track({ readMode: 'unnegotiated', onprogress: progress => { seen.push(progress); } }, true, connector);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]._meta?.[CONNECTOR_WAIT_META]).toEqual({ version: 1, phase: 'queued', name: expected });
  });
});
