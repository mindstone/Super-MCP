import type { ChildToolCallContext } from '../fileReadProtocol.js';
import { getLogger } from '../logging.js';

/** Waiting calls advance only when their own client's queue does real work. */
export class RequestQueueProgress {
  private waiting = new Set<() => void>();

  moved(): void {
    for (const notify of this.waiting) notify();
  }

  track(context: ChildToolCallContext, queued: boolean) {
    let count = 0;
    const notify = async () => {
      if (context.signal?.aborted) return;
      try { await context.onprogress?.({ progress: ++count }); }
      catch (error) {
        getLogger().warn({ error_type: error instanceof Error ? error.name : typeof error }, 'Queue progress forwarding failed');
      }
    };
    const movement = () => { void notify(); };
    if (queued) this.waiting.add(movement);
    return {
      admit: () => { this.waiting.delete(movement); if (queued) void notify(); },
      dispose: () => { this.waiting.delete(movement); },
      // Queue notices used 1..count, so the connector's own values are shifted past them: MCP progress only increases.
      context: { ...context, onprogress: async (progress) => {
        this.moved();
        await context.onprogress?.(count === 0 ? progress : {
          ...progress, progress: progress.progress + count, ...(progress.total === undefined ? {} : { total: progress.total + count }),
        });
      } } satisfies ChildToolCallContext,
    };
  }
}
