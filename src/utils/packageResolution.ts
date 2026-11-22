import type { PackageConfig, SkippedPackage } from "../types.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export interface PackageResolutionRegistry {
  getPackage(packageId: string): PackageConfig | undefined;
  findPackagesByAlias(alias: string): PackageConfig[];
  /** Every registered package; used to list a whole family on not_found. */
  getPackages?(): PackageConfig[];
  /** Ids the person switched off; they are not registered, so they resolve as not_found. */
  getDisabledPackageIds?(): string[];
  /** Configured ids that failed validation; also not registered. */
  getSkippedPackages?(): SkippedPackage[];
}

export type PackageResolution =
  | { outcome: "exact"; packageId: string }
  | { outcome: "unique_family"; packageId: string }
  | { outcome: "ambiguous"; candidateIds: string[] }
  | { outcome: "not_found" };

/** Resolve configured package identity only. Catalog readiness is deliberately not consulted. */
export function resolvePackageId(
  registry: PackageResolutionRegistry,
  packageId: string,
): PackageResolution {
  const exactMatch = registry.getPackage(packageId);
  if (exactMatch) {
    return { outcome: "exact", packageId };
  }

  const familyMatches = registry.findPackagesByAlias(packageId);
  if (familyMatches.length === 1) {
    const resolvedPackageId = familyMatches[0].id;
    logger.debug("Resolved bare package alias to single instance", {
      original_package_id: packageId,
      resolved_package_id: resolvedPackageId,
    });
    return { outcome: "unique_family", packageId: resolvedPackageId };
  }

  if (familyMatches.length > 1) {
    return {
      outcome: "ambiguous",
      candidateIds: familyMatches.map((candidate) => candidate.id),
    };
  }

  return { outcome: "not_found" };
}

export function formatAmbiguousPackageMessage(
  packageId: string,
  candidateIds: string[],
): string {
  return `Package alias '${packageId}' matches ${candidateIds.length} active accounts. Specify the full package_id (e.g. ${candidateIds.map((candidateId) => `'${candidateId}'`).join(", ")}).`;
}

export interface PackageNotFoundDescription {
  /** No trailing full stop: thrown errors get list_tool_packages advice appended. */
  message: string;
  data: {
    package_id: string;
    status?: "disabled" | "load_failed";
    family?: string;
    registered_candidates?: Array<{ package_id: string; name: string }>;
  };
}

/**
 * Explain a package id that resolved as not_found, so the model can recover in
 * one step and tell the person what is true (FOX-10918, Sentry REBEL-62C).
 *
 * The model often builds `<Family>-<email-slug>` itself. When that account is
 * switched off, failed to load, or another account of the same family is the one
 * connected, say so. Never routes to another account: a request for account A is
 * not a request for account B, so the candidates are only named.
 */
export function describePackageNotFound(
  registry: PackageResolutionRegistry,
  packageId: string,
): PackageNotFoundDescription {
  const requested = packageId.toLowerCase();

  if (registry.getDisabledPackageIds?.().some((id) => id.toLowerCase() === requested)) {
    return {
      message: `Package '${packageId}' is switched off in the person's connector settings, so its tools can't be used. Tell the person, and ask them to switch it back on if they want it`,
      data: { package_id: packageId, status: "disabled" },
    };
  }

  if (registry.getSkippedPackages?.().some((pkg) => pkg.id.toLowerCase() === requested)) {
    return {
      message: `Package '${packageId}' is set up but couldn't be loaded because its configuration is invalid. Tell the person it needs to be set up again`,
      data: { package_id: packageId, status: "load_failed" },
    };
  }

  const dash = packageId.indexOf("-");
  const family = dash > 0 ? packageId.slice(0, dash) : undefined;
  if (family) {
    // Every member of the family: the bare package and its suffixed accounts.
    // findPackagesByAlias stops at an exact bare match (right for routing, wrong
    // for listing), so prefer the full package list when the registry has one.
    const familyLower = family.toLowerCase();
    const members = registry.getPackages
      ? registry
          .getPackages()
          .filter((pkg) => {
            const id = pkg.id.toLowerCase();
            return id === familyLower || id.startsWith(`${familyLower}-`);
          })
      : registry.findPackagesByAlias(family);
    const candidates = members.filter((pkg) => pkg.id.toLowerCase() !== requested);
    if (candidates.length > 0) {
      return {
        message: `Package not found: ${packageId}. That ${family} account isn't set up here. ${family} packages set up here: ${candidates.map((pkg) => `'${pkg.id}'`).join(", ")}. Do not substitute a different account: if the person hasn't said they mean one of these, tell them that account isn't connected to Rebel and ask which account they want`,
        data: {
          package_id: packageId,
          family,
          registered_candidates: candidates.map((pkg) => ({
            package_id: pkg.id,
            name: pkg.name,
          })),
        },
      };
    }
  }

  return { message: `Package not found: ${packageId}`, data: { package_id: packageId } };
}
