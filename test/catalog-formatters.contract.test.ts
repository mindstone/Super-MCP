import { describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { listUnavailablePackages } from "../src/catalogFormatters.js";
import type { PackageRegistry } from "../src/registry.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("catalog formatter wire contract", () => {
  it("emits the canonical reason and retry fields for unavailable packages", () => {
    const pkg = {
      id: "records",
      name: "Records",
      transport: "http" as const,
      base_url: "https://records.example.test/mcp",
      visibility: "default" as const,
    };
    const registry = {
      getPackage: vi.fn(() => pkg),
      getPackages: vi.fn(() => [pkg]),
    } as unknown as PackageRegistry;
    const catalog = new Catalog(registry);
    const generation = catalog.beginRefresh(pkg.id, "startup");
    catalog.commitFailure(pkg.id, generation, {
      status: "error",
      lastError: "connect timed out",
      failureClass: "timeout",
      nextRetryAt: 2_500,
      nextAuthProbeAt: null,
    });

    expect(listUnavailablePackages([pkg], catalog, 1_000)).toEqual([{
      package_id: pkg.id,
      status: "error",
      reason: "connect timed out",
      retry_in_ms: 1_500,
      next_retry_at: 2_500,
    }]);
  });
});
