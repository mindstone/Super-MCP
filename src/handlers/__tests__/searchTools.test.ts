import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";
import type { ToolInfo } from "../../types.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createTool(toolId: string): ToolInfo {
  return {
    package_id: "unused",
    tool_id: toolId,
    name: toolId,
    summary: `${toolId} summary`,
    schema_hash: `${toolId}-schema`,
    schema: { type: "object", properties: {} },
  };
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

    const firstBuildEntered = createDeferred();
    const releaseBuild = createDeferred();
    let gateOpen = false;

    const ensurePackageLoaded = vi.fn(async () => {
      if (!gateOpen) {
        gateOpen = true;
        firstBuildEntered.resolve();
        await releaseBuild.promise;
      }
    });
    const buildToolInfos = vi.fn(async (packageId: string) => [createTool(`${packageId}__tool`)]);

    const catalog = {
      etag: vi.fn(() => "etag-1"),
      ensurePackageLoaded,
      buildToolInfos,
    } as unknown as Catalog;

    const searches = Array.from({ length: 4 }, () =>
      handleSearchTools({ query: "calendar", limit: 3 }, registry, catalog)
    );
    await firstBuildEntered.promise;
    releaseBuild.resolve();
    await Promise.all(searches);

    expect(ensurePackageLoaded).toHaveBeenCalledTimes(2);
    expect(buildToolInfos).toHaveBeenCalledTimes(2);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });

  it("captures etag after build so the next call can hit cache", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    let currentEtag = "etag-before-build";
    const ensurePackageLoaded = vi.fn(async () => {});
    const buildToolInfos = vi.fn(async (packageId: string) => {
      currentEtag = "etag-after-build";
      return [createTool(`${packageId}__tool`)];
    });

    const catalog = {
      etag: vi.fn(() => currentEtag),
      ensurePackageLoaded,
      buildToolInfos,
    } as unknown as Catalog;

    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);
    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);

    expect(ensurePackageLoaded).toHaveBeenCalledTimes(1);
    expect(buildToolInfos).toHaveBeenCalledTimes(1);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });

  it("invalidates generation so in-flight builds cannot install stale cache", async () => {
    const { handleSearchTools, invalidateSearchCache } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-a"]);

    const buildEntered = createDeferred();
    const releaseBuild = createDeferred();

    const ensurePackageLoaded = vi.fn(async () => {
      buildEntered.resolve();
      await releaseBuild.promise;
    });
    const buildToolInfos = vi.fn(async (packageId: string) => [createTool(`${packageId}__tool`)]);

    const catalog = {
      etag: vi.fn(() => "stable-etag"),
      ensurePackageLoaded,
      buildToolInfos,
    } as unknown as Catalog;

    const firstBuild = handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);
    await buildEntered.promise;
    invalidateSearchCache();
    releaseBuild.resolve();
    await firstBuild;

    await handleSearchTools({ query: "tool", limit: 2 }, registry, catalog);

    expect(ensurePackageLoaded).toHaveBeenCalledTimes(2);
    expect(buildToolInfos).toHaveBeenCalledTimes(2);
    expect(bm25Factory).toHaveBeenCalledTimes(2);
  });

  it("keeps successful packages indexed when one package load fails", async () => {
    const { handleSearchTools } = await import("../searchTools.js");
    const registry = createRegistry(["pkg-ok", "pkg-fail"]);

    const ensurePackageLoaded = vi.fn(async (packageId: string) => {
      if (packageId === "pkg-fail") {
        throw new Error("intentional package failure");
      }
    });
    const buildToolInfos = vi.fn(async (packageId: string) => [createTool(`${packageId}__tool`)]);

    const catalog = {
      etag: vi.fn(() => "etag-iso"),
      ensurePackageLoaded,
      buildToolInfos,
    } as unknown as Catalog;

    const first = parseSearchResult(await handleSearchTools({ query: "tool", limit: 5 }, registry, catalog));
    const second = parseSearchResult(await handleSearchTools({ query: "tool", limit: 5 }, registry, catalog));

    expect(first.total_tools_searched).toBe(1);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.tool_id).toBe("pkg-ok__tool");
    expect(second.total_tools_searched).toBe(1);
    expect(ensurePackageLoaded).toHaveBeenCalledTimes(2);
    expect(buildToolInfos).toHaveBeenCalledTimes(1);
    expect(bm25Factory).toHaveBeenCalledTimes(1);
  });
});
