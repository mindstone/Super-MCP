import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export interface HealthCheckPackageOutput {
  package_id: string;
  health: "ok" | "error" | "unavailable";
  needs_sign_in?: boolean;
  detail?: string;
}

export async function handleHealthCheckPackage(
  input: { package_id: string },
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  const { package_id } = input;

  if (!package_id || typeof package_id !== "string") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id: package_id ?? "",
            health: "unavailable",
            error: "package_id is required and must be a non-empty string"
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  logger.info("Handling health_check request", { package_id });

  const healthResult = typeof registry.healthCheckWithClient === "function"
    ? await registry.healthCheckWithClient(package_id)
    : { health: await registry.healthCheck(package_id) };
  const { health } = healthResult;

  // Sync catalog if registry reports healthy but catalog has stale error
  const catalogStatus = catalog.getPackageStatus(package_id);
  if (health === "ok" && (catalogStatus === "error" || catalogStatus === "auth_required")) {
    catalog.clearPackage(package_id);
  }

  const result: HealthCheckPackageOutput = {
    package_id,
    health,
    ...(healthResult.authRequired ? {
      needs_sign_in: true,
      detail: "The server last answered with a sign-in challenge. Run authenticate to sign in.",
    } : healthResult.error ? {
      detail: healthResult.error instanceof Error ? healthResult.error.message : String(healthResult.error),
    } : {}),
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
