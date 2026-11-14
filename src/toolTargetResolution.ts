import type { CachedTool, CatalogView } from "./catalog.js";
import { getDiscoveryPackageState } from "./catalogFormatters.js";
import type { PackageRegistry } from "./registry.js";
import { resolvePackageId } from "./utils/packageResolution.js";

export type ToolTargetResolution =
  | {
      outcome: "present";
      packageId: string;
      bareToolId: string;
      namespacedToolId: string;
      schemaHash: string;
      tool: CachedTool;
    }
  | {
      outcome: "absent";
      packageId: string;
      bareToolId: string;
      namespacedToolId: string;
    }
  | {
      outcome: "unavailable";
      packageId: string;
      reason:
        | "package_unknown"
        | "package_alias"
        | "connecting"
        | "auth_required"
        | "setup_incomplete"
        | "error";
      detail?: string;
    };

export function resolveToolTarget(
  deps: { catalog: CatalogView; registry: PackageRegistry },
  packageId: string,
  toolId: string,
): ToolTargetResolution {
  // Deliberately mirror only use_tool case 2: strip this package's exact
  // namespace prefix, otherwise keep the id verbatim. R5 bare-name search,
  // package inference from a namespaced id and trimming are call-shape
  // rescues this probe does not apply; callers abstain on those shapes.
  const namespacePrefix = `${packageId}__`;
  const bareToolId = toolId.startsWith(namespacePrefix)
    ? toolId.slice(namespacePrefix.length)
    : toolId;
  const namespacedToolId = `${packageId}__${bareToolId}`;

  if (!deps.registry.getPackage(packageId)) {
    // use_tool's R2 alias rescue runs on an unknown id, so an alias hit is
    // not a certain failure. package_unknown is reserved for "no package and
    // no alias": the one answer that means use_tool will fail.
    return {
      outcome: "unavailable",
      packageId,
      reason:
        resolvePackageId(deps.registry, packageId).outcome === "not_found"
          ? "package_unknown"
          : "package_alias",
    };
  }

  const packageState = getDiscoveryPackageState(deps.catalog, packageId);
  if (packageState.catalogStatus !== "ready") {
    return {
      outcome: "unavailable",
      packageId,
      reason: packageState.catalogStatus,
      ...(packageState.reason ? { detail: packageState.reason } : {}),
    };
  }

  const tool = deps.catalog.getTool(packageId, bareToolId);
  if (!tool) {
    if (packageState.refreshInFlight) {
      return {
        outcome: "unavailable",
        packageId,
        reason: "connecting",
      };
    }
    return {
      outcome: "absent",
      packageId,
      bareToolId,
      namespacedToolId,
    };
  }

  return {
    outcome: "present",
    packageId,
    bareToolId,
    namespacedToolId,
    schemaHash: tool.schemaHash,
    tool,
  };
}
