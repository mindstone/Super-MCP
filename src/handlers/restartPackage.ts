import { PackageRegistry } from "../registry.js";
import { Catalog, type CatalogRefreshController } from "../catalog.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export async function handleRestartPackage(
  input: { package_id: string },
  registry: PackageRegistry,
  catalog: Catalog,
  catalogRefresher?: CatalogRefreshController,
): Promise<any> {
  const { package_id } = input;

  if (!package_id || typeof package_id !== "string") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            message: "package_id is required and must be a string"
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  logger.info("Handling restart_package request", { package_id });

  const result = await registry.restartPackage(package_id);

  // Clear catalog cache so next list_tools re-fetches fresh state
  if (result.success) {
    catalog.clearPackage(package_id);
    await catalogRefresher?.refreshNow(package_id, {
      forceReconnect: true,
      reason: "restart",
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: !result.success,
  };
}
