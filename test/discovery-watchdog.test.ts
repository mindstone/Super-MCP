import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDiscoveryWatchdog } from "../src/discoveryWatchdog.js";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../src/logging.js", () => ({ getLogger: () => mockLogger }));

describe("discovery watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("reports discovery work that exceeds 500ms without cancelling it", async () => {
    let resolveOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
    const guarded = withDiscoveryWatchdog("search_tools", () => operation);

    await vi.advanceTimersByTimeAsync(499);
    expect(mockLogger.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Discovery operation exceeded latency budget",
      {
        event: "discovery_watchdog_exceeded",
        handler: "search_tools",
        elapsed_ms: 500,
        budget_ms: 500,
      },
    );

    resolveOperation("complete");
    await expect(guarded).resolves.toBe("complete");
  });
});
