import { beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";

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

function createCatalog(): Catalog {
  return new Catalog({
    getPackage: vi.fn((packageId: string) => ({ id: packageId, name: packageId })),
    getPackages: vi.fn(() => [{ id: "alpha", name: "Alpha" }]),
  } as unknown as PackageRegistry);
}

describe("catalog state transition observability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs each catalog status transition with retry and generation diagnostics", () => {
    const catalog = createCatalog();

    const generation = catalog.beginRefresh("alpha", "startup");
    catalog.commitFailure("alpha", generation, {
      status: "error",
      lastError: "connect timed out",
      failureClass: "timeout",
      nextRetryAt: 12_345,
      nextAuthProbeAt: null,
    });

    expect(mockLogger.info).toHaveBeenNthCalledWith(
      1,
      "Catalog package state changed",
      {
        package_id: "alpha",
        from: "unknown",
        to: "connecting",
        reason: "startup",
        consecutive_failures: 0,
        next_retry_at: null,
        generation,
      },
    );
    expect(mockLogger.info).toHaveBeenNthCalledWith(
      2,
      "Catalog package state changed",
      {
        package_id: "alpha",
        from: "connecting",
        to: "error",
        reason: "timeout",
        consecutive_failures: 1,
        next_retry_at: 12_345,
        generation,
      },
    );
  });
});
