import { ERROR_CODES, ToolInfo } from "../types.js";
import type {
  CatalogRefreshScheduler,
  CatalogView,
  PackageMetadataView,
} from "../catalog.js";
import { buildToolInfos, listUnavailablePackages } from "../catalogFormatters.js";
import { computeSecurityAnnotation, extractRawToolId } from "./annotateToolSecurity.js";
import { getLogger } from "../logging.js";
import { coerceStringifiedJson, coerceStringifiedNumber } from "../utils/normalizeInput.js";
// @ts-expect-error - wink-bm25-text-search doesn't have type definitions
import bm25Constructor from "wink-bm25-text-search";

const logger = getLogger();

interface BM25Engine {
  defineConfig: (config: { fldWeights: Record<string, number> }) => void;
  definePrepTasks: (tasks: Array<(text: string) => string[]>) => void;
  addDoc: (doc: Record<string, string>, id: string) => void;
  consolidate: () => void;
  search: (query: string, limit?: number) => Array<[string, number]>;
  reset: () => void;
}

export interface SearchToolsInput {
  query: string;
  limit?: number;
  threshold?: number;
  packages?: string[];
}

export interface SearchToolsOutput {
  results: Array<ToolInfo & { relevance_score: number }>;
  query: string;
  total_tools_searched: number;
  unavailable_packages: ReturnType<typeof listUnavailablePackages>;
}

// Cache for BM25 engine - rebuilt when catalog changes
let cachedBM25Engine: BM25Engine | null = null;
let cachedEtag: string | null = null;
let cachedToolMap: Map<string, ToolInfo> | null = null;
let buildBM25Promise: Promise<{ engine: BM25Engine; toolMap: Map<string, ToolInfo>; etag: string }> | null = null;
let cacheGeneration = 0;
let buildBM25DedupWaiters = 0;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/_/g, " ") // Split underscores into spaces for tool names
    .split(/\W+/)
    .filter((token) => token.length > 1);
}

async function buildBM25Index(
  packagesView: PackageMetadataView,
  catalog: CatalogView,
): Promise<{ engine: BM25Engine; toolMap: Map<string, ToolInfo> }> {
  const currentEtag = catalog.etag();

  // Return cached if etag matches
  if (cachedBM25Engine && cachedToolMap && cachedEtag === currentEtag) {
    logger.debug("BM25 search index cache hit", {
      etag: currentEtag,
      "bm25.cache_hit": true,
    });
    return { engine: cachedBM25Engine, toolMap: cachedToolMap };
  }

  if (buildBM25Promise) {
    buildBM25DedupWaiters += 1;
    const result = await buildBM25Promise;
    return { engine: result.engine, toolMap: result.toolMap };
  }

  logger.debug("Building BM25 search index", { etag: currentEtag });
  const startTime = Date.now();
  const myGeneration = cacheGeneration;
  buildBM25DedupWaiters = 0;

  buildBM25Promise = (async () => {
    const engine = (bm25Constructor as () => BM25Engine)();
    engine.defineConfig({ fldWeights: { name: 3, summary: 2, params: 1 } });
    engine.definePrepTasks([tokenize]);

    const toolMap = new Map<string, ToolInfo>();

    for (const pkg of packagesView.getPackages()) {
      if (catalog.getPackageStatus(pkg.id) === "ready") {
        const tools = buildToolInfos(pkg.id, catalog.getPackageTools(pkg.id), {
          summarize: true,
          include_schemas: true,
        });

        for (const tool of tools) {
          const paramNames = Object.keys(tool.schema?.properties || {}).join(" ");

          engine.addDoc(
            {
              name: tool.name,
              summary: tool.summary || "",
              params: paramNames,
            },
            tool.tool_id
          );
          toolMap.set(tool.tool_id, {
            ...tool,
            package_id: pkg.id,
          });
        }
      } else {
        logger.debug("Skipping package for search index", {
          package_id: pkg.id,
          catalog_status: catalog.getPackageStatus(pkg.id),
        });
      }
    }

    engine.consolidate();

    return {
      engine,
      toolMap,
      etag: catalog.etag(),
    };
  })();

  try {
    const result = await buildBM25Promise;
    const shouldInstallCache = cacheGeneration === myGeneration;

    if (shouldInstallCache) {
      cachedBM25Engine = result.engine;
      cachedToolMap = result.toolMap;
      cachedEtag = result.etag;
    }

    logger.debug("BM25 search index built", {
      tool_count: result.toolMap.size,
      elapsed_ms: Date.now() - startTime,
      cold_path: true,
      dedup_count: buildBM25DedupWaiters,
      concurrency: 1,
      cache_generation: myGeneration,
      cache_installed: shouldInstallCache,
      "bm25.cache_hit": false,
    });

    return { engine: result.engine, toolMap: result.toolMap };
  } finally {
    buildBM25Promise = null;
    buildBM25DedupWaiters = 0;
  }
}

export async function handleSearchTools(
  input: SearchToolsInput,
  packagesView: PackageMetadataView,
  catalog: CatalogView,
  refreshScheduler?: CatalogRefreshScheduler,
): Promise<any> {
  let { query, limit = 5, threshold = 0.0, packages } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  limit = coerceStringifiedNumber(limit, { handler: "search_tools", field: "limit" }) as typeof limit;
  threshold = coerceStringifiedNumber(threshold, { handler: "search_tools", field: "threshold" }) as typeof threshold;
  packages = coerceStringifiedJson<string[]>(packages, "array", { handler: "search_tools", field: "packages" }) as typeof packages;

  if (!query || query.trim().length === 0) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: "Query parameter is required and cannot be empty",
    };
  }

  const configuredPackages = packagesView.getPackages();
  for (const pkg of configuredPackages) {
    refreshScheduler?.scheduleRefresh(pkg.id);
  }

  const { engine, toolMap } = await buildBM25Index(packagesView, catalog);

  // Search with BM25
  const searchResults = engine.search(query, Math.min(limit * 2, 50));

  // Build results with relevance scores
  const results: Array<ToolInfo & { relevance_score: number }> = [];
  let maxScore = 0;

  for (const [, score] of searchResults) {
    if (score > maxScore) maxScore = score;
  }

  for (const [toolId, rawScore] of searchResults) {
    const tool = toolMap.get(toolId);
    if (!tool) continue;

    if (packages && packages.length > 0) {
      if (!packages.includes(tool.package_id!)) continue;
    }

    const normalizedScore = maxScore > 0 ? rawScore / maxScore : 0;
    if (normalizedScore < threshold) continue;

    const rawToolId = extractRawToolId(toolId);
    const packageConfig = packagesView.getPackage(tool.package_id!);
    const annotation = computeSecurityAnnotation(tool.package_id!, packageConfig?.catalogId, rawToolId);

    results.push({
      ...tool,
      relevance_score: Math.round(normalizedScore * 100) / 100,
      ...annotation,
    });

    if (results.length >= limit) break;
  }

  const output: SearchToolsOutput = {
    results,
    query,
    total_tools_searched: toolMap.size,
    unavailable_packages: listUnavailablePackages(
      packages && packages.length > 0
        ? configuredPackages.filter((pkg) => packages.includes(pkg.id))
        : configuredPackages,
      catalog,
    ),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(output, null, 2),
      },
    ],
    isError: false,
  };
}

// Export function to invalidate cache (called when config changes)
export function invalidateSearchCache(): void {
  cacheGeneration += 1;
  cachedBM25Engine = null;
  cachedEtag = null;
  cachedToolMap = null;
  logger.debug("Search cache invalidated", {
    cache_generation: cacheGeneration,
  });
}
