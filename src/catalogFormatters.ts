import type {
  CachedTool,
  CatalogPackageMetadata,
  CatalogView,
} from "./catalog.js";
import type { CatalogStatus, ToolInfo } from "./types.js";
import { summarizePackage } from "./summarize.js";

export interface CatalogToolInfoOptions {
  summarize?: boolean;
  include_schemas?: boolean;
  include_descriptions?: boolean;
}

export interface DiscoveryPackageState {
  catalogStatus: CatalogStatus;
  reason?: string;
  retryInMs: number | null;
  nextRetryAt: number | null;
}

export interface UnavailableCatalogPackage {
  package_id: string;
  status: Exclude<CatalogStatus, "ready">;
  reason: string;
  retry_in_ms: number | null;
  next_retry_at: number | null;
}

export function getDiscoveryPackageState(
  catalog: CatalogView,
  packageId: string,
  now: number = Date.now(),
): DiscoveryPackageState {
  const observedStatus = catalog.getPackageStatus(packageId);
  const catalogStatus = observedStatus === "unknown" ? "connecting" : observedStatus;
  const retryHint = catalog.getRetryHint(packageId, now);
  const catalogError = catalog.getPackageError(packageId);
  const reason = catalogError ?? (
    catalogStatus === "connecting"
      ? "Initial catalog observation is still in progress."
      : catalogStatus === "auth_required"
        ? "Authentication required."
        : catalogStatus === "setup_incomplete"
          ? "Package setup is incomplete on this instance."
          : catalogStatus === "error"
            ? "Package is unavailable."
            : undefined
  );

  return {
    catalogStatus,
    reason,
    retryInMs: retryHint.retryInMs,
    nextRetryAt: retryHint.retryAt,
  };
}

export function listUnavailablePackages(
  packages: readonly CatalogPackageMetadata[],
  catalog: CatalogView,
  now: number = Date.now(),
): UnavailableCatalogPackage[] {
  return packages.flatMap((pkg) => {
    const state = getDiscoveryPackageState(catalog, pkg.id, now);
    if (state.catalogStatus === "ready") return [];
    return [{
      package_id: pkg.id,
      status: state.catalogStatus,
      reason: state.reason ?? "Package is unavailable.",
      retry_in_ms: state.retryInMs,
      next_retry_at: state.nextRetryAt,
    }];
  });
}

export function buildPackageSummary(
  packageConfig: CatalogPackageMetadata,
  catalog: CatalogView,
): string {
  const snapshot = catalog.getPackageDiagnostics(packageConfig.id);
  if (snapshot.status !== "ready") {
    const retained = snapshot.retainedToolCount > 0;
    if (snapshot.status === "auth_required") {
      return retained
        ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; authentication required)`
        : `${packageConfig.transport} MCP package (authentication required)`;
    }
    if (snapshot.status === "setup_incomplete") {
      return retained
        ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; setup incomplete)`
        : `${packageConfig.transport} MCP package (setup incomplete)`;
    }
    if (snapshot.status === "error") {
      const reason = snapshot.lastError ? `: ${snapshot.lastError}` : "";
      return retained
        ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; unavailable${reason})`
        : `${packageConfig.transport} MCP package (unavailable${reason})`;
    }
    return `${packageConfig.transport} MCP package (connecting)`;
  }

  const tools = catalog.getPackageTools(packageConfig.id);
  if (tools.length === 0) {
    return `${packageConfig.transport} MCP package (no tools available)`;
  }
  return summarizePackage(packageConfig, tools.map((cachedTool) => cachedTool.tool));
}

export function buildToolInfos(
  packageId: string,
  tools: readonly CachedTool[],
  options: CatalogToolInfoOptions = {},
): ToolInfo[] {
  return tools.map((cachedTool) => {
    const namespacedId = `${packageId}__${cachedTool.tool.name}`;
    return {
      package_id: packageId,
      tool_id: namespacedId,
      name: namespacedId,
      description: options.include_descriptions
        ? cachedTool.tool.description
        : undefined,
      summary: options.summarize ? cachedTool.summary : undefined,
      args_skeleton: options.summarize ? cachedTool.argsSkeleton : undefined,
      schema_hash: cachedTool.schemaHash,
      schema: options.include_schemas ? cachedTool.tool.inputSchema : undefined,
      ...(cachedTool.tool?.annotations
        ? { annotations: cachedTool.tool.annotations }
        : {}),
    };
  });
}
