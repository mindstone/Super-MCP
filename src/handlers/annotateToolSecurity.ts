import { getSecurityPolicy } from "../security.js";
import { safetyBlock, type SafetyIdentity } from "../safetyDisabledTools.js";

export interface SecurityAnnotation {
  blocked?: boolean;
  blocked_reason?: string;
  user_disabled?: boolean;
  admin_disabled?: boolean;
}

/**
 * Compute security annotation for a tool.
 * Shape-agnostic: returns only security fields to spread onto any output type.
 * Precedence: security-blocked > safety-disabled > admin-disabled > user-disabled.
 */
export function computeSecurityAnnotation(
  packageId: string,
  pkg: SafetyIdentity | undefined,
  rawToolId: string,
): SecurityAnnotation {
  const securityPolicy = getSecurityPolicy();
  const blockCheck = securityPolicy.isToolBlocked(packageId, rawToolId);

  if (blockCheck.blocked) {
    return { blocked: true, blocked_reason: blockCheck.reason };
  }

  // No call arguments here, so an argument-scoped local-fs tool shows as allowed; a call naming the argument is refused.
  const safety = safetyBlock(pkg, rawToolId);
  if (safety !== undefined) {
    return { blocked: true, blocked_reason: safety.reason };
  }

  if (securityPolicy.isAdminDisabled(pkg?.catalogId, rawToolId)) {
    return {
      blocked: true,
      blocked_reason: "Disabled by your organization's administrator",
      admin_disabled: true,
    };
  }

  if (securityPolicy.isUserDisabled(packageId, rawToolId)) {
    return {
      blocked: true,
      blocked_reason: "Disabled by user",
      user_disabled: true,
    };
  }

  return {};
}

/**
 * Extract the raw tool name by stripping the package prefix (everything before first `__`).
 */
export function extractRawToolId(toolId: string): string {
  const idx = toolId.indexOf('__');
  return idx >= 0 ? toolId.slice(idx + 2) : toolId;
}
