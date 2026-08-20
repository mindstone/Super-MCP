import { ListToolPackagesInput, ListToolPackagesOutput } from "../types.js";
import type {
  CatalogRefreshScheduler,
  CatalogView,
  PackageMetadataView,
} from "../catalog.js";
import {
  buildPackageSummary,
  getDiscoveryPackageState,
} from "../catalogFormatters.js";
import { coerceStringifiedBoolean, coerceStringifiedNumber } from "../utils/normalizeInput.js";

export async function handleListToolPackages(
  input: ListToolPackagesInput,
  packagesView: PackageMetadataView,
  catalog: CatalogView,
  refreshScheduler?: CatalogRefreshScheduler,
): Promise<any> {
  let { safe_only = true, limit = 100, include_health = true } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  safe_only = coerceStringifiedBoolean(safe_only, { handler: "list_tool_packages", field: "safe_only" }) as typeof safe_only;
  limit = coerceStringifiedNumber(limit, { handler: "list_tool_packages", field: "limit" }) as typeof limit;
  include_health = coerceStringifiedBoolean(include_health, {
    handler: "list_tool_packages",
    field: "include_health",
  }) as typeof include_health;

  const packages = packagesView.getPackages({ safe_only }).slice(0, limit);
  const now = Date.now();
  const packageInfos = packages.map((pkg) => {
    refreshScheduler?.scheduleRefresh(pkg.id);
    const state = getDiscoveryPackageState(catalog, pkg.id, now);
    const health = include_health
      ? state.catalogStatus === "ready"
        ? "ok" as const
        : state.catalogStatus === "error"
          ? "error" as const
          : "unavailable" as const
      : undefined;

    const authMode: "env" | "oauth2" | "none" = pkg.transport === "http"
      ? (pkg.auth?.mode ?? "none")
      : "env";

    return {
      package_id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      transport: pkg.transport,
      auth_mode: authMode,
      tool_count: catalog.countTools(pkg.id),
      health,
      summary: pkg.description || buildPackageSummary(pkg, catalog),
      visibility: pkg.visibility,
      catalog_status: state.catalogStatus,
      catalog_error: state.reason,
      retry_in_ms: state.retryInMs,
      next_retry_at: state.nextRetryAt,
    };
  });

  const result: ListToolPackagesOutput = {
    packages: packageInfos,
    catalog_etag: catalog.etag(),
    updated_at: new Date().toISOString(),
    snapshot_complete: catalog.isSnapshotComplete(),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}
