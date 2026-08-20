import { getLogger } from "./logging.js";

const logger = getLogger();
export const DISCOVERY_WATCHDOG_MS = 500;

export function startDiscoveryWatchdog(
  handler: string,
  budgetMs: number = DISCOVERY_WATCHDOG_MS,
): () => void {
  const startedAt = Date.now();
  const watchdog = setTimeout(() => {
    logger.error("Discovery operation exceeded latency budget", {
      event: "discovery_watchdog_exceeded",
      handler,
      elapsed_ms: Math.max(budgetMs, Date.now() - startedAt),
      budget_ms: budgetMs,
    });
  }, budgetMs);
  watchdog.unref?.();
  return () => clearTimeout(watchdog);
}

export async function withDiscoveryWatchdog<T>(
  handler: string,
  operation: () => Promise<T> | T,
  budgetMs: number = DISCOVERY_WATCHDOG_MS,
): Promise<T> {
  const stopWatchdog = startDiscoveryWatchdog(handler, budgetMs);

  try {
    return await operation();
  } finally {
    stopWatchdog();
  }
}
