import type { PackageRegistry } from "./registry.js";
import { ERROR_CODES, type ToolBlockedReason } from "./types.js";
import { getSecurityPolicy } from "./security.js";
import { getLogger } from "./logging.js";

const logger = getLogger();

export function assertToolAccess(registry: PackageRegistry, package_id: string, tool_id?: string): void {
  // Check if tool is blocked by security policy
  const securityPolicy = getSecurityPolicy();
  const blockCheck = tool_id === undefined
    ? securityPolicy.isPackageBlocked(package_id)
    : securityPolicy.isToolBlocked(package_id, tool_id);
  if (blockCheck.blocked) {
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: blockCheck.reason || `Tool '${package_id}__${tool_id}' is blocked by security policy`,
      data: { package_id, tool_id, blocked_reason: blockCheck.reason, reason: "security-policy" satisfies ToolBlockedReason },
    };
  }

  // Check if tool is disabled by admin (takes precedence over user preference)
  const packageConfig = registry.getPackage(package_id);
  const catalogId = packageConfig?.catalogId;
  if (tool_id !== undefined && securityPolicy.isAdminDisabled(catalogId, tool_id)) {
    logger.warn("Blocked attempt to use admin-disabled tool", {
      package_id,
      tool_id,
      catalog_id: catalogId,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by your organization's administrator`,
      data: { package_id, tool_id, blocked_reason: "Disabled by administrator", admin_disabled: true, reason: "admin-disabled" satisfies ToolBlockedReason },
    };
  }

  // Check if tool is disabled by user preference (separate from security policy)
  if (tool_id !== undefined && securityPolicy.isUserDisabled(package_id, tool_id)) {
    logger.warn("Blocked attempt to use user-disabled tool", {
      package_id,
      tool_id,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by user preference. Re-enable it in Settings to use.`,
      data: { package_id, tool_id, blocked_reason: "Disabled by user", user_disabled: true, reason: "user-disabled" satisfies ToolBlockedReason },
    };
  }
  if (!packageConfig) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${package_id}`,
      data: { package_id },
    };
  }
}
