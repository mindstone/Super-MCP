import type { CatalogRefresher } from "../catalogRefresher.js";
import type { PackageRegistry } from "../registry.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

function textResult(value: unknown, isError: boolean) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

/**
 * FOX-11496: "is this cloud-hosted connector reachable now?", asked by the app while it waits out a cloud restart.
 * Not offered to the model. Unlike restart_package it closes nothing a call is using and clears no catalog entry.
 */
export async function handleProbePackageHome(
  input: { package_id: string },
  registry: PackageRegistry,
  catalogRefresher: Pick<CatalogRefresher, "probeNow">,
  signal?: AbortSignal,
): Promise<any> {
  const packageId = input?.package_id;
  if (!packageId || typeof packageId !== "string") {
    return textResult({ success: false, message: "package_id is required and must be a string" }, true);
  }
  // Deliberate: like restart_package, the probe's package id stays literal.
  if (!registry.getPackage(packageId)) {
    return textResult({ success: false, message: `Package '${packageId}' not found in configuration` }, true);
  }
  // Only a cloud-hosted connector has a home to come back; a local one is never waited on this way.
  if (!registry.isPackageHomed(packageId)) {
    return textResult({ success: false, message: `Package '${packageId}' is not cloud-hosted, so it cannot be probed` }, true);
  }
  try {
    return textResult(await catalogRefresher.probeNow(packageId, { signal }), false);
  } catch (error) {
    logger.warn("Package probe failed", {
      package_id: packageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return textResult({ success: false, message: `Package '${packageId}' could not be probed` }, true);
  }
}
