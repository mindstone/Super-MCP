import { getLogger } from "./logging.js";
import safeRegex from "safe-regex2";

const logger = getLogger();

// Defense-in-depth constants for ReDoS protection
const MAX_PATTERN_LENGTH = 500;  // Max chars for user-defined regex patterns
const MAX_INPUT_LENGTH = 100;    // Max chars for tool/package names before .test()

export interface SecurityConfig {
  // Blocklist: block tools/packages that match these patterns
  blockedTools?: string[];      // Exact names or regex patterns like "/.*delete.*/i"
  blockedPackages?: string[];   // Package IDs to completely block
  
  // Allowlist: only allow tools/packages that match (layered with blocklist)
  // When both allowlist and blocklist are configured, BOTH apply:
  // 1. Must be on allowlist (if configured)
  // 2. Must NOT be on blocklist (if configured)
  allowedTools?: string[];      // If set, only these tools are candidates
  allowedPackages?: string[];   // If set, only these packages are candidates
  
  // Logging
  logBlockedAttempts?: boolean; // Log when tools are blocked (default: true)
}

export interface BlockCheckResult {
  blocked: boolean;
  reason?: string;
}

interface CompiledPattern {
  original: string;
  regex: RegExp;
  isRegex: boolean;
}

export class SecurityPolicy {
  private config: SecurityConfig;
  private blockedToolPatterns: CompiledPattern[] = [];
  private blockedPackagePatterns: CompiledPattern[] = [];
  private allowedToolPatterns: CompiledPattern[] = [];
  private allowedPackagePatterns: CompiledPattern[] = [];
  
  // User-disabled tools per server (separate from security policy)
  // Key: serverId, Value: Set of short tool names
  private userDisabledToolsByServer: Map<string, Set<string>> = new Map();
  
  // Admin-disabled tools per catalog ID (set by organization administrators)
  // Key: catalogId, Value: Set of short tool names
  private adminDisabledToolsByCatalogId: Map<string, Set<string>> = new Map();

  constructor(config: SecurityConfig = {}) {
    this.config = config;
    this.compilePatterns();
  }

  private compilePatterns(): void {
    // Compile all pattern lists (layered model: both allowlist and blocklist apply)
    this.blockedToolPatterns = this.compilePatternList(this.config.blockedTools || []);
    this.blockedPackagePatterns = this.compilePatternList(this.config.blockedPackages || []);
    this.allowedToolPatterns = this.compilePatternList(this.config.allowedTools || []);
    this.allowedPackagePatterns = this.compilePatternList(this.config.allowedPackages || []);

    const hasAllowlist = this.allowedToolPatterns.length > 0 || this.allowedPackagePatterns.length > 0;
    const hasBlocklist = this.blockedToolPatterns.length > 0 || this.blockedPackagePatterns.length > 0;

    logger.info("Security policy initialized", {
      mode: hasAllowlist && hasBlocklist ? "layered" : hasAllowlist ? "allowlist" : hasBlocklist ? "blocklist" : "disabled",
      allowed_tools: this.allowedToolPatterns.length,
      allowed_packages: this.allowedPackagePatterns.length,
      blocked_tools: this.blockedToolPatterns.length,
      blocked_packages: this.blockedPackagePatterns.length,
    });
  }

  private compilePatternList(patterns: string[]): CompiledPattern[] {
    const compiled: CompiledPattern[] = [];

    for (const pattern of patterns) {
      try {
        const parsed = this.parsePattern(pattern);
        compiled.push(parsed);
      } catch (error) {
        logger.error("Invalid security pattern, skipping", {
          pattern,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return compiled;
  }

  private parsePattern(pattern: string): CompiledPattern {
    // Defense-in-depth: Reject overly long patterns before parsing
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`);
    }

    // Check if it's a regex pattern: /pattern/flags
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    
    if (regexMatch) {
      const [, regexBody, flags] = regexMatch;
      const regex = new RegExp(regexBody, flags);
      
      // ReDoS protection: validate regex is safe from catastrophic backtracking
      if (!safeRegex(regex)) {
        logger.error("Unsafe regex pattern rejected (potential ReDoS)", { pattern });
        throw new Error(`Unsafe regex pattern rejected: ${pattern}`);
      }
      
      return {
        original: pattern,
        regex,
        isRegex: true,
      };
    }
    
    // Exact match - escape special regex characters and match exactly
    // Note: escaped patterns are inherently safe (no quantifiers or alternation)
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      original: pattern,
      regex: new RegExp(`^${escaped}$`),
      isRegex: false,
    };
  }

  private matchesAnyPattern(value: string, patterns: CompiledPattern[]): CompiledPattern | null {
    // Defense-in-depth: Truncate overly long input to prevent ReDoS
    // Tool/package names should be naturally short; if longer, truncate for safety
    if (value.length > MAX_INPUT_LENGTH) {
      logger.debug("Input truncated for security pattern matching", {
        original_length: value.length,
        truncated_to: MAX_INPUT_LENGTH,
      });
    }
    const safeValue = value.length > MAX_INPUT_LENGTH ? value.slice(0, MAX_INPUT_LENGTH) : value;
    
    for (const pattern of patterns) {
      // Reset lastIndex to avoid statefulness issues with g/y flags
      // Repeated .test() calls on regexes with g or y can alternate results
      if (pattern.regex.global || pattern.regex.sticky) {
        pattern.regex.lastIndex = 0;
      }
      if (pattern.regex.test(safeValue)) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Check if a package is blocked.
   * Uses layered security: must pass allowlist (if configured) AND not be on blocklist (if configured).
   * @param packageId The package ID to check
   * @returns BlockCheckResult with blocked status and reason
   */
  isPackageBlocked(packageId: string, logAttempt = true): BlockCheckResult {
    // Gate 1: Allowlist check (if configured, must be on it)
    if (this.allowedPackagePatterns.length > 0) {
      const match = this.matchesAnyPattern(packageId, this.allowedPackagePatterns);
      if (!match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: `Package '${packageId}' is not in the allowed packages list`,
        };
        if (logAttempt) this.logBlockedAttempt("package", packageId, result.reason!, "allowlist");
        return result;
      }
    }

    // Gate 2: Blocklist check (if configured, must not be on it)
    if (this.blockedPackagePatterns.length > 0) {
      const match = this.matchesAnyPattern(packageId, this.blockedPackagePatterns);
      if (match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: match.isRegex
            ? `Package '${packageId}' blocked by pattern: ${match.original}`
            : `Package '${packageId}' is explicitly blocked`,
        };
        if (logAttempt) this.logBlockedAttempt("package", packageId, result.reason!, "blocklist");
        return result;
      }
    }

    return { blocked: false };
  }

  /**
   * Check if a tool is blocked.
   * Uses layered security: must pass allowlist (if configured) AND not be on blocklist (if configured).
   * @param packageId The package ID
   * @param toolId The tool ID (without namespace prefix)
   * @returns BlockCheckResult with blocked status and reason
   */
  isToolBlocked(packageId: string, toolId: string, logAttempt = true): BlockCheckResult {
    // First check if the entire package is blocked
    const packageCheck = this.isPackageBlocked(packageId, logAttempt);
    if (packageCheck.blocked) {
      return packageCheck;
    }

    // Build the fully qualified tool name for matching
    const fullToolName = `${packageId}__${toolId}`;

    // Gate 1: Allowlist check (if configured, must be on it)
    if (this.allowedToolPatterns.length > 0) {
      // Check both the full name and just the tool name
      const matchFull = this.matchesAnyPattern(fullToolName, this.allowedToolPatterns);
      const matchShort = this.matchesAnyPattern(toolId, this.allowedToolPatterns);
      
      if (!matchFull && !matchShort) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: `Tool '${fullToolName}' is not in the allowed tools list`,
        };
        if (logAttempt) this.logBlockedAttempt("tool", fullToolName, result.reason!, "allowlist");
        return result;
      }
    }

    // Gate 2: Blocklist check (if configured, must not be on it)
    if (this.blockedToolPatterns.length > 0) {
      // Check both the full name and just the tool name
      const matchFull = this.matchesAnyPattern(fullToolName, this.blockedToolPatterns);
      const matchShort = this.matchesAnyPattern(toolId, this.blockedToolPatterns);
      const match = matchFull || matchShort;
      
      if (match) {
        const result: BlockCheckResult = {
          blocked: true,
          reason: match.isRegex
            ? `Tool '${fullToolName}' blocked by pattern: ${match.original}`
            : `Tool '${fullToolName}' is explicitly blocked`,
        };
        if (logAttempt) this.logBlockedAttempt("tool", fullToolName, result.reason!, "blocklist");
        return result;
      }
    }

    return { blocked: false };
  }

  private logBlockedAttempt(type: "tool" | "package", name: string, reason: string, gate: "allowlist" | "blocklist"): void {
    if (this.config.logBlockedAttempts !== false) {
      logger.warn(`Blocked ${type} access attempt`, {
        type,
        name,
        reason,
        gate,
      });
    }
  }

  /**
   * Get the security configuration.
   */
  getConfig(): SecurityConfig {
    return { ...this.config };
  }

  /**
   * Set user-disabled tools by server.
   * @param disabledByServer Record mapping server IDs to arrays of disabled tool names (short names)
   */
  setUserDisabledTools(disabledByServer: Record<string, string[]>): void {
    this.userDisabledToolsByServer.clear();
    
    for (const [serverId, toolNames] of Object.entries(disabledByServer)) {
      if (Array.isArray(toolNames) && toolNames.length > 0) {
        this.userDisabledToolsByServer.set(serverId, new Set(toolNames));
      }
    }
    
    const totalDisabled = Array.from(this.userDisabledToolsByServer.values())
      .reduce((sum, set) => sum + set.size, 0);
    
    if (totalDisabled > 0) {
      logger.info("User-disabled tools configured", {
        server_count: this.userDisabledToolsByServer.size,
        total_disabled_tools: totalDisabled,
      });
    }
  }

  /**
   * Check if a tool is disabled by user preference (not security policy).
   * @param serverId The server/package ID
   * @param toolName The short tool name (e.g., "delete_file", not "filesystem__delete_file")
   * @returns true if the tool is user-disabled
   */
  isUserDisabled(serverId: string, toolName: string): boolean {
    const disabledTools = this.userDisabledToolsByServer.get(serverId);
    return disabledTools?.has(toolName) ?? false;
  }

  /**
   * Get all user-disabled tools for a specific server.
   * @param serverId The server/package ID
   * @returns Array of disabled tool names, or empty array if none
   */
  getUserDisabledTools(serverId: string): string[] {
    const disabledTools = this.userDisabledToolsByServer.get(serverId);
    return disabledTools ? Array.from(disabledTools) : [];
  }

  /**
   * Get a summary of user-disabled tools for logging.
   */
  getUserDisabledSummary(): { serverCount: number; totalDisabled: number } {
    const totalDisabled = Array.from(this.userDisabledToolsByServer.values())
      .reduce((sum, set) => sum + set.size, 0);
    return {
      serverCount: this.userDisabledToolsByServer.size,
      totalDisabled,
    };
  }

  /**
   * Get a deterministic hash of user-disabled tools for ETag generation.
   * Returns a short hash string that changes when any disabled tool changes.
   */
  getUserDisabledHash(): string {
    if (this.userDisabledToolsByServer.size === 0) {
      return "0";
    }
    // Build sorted representation: "serverId1:tool1,tool2;serverId2:tool3"
    const sortedServers = Array.from(this.userDisabledToolsByServer.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([serverId, tools]) => {
        const sortedTools = Array.from(tools).sort().join(',');
        return `${serverId}:${sortedTools}`;
      })
      .join(';');
    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < sortedServers.length; i++) {
      hash = ((hash << 5) + hash) + sortedServers.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Set admin-disabled tools by catalog ID.
   * @param disabledByCatalogId Record mapping catalog IDs to arrays of disabled tool names (short names)
   */
  setAdminDisabledTools(disabledByCatalogId: Record<string, string[]>): void {
    this.adminDisabledToolsByCatalogId.clear();
    
    for (const [catalogId, toolNames] of Object.entries(disabledByCatalogId)) {
      if (Array.isArray(toolNames) && toolNames.length > 0) {
        this.adminDisabledToolsByCatalogId.set(catalogId, new Set(toolNames));
      }
    }
    
    const totalDisabled = Array.from(this.adminDisabledToolsByCatalogId.values())
      .reduce((sum, set) => sum + set.size, 0);
    
    if (totalDisabled > 0) {
      logger.info("Admin-disabled tools configured", {
        catalog_count: this.adminDisabledToolsByCatalogId.size,
        total_disabled_tools: totalDisabled,
      });
    }
  }

  /**
   * Check if a tool is disabled by an organization administrator.
   * @param catalogId The catalog ID of the package (e.g., "bamboohr", "bundled-google")
   * @param toolName The short tool name (e.g., "delete_file", not "filesystem__delete_file")
   * @returns true if the tool is admin-disabled
   */
  isAdminDisabled(catalogId: string | undefined, toolName: string): boolean {
    if (!catalogId) return false;
    const disabledTools = this.adminDisabledToolsByCatalogId.get(catalogId);
    return disabledTools?.has(toolName) ?? false;
  }

  /**
   * Get a summary of admin-disabled tools for logging.
   */
  getAdminDisabledSummary(): { catalogCount: number; totalDisabled: number } {
    const totalDisabled = Array.from(this.adminDisabledToolsByCatalogId.values())
      .reduce((sum, set) => sum + set.size, 0);
    return {
      catalogCount: this.adminDisabledToolsByCatalogId.size,
      totalDisabled,
    };
  }

  /**
   * Get a deterministic hash of admin-disabled tools for ETag generation.
   * Returns a short hash string that changes when any admin-disabled tool changes.
   */
  getAdminDisabledHash(): string {
    if (this.adminDisabledToolsByCatalogId.size === 0) {
      return "0";
    }
    // Build sorted representation: "catalogId1:tool1,tool2;catalogId2:tool3"
    const sortedCatalogs = Array.from(this.adminDisabledToolsByCatalogId.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([catalogId, tools]) => {
        const sortedTools = Array.from(tools).sort().join(',');
        return `${catalogId}:${sortedTools}`;
      })
      .join(';');
    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < sortedCatalogs.length; i++) {
      hash = ((hash << 5) + hash) + sortedCatalogs.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Check if security is enabled (any rules configured).
   */
  isEnabled(): boolean {
    return (
      (this.config.blockedTools?.length ?? 0) > 0 ||
      (this.config.blockedPackages?.length ?? 0) > 0 ||
      (this.config.allowedTools?.length ?? 0) > 0 ||
      (this.config.allowedPackages?.length ?? 0) > 0
    );
  }

  /**
   * Get a summary of the security policy for logging/debugging.
   */
  getSummary(): {
    mode: "blocklist" | "allowlist" | "layered" | "disabled";
    blockedToolCount: number;
    blockedPackageCount: number;
    allowedToolCount: number;
    allowedPackageCount: number;
  } {
    if (!this.isEnabled()) {
      return {
        mode: "disabled",
        blockedToolCount: 0,
        blockedPackageCount: 0,
        allowedToolCount: 0,
        allowedPackageCount: 0,
      };
    }

    const hasAllowlist = this.allowedToolPatterns.length > 0 || this.allowedPackagePatterns.length > 0;
    const hasBlocklist = this.blockedToolPatterns.length > 0 || this.blockedPackagePatterns.length > 0;

    let mode: "blocklist" | "allowlist" | "layered";
    if (hasAllowlist && hasBlocklist) {
      mode = "layered";
    } else if (hasAllowlist) {
      mode = "allowlist";
    } else {
      mode = "blocklist";
    }

    return {
      mode,
      blockedToolCount: this.blockedToolPatterns.length,
      blockedPackageCount: this.blockedPackagePatterns.length,
      allowedToolCount: this.allowedToolPatterns.length,
      allowedPackageCount: this.allowedPackagePatterns.length,
    };
  }
}

// Singleton instance - will be set by registry
let securityPolicy: SecurityPolicy | null = null;

export function setSecurityPolicy(policy: SecurityPolicy): void {
  securityPolicy = policy;
}

export function getSecurityPolicy(): SecurityPolicy {
  if (!securityPolicy) {
    // Return a no-op policy if not initialized
    securityPolicy = new SecurityPolicy({});
  }
  return securityPolicy;
}
