import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import type { ChildToolCallContext } from '../fileReadProtocol.js';
import { getLogger } from '../logging.js';
import type { PackageConfig } from '../types.js';

/** Progress `_meta` key telling the caller why a call waits: queued behind another request, then taken by the connector. */
export const CONNECTOR_WAIT_META = 'com.mindstone/connectorWait';

/** Waiting calls advance only when their own client's queue does real work. */
export class RequestQueueProgress {
  private waiting = new Set<() => void>();

  moved(): void {
    for (const notify of this.waiting) notify();
  }

  /** The connector's name is sent so the caller can say what the call waits for, in its own words. */
  track(context: ChildToolCallContext, queued: boolean, connector: Pick<PackageConfig, 'name'>) {
    let count = 0;
    const notify = async (phase: 'queued' | 'admitted') => {
      if (context.signal?.aborted) return;
      try { await context.onprogress?.({ progress: ++count, _meta: { [CONNECTOR_WAIT_META]: { version: 1, phase, ...(connector.name ? { name: connector.name } : {}) } } }); }
      catch (error) {
        getLogger().warn({ error_type: error instanceof Error ? error.name : typeof error }, 'Queue progress forwarding failed');
      }
    };
    const movement = () => { void notify('queued'); };
    if (queued) { this.waiting.add(movement); void notify('queued'); }
    return {
      admit: () => { this.waiting.delete(movement); if (queued) void notify('admitted'); },
      dispose: () => { this.waiting.delete(movement); },
      // Queue notices used 1..count and a connector may start at 0, so its values are shifted past count: MCP progress only increases.
      context: { ...context, onprogress: async (progress) => {
        this.moved();
        const shift = count === 0 ? 0 : count + 1;
        await context.onprogress?.(shift === 0 ? progress : {
          ...progress, progress: progress.progress + shift, ...(progress.total === undefined ? {} : { total: progress.total + shift }),
        });
      } } satisfies ChildToolCallContext,
    };
  }
}

/**
 * One call's progress across its steps (health listings, a tool-details listing, the call itself), any of
 * which may count again from its own start. A value that would not rise past the last one sent moves past it,
 * its total with it, so the caller's progress only increases, as MCP requires.
 */
export function risingProgress(forward: (progress: Progress & { _meta?: Record<string, unknown> }) => void | Promise<void>) {
  let sent: number | undefined, offset = 0;
  return async (progress: Progress & { _meta?: Record<string, unknown> }) => {
    if (sent !== undefined && progress.progress + offset <= sent) offset = sent + 1 - progress.progress;
    sent = progress.progress + offset;
    await forward(offset === 0 ? progress : {
      ...progress, progress: sent, ...(progress.total === undefined ? {} : { total: progress.total + offset }),
    });
  };
}
