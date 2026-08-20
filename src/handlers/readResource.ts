import { ERROR_CODES, ReadResourceResult } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export async function handleReadResource(
  args: { uri: string; _meta?: Record<string, unknown> },
  registry: PackageRegistry,
  catalog: Catalog
): Promise<ReadResourceResult> {
  const { uri, _meta } = args;

  if (!uri) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: "Missing required parameter: uri",
    };
  }

  logger.info("Handling resource read request", { uri });

  let packageId: string | undefined;

  // Strategy 0: Use explicit package ID hint from _meta (highest priority)
  const hintedPackageId = _meta?.rebel_packageId;
  if (typeof hintedPackageId === 'string' && hintedPackageId) {
    if (registry.getPackage(hintedPackageId)) {
      packageId = hintedPackageId;
      logger.debug("Resolved package from _meta.rebel_packageId hint", { uri, package_id: packageId });
    } else {
      logger.warn("_meta.rebel_packageId hint does not match any registered package, falling through to Strategy 1/2", { uri, hinted_id: hintedPackageId });
    }
  }

  // Strategy 1: Use smart mapping from tool metadata
  if (!packageId) {
    packageId = catalog.getPackageForResourceUri(uri);
  }

  // Strategy 2: Fall back to explicit package prefix (ui://package-id/path)
  if (!packageId) {
    const prefixMatch = uri.match(/^ui:\/\/([^/]+)\//);
    if (prefixMatch) {
      const candidateId = prefixMatch[1];
      if (registry.getPackage(candidateId)) {
        packageId = candidateId;
        logger.debug("Resolved package from URI prefix", { uri, package_id: packageId });
      }
    }
  }

  if (!packageId) {
    const knownPrefixes = catalog.getKnownResourcePrefixes();
    throw {
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: `No package found for resource URI: ${uri}. Known resource prefixes: ${knownPrefixes.join(", ") || "none"}`,
    };
  }

  await catalog.ensurePackageLoaded(packageId, { reason: "explicit" });
  const packageStatus = catalog.getPackageStatus(packageId);
  if (packageStatus === "setup_incomplete") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${packageId}' is not set up on this instance. Signing in again will not fix it.`,
      data: {
        package_id: packageId,
        status: packageStatus,
        reason: catalog.getPackageError(packageId) || "setup_incomplete",
      },
    };
  }

  // Get client for package
  const client = await registry.getClient(packageId);
  if (!client) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${packageId}`,
    };
  }

  // Check if client supports resources
  if (!client.readResource) {
    throw {
      code: ERROR_CODES.CAPABILITY_NOT_SUPPORTED,
      message: `Package '${packageId}' client does not support the resources capability`,
    };
  }

  // Forward to upstream server
  try {
    logger.info("Reading resource from upstream package", { uri, package_id: packageId });
    const result = await client.readResource(uri);
    logger.info("Resource read successful", { 
      uri, 
      package_id: packageId,
      content_count: result.contents?.length || 0 
    });

    // Sync catalog after verified success — clear stale error cache
    const catalogStatus = catalog.getPackageStatus(packageId);
    if (catalogStatus === "error" || catalogStatus === "auth_required") {
      catalog.clearPackage(packageId);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Resource read failed", { uri, package_id: packageId, error: errorMessage });
    
    // Check for method not found error (server doesn't support resources)
    if (errorMessage.includes("Method not found") || errorMessage.includes("-32601")) {
      throw {
        code: ERROR_CODES.CAPABILITY_NOT_SUPPORTED,
        message: `Package '${packageId}' does not support the resources capability (Method not found)`,
      };
    }
    
    throw {
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      message: `Failed to read resource from ${packageId}: ${errorMessage}`,
    };
  }
}
