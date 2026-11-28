import { describe, expect, it, vi } from 'vitest';
import { RequestQueueProgress, CONNECTOR_WAIT_META, risingProgress, SharedWait } from '../src/clients/requestQueueProgress.js';

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

describe('risingProgress', () => {
  it('keeps one call\'s progress rising across its steps, each counting from its own start', async () => {
    const seen: Array<{ progress: number; total?: number }> = [];
    const rising = risingProgress(progress => { seen.push(progress); });
    await rising({ progress: 1 });
    await rising({ progress: 2 });
    // The call itself counts from 0 with a total; a later listing on a replacement client counts from 1 again.
    await rising({ progress: 0, total: 10 });
    await rising({ progress: 4, total: 10 });
    await rising({ progress: 1 });
    await rising({ progress: 2 });
    expect(seen).toEqual([{ progress: 1 }, { progress: 2 }, { progress: 3, total: 13 }, { progress: 7, total: 13 }, { progress: 8 }, { progress: 9 }]);
  });
});

describe('SharedWait', () => {
  const notice = (progress: number, phase: 'queued' | 'admitted') =>
    ({ progress, _meta: { [CONNECTOR_WAIT_META]: { version: 1, phase, name: 'Acme' } } });
  const phases = (seen: Array<{ _meta?: Record<string, unknown> }>) =>
    seen.map(progress => (progress._meta?.[CONNECTOR_WAIT_META] as { phase: string }).phase);
  function pending() {
    let settle!: () => void;
    return { work: new Promise<void>(resolve => { settle = resolve; }), settle };
  }

  it('tells every caller, and stops telling each one once its own work settles', async () => {
    const wait = new SharedWait();
    const attempt = wait.begin();
    const a: Array<{ _meta?: Record<string, unknown> }> = [], b: typeof a = [];
    const first = pending(), second = pending();
    const joinedA = wait.during({ readMode: 'unnegotiated', onprogress: p => { a.push(p); } }, first.work);
    const joinedB = wait.during({ readMode: 'unnegotiated', onprogress: p => { b.push(p); } }, second.work);
    await attempt.onprogress!(notice(1, 'queued'));
    first.settle();
    await joinedA;
    await attempt.onprogress!(notice(2, 'admitted'));
    second.settle();
    await joinedB;
    expect(phases(a)).toEqual(['queued']);
    expect(phases(b)).toEqual(['queued', 'admitted']);
  });

  it('tells a caller who joins while the work waits, but not once the wait is over or the work has ended', async () => {
    const wait = new SharedWait();
    const attempt = wait.begin();
    const work = pending();
    await attempt.onprogress!(notice(1, 'queued'));
    const early: Array<{ _meta?: Record<string, unknown> }> = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { early.push(p); } }, work.work);
    await vi.waitFor(() => expect(phases(early)).toEqual(['queued']));
    await attempt.onprogress!(notice(2, 'admitted'));
    const afterAdmitted: typeof early = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { afterAdmitted.push(p); } }, work.work);
    await attempt.onprogress!(notice(3, 'queued'));
    wait.ended();
    const afterEnded: typeof early = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { afterEnded.push(p); } }, work.work);
    work.settle();
    await work.work;
    expect(phases(afterAdmitted)).toEqual(['queued']);
    expect(afterEnded).toEqual([]);
  });

  it('keeps telling the other callers when one fails to take a notice, and tells no caller who has left', async () => {
    const wait = new SharedWait();
    const attempt = wait.begin();
    const work = pending();
    const left = new AbortController();
    const told: Array<{ _meta?: Record<string, unknown> }> = [], gone: typeof told = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: () => { throw new Error('closed'); } }, work.work);
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { told.push(p); } }, work.work);
    void wait.during({ readMode: 'unnegotiated', signal: left.signal, onprogress: p => { gone.push(p); } }, work.work);
    left.abort();
    await attempt.onprogress!(notice(1, 'queued'));
    work.settle();
    expect(phases(told)).toEqual(['queued']);
    expect(gone).toEqual([]);
  });

  it('tells no caller what an attempt that has been replaced or has ended reports, nor lets it clear the current wait', async () => {
    const wait = new SharedWait();
    const work = pending();
    const told: Array<{ _meta?: Record<string, unknown> }> = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { told.push(p); } }, work.work);
    const expired = wait.begin();
    const current = wait.begin();
    await current.onprogress!(notice(1, 'queued'));
    // The expired attempt's own request is admitted after the current one queued.
    await expired.onprogress!(notice(1, 'admitted'));
    await expired.onprogress!(notice(2, 'queued'));
    const late: typeof told = [];
    void wait.during({ readMode: 'unnegotiated', onprogress: p => { late.push(p); } }, work.work);
    await vi.waitFor(() => expect(phases(late)).toEqual(['queued']));
    wait.ended();
    await current.onprogress!(notice(2, 'admitted'));
    work.settle();
    expect(phases(told)).toEqual(['queued']);
  });
});
