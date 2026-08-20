import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

function createCachedTool(packageId: string, toolName = "tool") {
  return {
    packageId,
    tool: {
      name: toolName,
      description: `${packageId} ${toolName}`,
      inputSchema: { type: "object", properties: {} },
    },
    summary: `${packageId} ${toolName} summary`,
    argsSkeleton: {},
    schemaHash: `${packageId}-${toolName}-schema`,
  };
}

function createCatalogStub(options: {
  etag: () => string;
  getPackageTools?: (packageId: string) => ReturnType<typeof createCachedTool>[];
  statuses?: Record<string, "ready" | "error">;
}): Catalog {
  return {
    etag: vi.fn(options.etag),
    getPackageStatus: vi.fn((packageId: string) => options.statuses?.[packageId] ?? "ready"),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn((packageId: string) =>
      options.statuses?.[packageId] === "error"
        ? { retryAt: null, retryInMs: null, schedule: "none" }
        : { retryAt: null, retryInMs: null, schedule: "none" }),
    getPackageTools: vi.fn(options.getPackageTools ?? ((packageId: string) => [
      createCachedTool(packageId),
    ])),
  } as unknown as Catalog;
}

function createRegistry(packageIds: string[]): PackageRegistry {
  return {
    getPackages: vi.fn(() =>
      packageIds.map((id) => ({
        id,
        name: id,
        transport: "stdio" as const,
      }))
    ),
    getPackage: vi.fn((id: string) => ({
      id,
      name: id,
      transport: "stdio" as const,
      catalogId: id,
    })),
  } as unknown as PackageRegistry;
}

function parseSearchResult(result: { content: Array<{ text: string }> }): {
  total_tools_searched: number;
  results: Array<{ tool_id: string }>;
} {
  return JSON.parse(result.content[0].text) as {
    total_tools_searched: number;
    results: Array<{ tool_id: string }>;
  };
}

const { mockLogger, bm25Factory } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };

  const bm25Factory = vi.fn(() => {
    const documents = new Map<string, Record<string, string>>();
    return {
      defineConfig: vi.fn(),
      definePrepTasks: vi.fn(),
      addDoc: vi.fn((doc: Record<string, string>, id: string) => {
        documents.set(id, doc);
      }),
      consolidate: vi.fn(),
      search: vi.fn((_query: string, limit?: number) => {
        const ids = Array.from(documents.keys());
        const slice = ids.slice(0, limit ?? ids.length);
        return slice.map((id, index) => [id, slice.length - index] as [string, number]);
      }),
      reset: vi.fn(() => {
        documents.clear();
      }),
    };
  });

  return { mockLogger, bm25Factory };
});

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../annotateToolSecurity.js", () => ({
  computeSecurityAnnotation: vi.fn(() => ({})),
  extractRawToolId: vi.fn((toolId: string) => toolId),
}));

vi.mock("wink-bm25-text-search", () => ({
  default: bm25Factory,
}));

describe("search_tools BM25 cache and build coordination", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("deduplicates concurrent callers behind one BM25 build", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a", "pkg-b"]);

    const catalog = createCatalogStub({ etag: () => "etag-1" });

    const searches = Array.from({ length: 4 }, () =>
      handleSearchTools({ query: "calendar", limit: 3 }, registry, catalog)
    );
    await Promise.all(searches);

    expect(catalog.getPackageTools).toHaveBeenCalledTimes(2);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });

  it("captures etag after build so the next call can hit cache", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    let currentEtag = "etag-before-build";
    const getPackageTools = vi.fn((packageId: string) => {
      currentEtag = "etag-after-build";
      return [createCachedTool(packageId)];
    });
    const catalog = createCatalogStub({
      etag: () => currentEtag,
      getPackageTools,
    });

    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);
    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);

    expect(getPackageTools).toHaveBeenCalledTimes(1);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });

  it("invalidates generation so in-flight builds cannot install stale cache", async () => {
    const { handleSearchTools, invalidateSearchCache } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    const catalog = createCatalogStub({ etag: () => "stable-etag" });

    const firstBuild = handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);
    invalidateSearchCache();
    await firstBuild;

    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);

    expect(catalog.getPackageTools).toHaveBeenCalledTimes(2);
    expect(bm25Factory).toHaveBeenCalledTimes(2);
  });

  it("keeps ready packages indexed when another package is degraded", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-ok", "pkg-fail"]);

    const catalog = createCatalogStub({
      etag: () => "etag-iso",
      statuses: { "pkg-fail": "error" },
    });

    const first = parseSearchResult(await handleSearchTools({ query: "tool", limit: 5 }, registry, catalog));
    const second = parseSearchResult(await handleSearchTools({ query: "tool", limit: 5 }, registry, catalog));

    expect(first.total_tools_searched).toBe(1);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.tool_id).toBe("pkg-ok__tool");
    expect(second.total_tools_searched).toBe(1);
    expect(catalog.getPackageTools).toHaveBeenCalledTimes(1);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });

  it("clears failed in-flight BM25 builds so the next call retries and caches", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    const catalog = createCatalogStub({ etag: () => "etag-retry" });

    bm25Factory.mockImplementationOnce(() => {
      throw new Error("intentional bm25 build failure");
    });

    await expect(handleSearchTools({ query: "tool", limit: 2 }, registry, catalog)).rejects.toThrow(
      "intentional bm25 build failure"
    );

    const retry = parseSearchResult(await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog));
    const cached = parseSearchResult(await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog));

    expect(retry.total_tools_searched).toBe(1);
    expect(cached.total_tools_searched).toBe(1);
    expect(catalog.getPackageTools).toHaveBeenCalledTimes(1);
    expect(bm25Factory).toHaveBeenCalledTimes(2);
  });

  it("blocks cache install when invalidated mid-build even if post-build etag changes", async () => {
    const { handleSearchTools, invalidateSearchCache } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    let currentEtag = "etag-A";
    let toolVersion = 1;
    const getPackageTools = vi.fn((packageId: string) => [
      createCachedTool(packageId, `tool-v${toolVersion++}`),
    ]);
    const catalog = createCatalogStub({
      etag: () => currentEtag,
      getPackageTools,
    });

    const firstBuild = handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);
    invalidateSearchCache();
    currentEtag = "etag-B";

    const first = parseSearchResult(await firstBuild);
    const second = parseSearchResult(await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog));

    expect(first.results[0]?.tool_id).toBe("pkg-a__tool-v1");
    expect(second.results[0]?.tool_id).toBe("pkg-a__tool-v2");
    expect(getPackageTools).toHaveBeenCalledTimes(2);
    expect(bm25Factory).toHaveBeenCalledTimes(2);
  });
});
