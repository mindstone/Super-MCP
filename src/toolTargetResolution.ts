import type { CachedTool, CatalogView } from "./catalog.js";
import { getDiscoveryPackageState } from "./catalogFormatters.js";
import type { PackageRegistry } from "./registry.js";

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
  // R2 package-alias expansion, and package inference from a namespaced id are
  // call-shape rescues; applying them to this probe could falsely deny a valid
  // aliased call before use_tool gets the chance to rescue it.
  const namespacePrefix = `${packageId}__`;
  const bareToolId = toolId.startsWith(namespacePrefix)
    ? toolId.slice(namespacePrefix.length)
    : toolId;
  const namespacedToolId = `${packageId}__${bareToolId}`;

  if (!deps.registry.getPackage(packageId)) {
    return {
      outcome: "unavailable",
      packageId,
      reason: "package_unknown",
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
