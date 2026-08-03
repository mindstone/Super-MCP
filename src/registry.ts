import * as fs from "fs/promises";
import * as path from "path";
import { SuperMcpConfig, PackageConfig, McpClient, StandardServerConfig, ExtendedServerConfig, SkippedPackage, ValidationResult } from "./types.js";
import { StdioMcpClient } from "./clients/stdioClient.js";
import { HttpMcpClient } from "./clients/httpClient.js";
import { SimpleOAuthProvider } from "./auth/providers/simple.js";
import { getLogger } from "./logging.js";
import { SecurityPolicy, SecurityConfig, setSecurityPolicy } from "./security.js";

const logger = getLogger();

const PERMANENT_CONNECT_ERROR_CODES = new Set(["ENOENT", "EACCES"]);
const PERMANENT_CONNECT_MESSAGE_PATTERNS = [
  /^spawn\b[^\r\n]*\b(?:ENOENT|EACCES)\b\s*$/im,
  /^(?:[^\r\n]*:\s*)?command not found\s*$/im,
  /^(?:[^\r\n]*:\s*)?permission denied\s*$/im,
];
const MAX_ERROR_CAUSE_NODES = 8;

// Connect attempts per getClient() miss: one initial connect + the single
// retry in createAndConnectClientWithOneRetry. Exported so the OAuth budget
// invariant (src/handlers/__tests__/oauthBudgetInvariant.test.ts) can sum the
// real worst-case reconnect leg (REGISTRY_CONNECT_ATTEMPTS × CONNECT_TIMEOUT_MS).
// If the retry structure changes, this constant must move with it.
export const REGISTRY_CONNECT_ATTEMPTS = 2;

function isPermanentConnectFailure(error: unknown): boolean {
  try {
    const pending: unknown[] = [error];
    const seen = new Set<object>();

    while (pending.length > 0 && seen.size < MAX_ERROR_CAUSE_NODES) {
      const current = pending.shift();
      if (typeof current === "string") {
        if (
          PERMANENT_CONNECT_MESSAGE_PATTERNS.some((pattern) =>
            pattern.test(current),
          )
        ) {
          return true;
        }
        continue;
      }
      if (typeof current !== "object" || current === null || seen.has(current)) {
        continue;
      }
      seen.add(current);

      const causalError = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        originalError?: unknown;
      };
      if (
        typeof causalError.code === "string" &&
        PERMANENT_CONNECT_ERROR_CODES.has(causalError.code)
      ) {
        return true;
      }
      if (
        typeof causalError.message === "string" &&
        PERMANENT_CONNECT_MESSAGE_PATTERNS.some((pattern) =>
          pattern.test(causalError.message as string),
        )
      ) {
        return true;
      }
      pending.push(causalError.cause, causalError.originalError);
    }
  } catch {
    // Diagnostic classification must never replace the original connect error.
  }

  return false;
}

function preserveFirstAttemptDiagnostics(
  firstError: unknown,
  secondError: unknown,
  packageId: string,
): void {
  try {
    if (
      typeof firstError !== "object" ||
      firstError === null ||
      typeof secondError !== "object" ||
      secondError === null
    ) {
      return;
    }

    const firstAttemptDiagnostics = (firstError as { data?: unknown }).data;
    const secondAttemptDiagnostics = (secondError as { data?: unknown }).data;
    if (
      typeof firstAttemptDiagnostics !== "object" ||
      firstAttemptDiagnostics === null ||
      typeof secondAttemptDiagnostics !== "object" ||
      secondAttemptDiagnostics === null
    ) {
      return;
    }

    (secondAttemptDiagnostics as Record<string, unknown>).firstAttempt =
      firstAttemptDiagnostics;
  } catch (enrichmentError) {
    logger.warn("Failed to preserve first-attempt MCP connect diagnostics", {
      package_id: packageId,
      error:
        enrichmentError instanceof Error
          ? enrichmentError.message
          : String(enrichmentError),
    });
  }
}

/**
 * Expands environment variables in a configuration object.
 * Supports ${VAR} syntax for environment variable substitution.
 * Returns undefined if input is undefined to maintain compatibility.
 */
function expandEnvironmentVariables(env?: Record<string, string>, packageId?: string): Record<string, string> | undefined {
  if (!env) return undefined;
  
  const expanded: Record<string, string> = {};
  const warnings: string[] = [];
  
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      // Support ${VAR} syntax for environment variable expansion
      // Also support $VAR syntax for convenience
      expanded[key] = value
        .replace(/\$\{([^}]+)\}/g, (match, varName) => {
          const envValue = process.env[varName];
          if (envValue !== undefined) {
            logger.debug("Expanded environment variable", {
              package_id: packageId,
              key,
              var_name: varName,
              original: match,
              // Don't log the actual value for security
              has_value: true
            });
            return envValue;
          }
          const warning = `${packageId ? `[${packageId}] ` : ''}Environment variable '${varName}' not found for key '${key}'`;
          warnings.push(warning);
          logger.warn("Environment variable not found", {
            package_id: packageId,
            key,
            var_name: varName,
            original: match,
            suggestion: `Set the environment variable: export ${varName}="your-value"`
          });
          return match; // Keep original if not found
        })
        .replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
          const envValue = process.env[varName];
          if (envValue !== undefined) {
            logger.debug("Expanded environment variable", {
              package_id: packageId,
              key,
              var_name: varName,
              original: match,
              has_value: true
            });
            return envValue;
          }
          // Don't warn for simple $VAR as it might be intentional
          return match;
        });
        
      // Check for common API key patterns that look invalid
      if (expanded[key] && (key.includes('TOKEN') || key.includes('KEY') || key.includes('SECRET'))) {
        if (expanded[key].startsWith('${') || expanded[key] === 'YOUR_TOKEN' || 
            expanded[key] === 'YOUR_API_KEY' || expanded[key].includes('YOUR_')) {
          warnings.push(`${packageId ? `[${packageId}] ` : ''}${key} appears to be unset or using a placeholder value`);
        }
      }
    } else {
      expanded[key] = value;
    }
  }
  
  // Store warnings for later use
  if (warnings.length > 0 && packageId) {
    (expanded as any).__warnings = warnings;
  }
  
  return expanded;
}

/**
 * Per-child observability snapshot emitted via GET /stats.
 *
 * Stage 4b of `docs/plans/260423_secondary_process_cpu_observability.md`:
 * super-mcp exposes lightweight metadata so Rebel's perf diagnostic can
 * attribute CPU / behaviour to individual upstream MCP packages without
 * needing to introspect `process.resourceUsage()` (which is self-only).
 *
 * This struct is pure metadata — per-child CPU / RSS sampling lives
 * in the Rebel side (`subprocessCpuSampler`, future work), fed by
 * the PIDs reported here.
 */
export interface ChildStatsEntry {
  package_id: string;
  transport: 'stdio' | 'http';
  /** OS PID for stdio transports after successful connect; null otherwise. */
  pid: number | null;
  /** Whether a client is currently connected for this package. */
  connected: boolean;
  /** ms since last `notifyActivity` / connect; null when never touched. */
  idle_ms: number | null;
  /** ms epoch of last activity; null when never touched. */
  last_activity_at: number | null;
  /** Approximation via optional `McpClient.hasPendingRequests?()`. False when absent. */
  pending_requests: boolean;
  /** Cumulative successful `createAndConnectClient()` completions for this package. */
  spawn_count: number;
  /** Cumulative idle-reaper closures for this package. */
  reap_count: number;
  /** Cumulative non-reap, non-user eviction closures (unhealthy-client replacements). */
  eviction_count: number;
  /** Cumulative second connect attempts after an initial failure. */
  connect_retry_count: number;
  /** Cumulative bounded second attempts that recovered the connection. */
  connect_retry_recovered_count: number;
  /** Cumulative bounded second attempts that also failed. */
  connect_retry_failed_count: number;
  /** Cumulative initial failures not retried because they were known-permanent. */
  connect_retry_skipped_permanent_count: number;
  /** Cumulative pre-send liveness re-establishes in `callTool` (closed-transport recovery). */
  reestablish_count: number;
}

export class PackageRegistry {
  private config: SuperMcpConfig;
  private packages: PackageConfig[];
  private clients: Map<string, McpClient> = new Map();
  private clientPromises: Map<string, Promise<McpClient>> = new Map();
  private skippedPackages: SkippedPackage[] = [];
  private lastActivity: Map<string, number> = new Map();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;
  private reaperTimeoutMs: number = 300_000; // 5 minutes default

  // ── Stage 4b lifecycle counters ────────────────────────────────────
  // Cumulative per-package counters backing GET /stats.
  //
  // `spawnCounts` — incremented exactly once per successful
  //   `createAndConnectClient()` completion. The `getOrCreateClient`
  //   healthCheck-ok revive path does NOT increment (no new client spawned).
  // `reapCounts` — incremented exactly once per idle-reaper closure
  //   (`sweepIdleClients`). User-initiated `restartPackage()` and
  //   unhealthy-client evictions are tracked separately.
  // `evictionCounts` — incremented when a connected client is discarded
  //   because `healthCheck()` returned non-ok in `getOrCreateClient()`.
  //   This is NOT a user-initiated stop and NOT an idle reap.
  private spawnCounts: Map<string, number> = new Map();
  private reapCounts: Map<string, number> = new Map();
  private evictionCounts: Map<string, number> = new Map();
  /** Incremented exactly once when a failed initial connect starts its bounded retry. */
  private connectRetryCounts: Map<string, number> = new Map();
  /** Incremented when the bounded second connect attempt succeeds. */
  private connectRetryRecoveredCounts: Map<string, number> = new Map();
  /** Incremented when the bounded second connect attempt also fails. */
  private connectRetryFailedCounts: Map<string, number> = new Map();
  /** Incremented when a known-permanent initial failure bypasses the retry. */
  private connectRetrySkippedPermanentCounts: Map<string, number> = new Map();
  // `reestablishCounts` — incremented exactly once per pre-send liveness
  //   re-establish in `callTool` (the `isTransportClosed()` branch: a stdio
  //   transport closed BEFORE any bytes were sent, so we delete + recreate the
  //   client). Surfaced in `getChildStats()` so diagnostics can distinguish
  //   healthy idle-reap recovery (occasional) from thrashing on a broken
  //   connector (rapidly climbing). NOT a spawn-substitute: the re-establish's
  //   downstream `getClient()` separately bumps `spawnCounts` when it actually
  //   creates a fresh client.
  private reestablishCounts: Map<string, number> = new Map();

  // ── Stage 6: per-package active-use lease (idle-reaper exclusion) ────
  // Counts in-flight `callTool` brackets per package. Acquired synchronously
  // BEFORE the first `await` in `callTool` and released in its `finally`, so a
  // client that is actively being used can never be reaped mid-flight by
  // `sweepIdleClients` — closing the TOCTOU window that previously rejected an
  // in-flight request with `McpError(ConnectionClosed)` = -32000.
  // Invariant: leased (count > 0) ⇒ not reaped.
  private activeLeases: Map<string, number> = new Map();

  constructor(config: SuperMcpConfig) {
    this.config = config;
    this.packages = this.normalizeConfig(config);
  }

  private normalizeConfig(config: SuperMcpConfig): PackageConfig[] {
    // If using legacy packages format, expand env vars and return
    if (config.packages) {
      return config.packages.map(pkg => ({
        ...pkg,
        env: expandEnvironmentVariables(pkg.env, pkg.id)
      }));
    }

    // Convert standard mcpServers format to our internal format
    if (config.mcpServers) {
      const packages: PackageConfig[] = [];
      
      for (const [id, serverConfig] of Object.entries(config.mcpServers)) {
        const extConfig = serverConfig as ExtendedServerConfig;
        
        // Determine transport type
        let transport: "stdio" | "http" = "stdio";
        let transportType: "sse" | "http" | undefined;
        let baseUrl: string | undefined;
        
        if (extConfig.type === "sse" || extConfig.type === "http" || extConfig.url) {
          transport = "http";
          baseUrl = extConfig.url;
          
          // Preserve the specific HTTP transport type from config
          if (extConfig.type === "sse") {
            // HTTP+SSE transport (deprecated as of MCP spec 2025-03-26)
            transportType = "sse";
          } else {
            // Default to Streamable HTTP for "http" type or when type is omitted
            // Streamable HTTP replaced HTTP+SSE as of MCP spec 2025-03-26
            transportType = "http";
          }
        }
        
        const pkg: PackageConfig = {
          id,
          name: extConfig.name || id,
          description: extConfig.description,
          transport,
          transportType,
          command: extConfig.command,
          args: extConfig.args,
          env: expandEnvironmentVariables(extConfig.env, id),
          cwd: extConfig.cwd,
          base_url: baseUrl,
          auth: extConfig.auth,
          extra_headers: extConfig.headers,
          visibility: extConfig.visibility || "default",
          oauth: extConfig.oauth,
          oauthClientId: extConfig.oauthClientId,
          oauthClientSecret: extConfig.oauthClientSecret,
          catalogId: extConfig.catalogId,
        };
        
        packages.push(pkg);
      }
      
      return packages;
    }

    return [];
  }

  static async fromConfigFile(configPath: string): Promise<PackageRegistry> {
    return PackageRegistry.fromConfigFiles([configPath]);
  }

  static async fromConfigFiles(configPaths: string[]): Promise<PackageRegistry> {
    logger.info("Loading configurations", { config_paths: configPaths });

    // Merged configuration
    const mergedConfig: SuperMcpConfig = {
      mcpServers: {},
      security: {},
      userDisabledToolsByServer: {},
      disabledServers: [],
      adminDisabledToolsByCatalogId: {},
    };

    // Track visited paths to detect circular references (using normalized/resolved paths)
    const visitedPaths = new Set<string>();
    // Track the load order for debugging
    const loadOrder: string[] = [];
    // Maximum depth to prevent accidental infinite loops
    const MAX_CONFIG_DEPTH = 20;

    /**
     * Load a single config file and merge its contents.
     * Recursively follows configPaths references.
     */
    const loadConfigFile = async (
      configPath: string,
      referencedFrom: string | null,
      depth: number
    ): Promise<void> => {
      // Resolve to absolute path for consistent comparison
      const normalizedPath = path.resolve(configPath);

      // Check for circular references
      if (visitedPaths.has(normalizedPath)) {
        const chain = [...loadOrder, normalizedPath].join('\n  -> ');
        throw new Error(
          `Circular configPaths reference detected:\n  ${chain}\n` +
          `Config "${normalizedPath}" was already loaded.`
        );
      }

      // Check max depth
      if (depth > MAX_CONFIG_DEPTH) {
        throw new Error(
          `Maximum config nesting depth (${MAX_CONFIG_DEPTH}) exceeded.\n` +
          `This may indicate circular references or excessively deep nesting.\n` +
          `Load chain: ${loadOrder.join(' -> ')}`
        );
      }

      visitedPaths.add(normalizedPath);
      loadOrder.push(normalizedPath);

      // Load and parse the config file
      let configData: string;
      try {
        configData = await fs.readFile(normalizedPath, "utf8");
      } catch (error: any) {
        const context = referencedFrom ? `\nReferenced from: ${referencedFrom}` : '';
        if (error.code === 'ENOENT') {
          throw new Error(`Config file not found: ${normalizedPath}${context}`);
        }
        throw new Error(`Failed to read config file ${normalizedPath}: ${error.message}${context}`);
      }

      let config: SuperMcpConfig;
      try {
        config = JSON.parse(configData);
      } catch (error: any) {
        const context = referencedFrom ? `\nReferenced from: ${referencedFrom}` : '';
        throw new Error(`Invalid JSON in config file ${normalizedPath}: ${error.message}${context}`);
      }

      logger.info("Loading config file", { 
        path: normalizedPath, 
        depth,
        referenced_from: referencedFrom || '(root)'
      });

      // Merge mcpServers
      if (config.mcpServers) {
        for (const [id, server] of Object.entries(config.mcpServers)) {
          if (mergedConfig.mcpServers![id]) {
            logger.warn("Duplicate server ID found, later config overrides", { 
              id, 
              config_file: normalizedPath 
            });
          }
          mergedConfig.mcpServers![id] = server;
        }
      }

      // Handle legacy packages format
      if (config.packages) {
        logger.warn("Legacy 'packages' format detected, converting to mcpServers", {
          config_file: normalizedPath
        });
        for (const pkg of config.packages) {
          mergedConfig.mcpServers![pkg.id] = {
            command: pkg.command,
            args: pkg.args,
            env: pkg.env,
            cwd: pkg.cwd,
            type: pkg.transport === "http" ? (pkg.transportType || "http") : undefined,
            url: pkg.base_url,
            headers: pkg.extra_headers,
            name: pkg.name,
            description: pkg.description,
            visibility: pkg.visibility,
            oauth: pkg.oauth,
            oauthClientId: pkg.oauthClientId,
            oauthClientSecret: pkg.oauthClientSecret,
            auth: pkg.auth
          } as any;
        }
      }

      // Merge security config (arrays are concatenated, booleans use latest value)
      if (config.security) {
        const sec = mergedConfig.security!;
        if (config.security.blockedTools) {
          sec.blockedTools = [...(sec.blockedTools || []), ...config.security.blockedTools];
        }
        if (config.security.blockedPackages) {
          sec.blockedPackages = [...(sec.blockedPackages || []), ...config.security.blockedPackages];
        }
        if (config.security.allowedTools) {
          sec.allowedTools = [...(sec.allowedTools || []), ...config.security.allowedTools];
        }
        if (config.security.allowedPackages) {
          sec.allowedPackages = [...(sec.allowedPackages || []), ...config.security.allowedPackages];
        }
        if (config.security.logBlockedAttempts !== undefined) {
          sec.logBlockedAttempts = config.security.logBlockedAttempts;
        }
        logger.debug("Merged security config", {
          config_file: normalizedPath,
          blocked_tools: config.security.blockedTools?.length || 0,
          blocked_packages: config.security.blockedPackages?.length || 0,
        });
      }

      // Merge user-disabled tools by server (union arrays per server ID)
      if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object' && !Array.isArray(config.userDisabledToolsByServer)) {
        const disabled = mergedConfig.userDisabledToolsByServer!;
        for (const [serverId, toolNames] of Object.entries(config.userDisabledToolsByServer)) {
          if (!Array.isArray(toolNames)) {
            logger.warn("Invalid userDisabledToolsByServer entry (not an array), skipping", {
              config_file: normalizedPath,
              server_id: serverId
            });
            continue;
          }
          // Filter to valid string tool names only
          const validToolNames = toolNames.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
          if (validToolNames.length !== toolNames.length) {
            logger.warn("Some tool names in userDisabledToolsByServer were invalid (non-string or empty), filtering", {
              config_file: normalizedPath,
              server_id: serverId,
              original_count: toolNames.length,
              valid_count: validToolNames.length
            });
          }
          // Union the arrays (dedupe by using Set)
          const existingTools = disabled[serverId] || [];
          const allTools = new Set([...existingTools, ...validToolNames]);
          disabled[serverId] = Array.from(allTools);
        }
        logger.debug("Merged userDisabledToolsByServer config", {
          config_file: normalizedPath,
          server_count: Object.keys(config.userDisabledToolsByServer).length,
        });
      }

      // Merge disabledServers (union arrays, dedupe)
      if (config.disabledServers && Array.isArray(config.disabledServers)) {
        const validServerIds = config.disabledServers.filter(
          (id): id is string => typeof id === 'string' && id.trim() !== ''
        );
        if (validServerIds.length !== config.disabledServers.length) {
          logger.warn("Some disabledServers entries were invalid (non-string or empty), filtering", {
            config_file: normalizedPath,
            original_count: config.disabledServers.length,
            valid_count: validServerIds.length
          });
        }
        // Union with existing disabled servers (dedupe via Set)
        const allDisabled = new Set([...mergedConfig.disabledServers!, ...validServerIds]);
        mergedConfig.disabledServers = Array.from(allDisabled);
        logger.debug("Merged disabledServers config", {
          config_file: normalizedPath,
          added_count: validServerIds.length,
          total_disabled: mergedConfig.disabledServers.length
        });
      }

      // Merge admin-disabled tools by catalog ID (union arrays per catalog ID)
      if (config.adminDisabledToolsByCatalogId && typeof config.adminDisabledToolsByCatalogId === 'object' && !Array.isArray(config.adminDisabledToolsByCatalogId)) {
        const adminDisabled = mergedConfig.adminDisabledToolsByCatalogId!;
        for (const [catalogId, toolNames] of Object.entries(config.adminDisabledToolsByCatalogId)) {
          if (!Array.isArray(toolNames)) {
            logger.warn("Invalid adminDisabledToolsByCatalogId entry (not an array), skipping", {
              config_file: normalizedPath,
              catalog_id: catalogId
            });
            continue;
          }
          // Filter to valid string tool names only
          const validToolNames = toolNames.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
          if (validToolNames.length !== toolNames.length) {
            logger.warn("Some tool names in adminDisabledToolsByCatalogId were invalid (non-string or empty), filtering", {
              config_file: normalizedPath,
              catalog_id: catalogId,
              original_count: toolNames.length,
              valid_count: validToolNames.length
            });
          }
          // Union the arrays (dedupe by using Set)
          const existingTools = adminDisabled[catalogId] || [];
          const allTools = new Set([...existingTools, ...validToolNames]);
          adminDisabled[catalogId] = Array.from(allTools);
        }
        logger.debug("Merged adminDisabledToolsByCatalogId config", {
          config_file: normalizedPath,
          catalog_count: Object.keys(config.adminDisabledToolsByCatalogId).length,
        });
      }

      // Handle root-level server entries (for configs like Klavis that don't use mcpServers wrapper)
      // A server config is identified by having 'url' (HTTP) or 'command' (stdio)
      const knownMetadataKeys = new Set(['mcpServers', 'packages', 'configPaths', 'security', 'userDisabledToolsByServer', 'disabledServers']);
      for (const [key, value] of Object.entries(config)) {
        if (knownMetadataKeys.has(key)) continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const entry = value as Record<string, unknown>;
          if ('url' in entry || 'command' in entry) {
            if (mergedConfig.mcpServers![key]) {
              logger.warn("Duplicate server ID found, later config overrides", {
                id: key,
                config_file: normalizedPath
              });
            }
            logger.debug("Found root-level server entry (no mcpServers wrapper)", {
              id: key,
              config_file: normalizedPath,
              has_url: 'url' in entry,
              has_command: 'command' in entry
            });
            mergedConfig.mcpServers![key] = value as StandardServerConfig;
          }
        }
      }

      // Process configPaths references (recursive)
      if (config.configPaths && Array.isArray(config.configPaths)) {
        const baseDir = path.dirname(normalizedPath);
        
        for (const refPath of config.configPaths) {
          if (typeof refPath !== 'string' || !refPath.trim()) {
            logger.warn("Invalid configPaths entry (not a string), skipping", {
              config_file: normalizedPath,
              entry: refPath
            });
            continue;
          }

          // Resolve relative paths relative to the current config file's directory
          const resolvedRefPath = path.isAbsolute(refPath) 
            ? refPath 
            : path.resolve(baseDir, refPath);

          logger.debug("Following configPaths reference", {
            from: normalizedPath,
            reference: refPath,
            resolved: resolvedRefPath
          });

          // Recursively load the referenced config
          await loadConfigFile(resolvedRefPath, normalizedPath, depth + 1);
        }
      }
    };

    // Load all root config paths
    for (const configPath of configPaths) {
      try {
        await loadConfigFile(configPath, null, 0);
      } catch (error: any) {
        logger.error("Failed to load config file", { 
          path: configPath, 
          error: error.message 
        });
        throw error;
      }
    }

    const registry = new PackageRegistry(mergedConfig);

    // Initialize security policy
    const securityConfig: SecurityConfig = mergedConfig.security || {};
    const securityPolicy = new SecurityPolicy(securityConfig);
    
    // Set user-disabled tools on the security policy
    if (mergedConfig.userDisabledToolsByServer) {
      securityPolicy.setUserDisabledTools(mergedConfig.userDisabledToolsByServer);
    }
    
    // Set admin-disabled tools on the security policy
    if (mergedConfig.adminDisabledToolsByCatalogId) {
      securityPolicy.setAdminDisabledTools(mergedConfig.adminDisabledToolsByCatalogId);
    }
    
    setSecurityPolicy(securityPolicy);
    
    const secSummary = securityPolicy.getSummary();
    const userDisabledSummary = securityPolicy.getUserDisabledSummary();
    const adminDisabledSummary = securityPolicy.getAdminDisabledSummary();
    if (secSummary.mode !== "disabled" || userDisabledSummary.totalDisabled > 0 || adminDisabledSummary.totalDisabled > 0) {
      logger.info("Security policy active", {
        ...secSummary,
        user_disabled_servers: userDisabledSummary.serverCount,
        user_disabled_tools: userDisabledSummary.totalDisabled,
        admin_disabled_catalogs: adminDisabledSummary.catalogCount,
        admin_disabled_tools: adminDisabledSummary.totalDisabled,
      });
    }

    // Validate normalized config - skip invalid entries instead of throwing
    const validationResult = PackageRegistry.validateConfig(registry.packages);
    registry.packages = validationResult.valid;
    registry.skippedPackages = validationResult.skipped;
    
    // Emit skipped packages to stderr as structured JSON for consumers (e.g., Rebel) to parse
    if (validationResult.skipped.length > 0) {
      const skippedJson = JSON.stringify({ packages: validationResult.skipped });
      console.error(`SUPER_MCP_SKIPPED_PACKAGES:${skippedJson}`);
      logger.warn("Some MCP packages were skipped due to validation errors", {
        skipped_count: validationResult.skipped.length,
        skipped_packages: validationResult.skipped
      });
    }

    // Filter out disabled servers
    const disabledServers = mergedConfig.disabledServers || [];
    if (disabledServers.length > 0) {
      const disabledSet = new Set(disabledServers);
      const filteredOut = registry.packages.filter(p => disabledSet.has(p.id));
      registry.packages = registry.packages.filter(p => !disabledSet.has(p.id));
      if (filteredOut.length > 0) {
        logger.info("Filtering disabled servers", {
          disabled_servers: filteredOut.map(p => p.id),
          filtered_count: filteredOut.length,
          remaining_count: registry.packages.length
        });
      }
    }

    // Check for placeholder values
    PackageRegistry.checkForPlaceholders(registry.packages);

    logger.info("Configurations loaded successfully", {
      config_count: loadOrder.length,
      root_configs: configPaths.length,
      total_packages: registry.packages.length,
      skipped_packages: validationResult.skipped.length,
      disabled_servers: disabledServers.length,
      packages: registry.packages.map(p => ({ id: p.id, transport: p.transport })),
      load_order: loadOrder
    });

    return registry;
  }

  /**
   * Validates package configurations and returns valid packages with a list of skipped entries.
   * Instead of throwing on the first invalid entry, this collects all validation errors
   * and skips invalid packages gracefully.
   * 
   * NOTE: If modifying validation rules here, consider updating corresponding validation
   * in consuming applications (e.g., Rebel's mcpConfigManager.ts) to keep rules in sync.
   * 
   * Validation rules:
   * - id: required, must be non-empty string
   * - name: required, must be non-empty string (defaults to id in normalizeConfig)
   * - transport: must be "stdio" or "http"
   * - stdio transport: command is required and must be non-empty string
   * - http transport: base_url is required and must be a valid URL
   * - visibility: if present, must be "default" or "hidden"
   */
  private static validateConfig(packages: PackageConfig[]): ValidationResult {
    const valid: PackageConfig[] = [];
    const skipped: SkippedPackage[] = [];

    if (!Array.isArray(packages)) {
      logger.error("Invalid configuration: packages must be an array");
      return { valid: [], skipped: [] };
    }

    // Allow empty configs - super-mcp can run without any MCPs configured
    if (packages.length === 0) {
      logger.info("No MCP servers configured - super-mcp running in minimal mode");
      return { valid: [], skipped: [] };
    }

    const seenIds = new Set<string>();
    
    for (const pkg of packages) {
      // Validate id first - we need it for error messages and duplicate detection
      if (!pkg.id || typeof pkg.id !== "string") {
        const unknownId = `unknown-${skipped.length}`;
        const reason = "id is required and must be a non-empty string";
        logger.warn(`Skipping invalid package: ${reason}`, { package_id: unknownId });
        skipped.push({ id: unknownId, reason });
        continue;
      }

      const pkgId = pkg.id;

      // Check for duplicates (batch-only check, not in validateSinglePackage)
      if (seenIds.has(pkgId)) {
        const reason = `Duplicate package ID: ${pkgId}`;
        logger.warn(`Skipping invalid package: ${reason}`, { package_id: pkgId });
        skipped.push({ id: pkgId, reason });
        continue;
      }
      seenIds.add(pkgId);

      // Use shared validation helper for remaining field checks
      const fieldError = PackageRegistry.validatePackageFields(pkg);
      if (fieldError) {
        logger.warn(`Skipping invalid package: ${fieldError}`, { package_id: pkgId });
        skipped.push({ id: pkgId, reason: fieldError });
        continue;
      }

      // Package passed all validation
      valid.push(pkg);
    }

    return { valid, skipped };
  }

  /**
   * Validates package fields (excluding id, which must be checked separately for batch duplicate detection).
   * This is the shared validation logic used by both validateConfig() and validateSinglePackage().
   * Returns null if valid, or the error reason if invalid.
   * 
   * NOTE: If modifying these rules, also update the JSDoc on validateConfig() above.
   */
  private static validatePackageFields(pkg: PackageConfig): string | null {
    if (!pkg.name || typeof pkg.name !== "string") {
      return "name is required and must be a non-empty string";
    }
    if (pkg.transport !== "stdio" && pkg.transport !== "http") {
      return `transport must be "stdio" or "http", got "${pkg.transport}"`;
    }
    if (pkg.transport === "stdio" && (!pkg.command || typeof pkg.command !== "string")) {
      return "command is required and must be a non-empty string for stdio transport";
    }
    if (pkg.transport === "http") {
      if (!pkg.base_url || typeof pkg.base_url !== "string") {
        return "base_url is required and must be a non-empty string for http transport";
      }
      try {
        new URL(pkg.base_url);
      } catch {
        return `base_url must be a valid URL, got "${pkg.base_url}"`;
      }
    }
    if (pkg.visibility && pkg.visibility !== "default" && pkg.visibility !== "hidden") {
      return `visibility must be "default" or "hidden", got "${pkg.visibility}"`;
    }
    return null;
  }
  
  /**
   * Validates a single package configuration.
   * Used by restartPackage to validate re-normalized packages.
   * Returns null if valid, or the error reason if invalid.
   */
  private static validateSinglePackage(pkg: PackageConfig): string | null {
    // Check id separately (not in shared helper since batch validation needs different handling)
    if (!pkg.id || typeof pkg.id !== "string") {
      return "id is required and must be a non-empty string";
    }
    // Use shared validation for remaining fields
    return PackageRegistry.validatePackageFields(pkg);
  }

  private static checkForPlaceholders(packages: PackageConfig[]): void {
    const placeholders = ["YOUR_CLIENT_ID", "YOUR_SECRET", "YOUR_TOKEN"];
    
    for (const pkg of packages) {
      const configStr = JSON.stringify(pkg);
      for (const placeholder of placeholders) {
        if (configStr.includes(placeholder)) {
          logger.warn(`Package ${pkg.id} contains placeholder value: ${placeholder}`, {
            package_id: pkg.id,
          });
          // Mark this package as unavailable
          // This could be handled by adding a status field to the package
        }
      }
    }
  }

  getPackages(options: { safe_only?: boolean } = {}): PackageConfig[] {
    let packages = [...this.packages];

    if (options.safe_only) {
      // Filter out packages that might be unsafe or have placeholder values
      packages = packages.filter(pkg => {
        const configStr = JSON.stringify(pkg);
        const hasPlaceholders = ["YOUR_CLIENT_ID", "YOUR_SECRET", "YOUR_TOKEN"]
          .some(placeholder => configStr.includes(placeholder));
        return !hasPlaceholders;
      });
    }

    return packages;
  }

  getPackage(packageId: string): PackageConfig | undefined {
    return this.packages.find(pkg => pkg.id === packageId);
  }

  /**
   * Resolve a bare package alias (e.g. "GoogleWorkspace", "Slack", "HubSpot",
   * "Microsoft365Mail") to its concrete multi-instance package ids.
   *
   * Multi-instance packages always have ids of the form `${BaseName}-${slug}`.
   * If a single-instance package with the exact id exists, that match wins and
   * is returned alone. Otherwise we collect every package whose id starts with
   * `${alias}-`.
   *
   * Used by useTool's R2 alias resolver. The caller picks the unique match
   * (and emits a telemetry breadcrumb) or surfaces an ambiguity error listing
   * every candidate. The lookup is case-insensitive.
   */
  findPackagesByAlias(alias: string): PackageConfig[] {
    if (!alias) return [];

    const aliasLower = alias.toLowerCase();
    const exactMatch = this.packages.find(pkg => pkg.id.toLowerCase() === aliasLower);
    if (exactMatch) {
      return [exactMatch];
    }

    const prefix = `${aliasLower}-`;
    return this.packages.filter(pkg => pkg.id.toLowerCase().startsWith(prefix));
  }

  getSkippedPackages(): SkippedPackage[] {
    return [...this.skippedPackages];
  }

  async getClient(packageId: string): Promise<McpClient> {
    // Check if we already have a connected client
    let client = this.clients.get(packageId);
    if (client) {
      // For HTTP clients, check if they're actually connected
      if (client.healthCheck) {
        const health = await client.healthCheck();
        if (health === "ok") {
          // Update activity for stdio clients
          const config = this.getPackage(packageId);
          if (config?.transport === "stdio") {
            this.lastActivity.set(packageId, Date.now());
          }
          return client;
        }
        // Client exists but not healthy, remove it.
        // Stage 4b: counts as an eviction (unhealthy replacement, not user-initiated, not reap).
        //
        // Stage 4b M3 refinement: race-safe eviction counting. Two
        // simultaneous `getClient()` callers can both await the same
        // unhealthy `healthCheck`; without the `Map.delete()` return-value
        // guard they would both increment `evictionCounts`, causing drift.
        // `Map.delete()` returns `true` iff the entry was present, so only
        // the first concurrent caller bumps the counter.
        const deleted = this.clients.delete(packageId);
        if (deleted) {
          this.evictionCounts.set(
            packageId,
            (this.evictionCounts.get(packageId) ?? 0) + 1,
          );
        }
        client = undefined;
      } else {
        // Update activity for stdio clients
        const config = this.getPackage(packageId);
        if (config?.transport === "stdio") {
          this.lastActivity.set(packageId, Date.now());
        }
        return client;
      }
    }
    
    // Check if there's already a connection in progress
    let clientPromise = this.clientPromises.get(packageId);
    if (clientPromise) {
      logger.debug("Client creation already in progress, waiting", {
        package_id: packageId,
      });
      return clientPromise;
    }
    
    // Create new client
    const config = this.getPackage(packageId);
    if (!config) {
      const availablePackages = this.packages.map(p => p.id).join(", ");
      const errorMsg = `Package '${packageId}' not found in configuration.\n`;
      const helpMsg = `Available packages: ${availablePackages}\n\nTo use a package:\n  1. Ensure it's configured in super-mcp-config.json\n  2. Run 'list_tool_packages()' to see all available packages`;
      throw new Error(errorMsg + helpMsg);
    }

    logger.debug("Creating new client", {
      package_id: packageId,
      transport: config.transport,
    });

    // Create the client creation promise
    clientPromise = this.createAndConnectClientWithOneRetry(packageId, config);
    this.clientPromises.set(packageId, clientPromise);
    
    try {
      client = await clientPromise;
      this.clients.set(packageId, client);
      // Stage 4b: increment per-package spawn counter exactly once per
      // successful `createAndConnectClient()` completion (initial create path).
      // The healthCheck-ok revive branch above does NOT increment — no new
      // client was created there.
      this.spawnCounts.set(packageId, (this.spawnCounts.get(packageId) ?? 0) + 1);
      // Update activity for stdio clients on initial connection
      if (config.transport === "stdio") {
        this.lastActivity.set(packageId, Date.now());
      }
      return client;
    } catch (error) {
      // Add helpful context to connection errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("MCP") && !errorMessage.includes("diagnostic")) {
        // It's a raw error, enhance it
        let enhancedMessage = `Failed to connect to MCP package '${packageId}'.\n`;
        enhancedMessage += `Transport: ${config.transport}\n`;
        
        if (config.transport === "stdio") {
          enhancedMessage += `Command: ${config.command} ${config.args?.join(" ") || ""}\n`;
        } else if (config.transport === "http") {
          enhancedMessage += `URL: ${config.base_url}\n`;
        }
        
        enhancedMessage += `\nOriginal error: ${errorMessage}`;
        enhancedMessage += `\n\nTroubleshooting:`;
        enhancedMessage += `\n  1. Run 'health_check_all(detailed: true)' for diagnostics`;
        enhancedMessage += `\n  2. Check the package configuration`;
        enhancedMessage += `\n  3. Verify any required authentication`;
        
        const enhancedError = new Error(enhancedMessage);
        (enhancedError as any).originalError = error;
        throw enhancedError;
      }
      throw error;
    } finally {
      // Clean up the promise
      this.clientPromises.delete(packageId);
    }
  }
  
  /**
   * Stage 6: acquire an active-use lease on a package. MUST be called
   * synchronously (before any `await`) to close the reaper race. Idempotent
   * re-entry is supported via the counter (nested/concurrent calls each hold
   * their own ref).
   */
  private acquireLease(packageId: string): void {
    this.activeLeases.set(packageId, (this.activeLeases.get(packageId) ?? 0) + 1);
  }

  /**
   * Stage 6: release an active-use lease. Deletes the entry once the count
   * drops to zero so a never-leased package stays absent from the map.
   */
  private releaseLease(packageId: string): void {
    const next = (this.activeLeases.get(packageId) ?? 0) - 1;
    if (next <= 0) {
      this.activeLeases.delete(packageId);
    } else {
      this.activeLeases.set(packageId, next);
    }
  }

  /**
   * Stage 6: liveness-gated tool dispatch.
   *
   * Brackets `getClient` + `callTool` under an active-use lease so the idle
   * reaper cannot close the client mid-flight (Part A). Between the health
   * probe in `getClient` and the actual dispatch we re-check transport
   * liveness (Part B): if a stdio transport has closed BEFORE any bytes were
   * sent for this call (`isTransportClosed()` true), we delete + re-establish
   * a fresh client — safe, because no request reached the wire.
   *
   * CRITICAL safety invariant: a transport that closes MID-call (bytes already
   * sent, side effect possibly applied) is NEVER auto-retried. The re-establish
   * happens ONLY when `isTransportClosed()` is true before `client.callTool` is
   * invoked; the actual `client.callTool` call has no retry around it, so an
   * in-flight close propagates -32000 to the caller unchanged.
   */
  async callTool(packageId: string, toolId: string, args: any): Promise<any> {
    this.acquireLease(packageId);
    try {
      let client = await this.getClient(packageId);
      // Pre-send liveness re-check: the lease blocks the reaper, but the client
      // could already have a dead transport (e.g. closed between a prior reap
      // sweep and this call, or never spawned). Re-establishing here is safe
      // because no bytes have gone out for THIS call yet.
      if (client instanceof StdioMcpClient && client.isTransportClosed()) {
        logger.debug("Stdio transport closed before send; re-establishing", {
          package_id: packageId,
          tool_id: toolId,
        });
        this.reestablishCounts.set(packageId, (this.reestablishCounts.get(packageId) ?? 0) + 1);
        this.clients.delete(packageId);
        client = await this.getClient(packageId);
      }
      // No retry wraps this call: a mid-call close propagates -32000 as-is.
      return await client.callTool(toolId, args);
    } finally {
      this.releaseLease(packageId);
    }
  }

  /**
   * Notify that a package was actively used (e.g., after a tool call).
   * Resets the idle timer for the given package.
   */
  notifyActivity(packageId: string): void {
    this.lastActivity.set(packageId, Date.now());
  }

  /**
   * Start the idle reaper that periodically closes idle stdio clients.
   * Reads SUPER_MCP_IDLE_TIMEOUT_MS from environment (default: 300000ms = 5 minutes).
   * A value of 0 disables reaping entirely. Idempotent — safe to call multiple times.
   */
  startIdleReaper(): void {
    // Already running — no-op
    if (this.reaperInterval) {
      return;
    }

    const envTimeout = process.env.SUPER_MCP_IDLE_TIMEOUT_MS;
    if (envTimeout !== undefined) {
      const parsed = parseInt(envTimeout, 10);
      if (isNaN(parsed) || parsed < 0) {
        logger.warn("Invalid SUPER_MCP_IDLE_TIMEOUT_MS value, using default", {
          value: envTimeout,
          default_ms: this.reaperTimeoutMs,
        });
      } else if (parsed === 0) {
        logger.info("Idle reaper disabled (SUPER_MCP_IDLE_TIMEOUT_MS=0)");
        return;
      } else {
        this.reaperTimeoutMs = parsed;
      }
    }

    this.reaperInterval = setInterval(() => this.sweepIdleClients(), 60_000);
    this.reaperInterval.unref();

    logger.info("Idle reaper started", {
      timeout_ms: this.reaperTimeoutMs,
      sweep_interval_ms: 60_000,
    });
  }

  /**
   * Stop the idle reaper interval.
   */
  stopIdleReaper(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }

  /**
   * Sweep all connected clients and close those that have been idle beyond the timeout.
   * Only targets stdio clients — HTTP clients are stateless and don't hold child processes.
   */
  private sweepIdleClients(): void {
    const now = Date.now();
    const reaped: string[] = [];

    for (const [packageId, client] of this.clients.entries()) {
      // Skip if a connection is in progress for this package
      if (this.clientPromises.has(packageId)) {
        logger.debug("Skipping reap: connection in progress", { package_id: packageId });
        continue;
      }

      // Only reap stdio clients (HTTP clients are stateless, no child process)
      const config = this.getPackage(packageId);
      if (!config || config.transport !== "stdio") {
        continue;
      }

      // Skip if the client has in-flight or queued requests
      if (client.hasPendingRequests?.()) {
        logger.debug("Skipping reap: pending requests", { package_id: packageId });
        continue;
      }

      // Stage 6: skip if an active-use lease is held — a client mid-`callTool`
      // must never be reaped (closing it would reject the in-flight request
      // with -32000). The lease is the lock that `hasPendingRequests` (a racy
      // TOCTOU snapshot) is not.
      if ((this.activeLeases.get(packageId) ?? 0) > 0) {
        logger.debug("Skipping reap: active lease", { package_id: packageId });
        continue;
      }

      // Check if idle beyond threshold
      const lastActive = this.lastActivity.get(packageId) ?? 0;
      if (now - lastActive < this.reaperTimeoutMs) {
        continue;
      }

      // Reap this client
      client.close().catch((error) => {
        logger.warn("Error closing idle client during reap", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      this.clients.delete(packageId);
      this.lastActivity.delete(packageId);
      // Stage 4b: count this idle-reaper closure.
      this.reapCounts.set(packageId, (this.reapCounts.get(packageId) ?? 0) + 1);
      reaped.push(packageId);
    }

    if (reaped.length > 0) {
      logger.info("Reaped idle stdio MCP clients", {
        count: reaped.length,
        reaped,
      });
    }
  }

  private async createAndConnectClientWithOneRetry(
    packageId: string,
    config: PackageConfig,
  ): Promise<McpClient> {
    let firstClient: McpClient | undefined;
    try {
      return await this.createAndConnectClient(
        packageId,
        config,
        (client) => {
          firstClient = client;
        },
      );
    } catch (firstError) {
      if (firstClient) {
        try {
          await firstClient.close();
        } catch (cleanupError) {
          logger.warn("Failed to close MCP client after failed connect", {
            package_id: packageId,
            attempt: 1,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      if (isPermanentConnectFailure(firstError)) {
        this.connectRetrySkippedPermanentCounts.set(
          packageId,
          (this.connectRetrySkippedPermanentCounts.get(packageId) ?? 0) + 1,
        );
        logger.warn("MCP client connect retry skipped for permanent failure", {
          package_id: packageId,
          attempt: 1,
          error: firstError instanceof Error ? firstError.message : String(firstError),
        });
        throw firstError;
      }

      this.connectRetryCounts.set(
        packageId,
        (this.connectRetryCounts.get(packageId) ?? 0) + 1,
      );
      logger.warn("MCP client connect failed; retrying once", {
        package_id: packageId,
        attempt: 1,
        error: firstError instanceof Error ? firstError.message : String(firstError),
      });

      try {
        const client = await this.createAndConnectClient(packageId, config);
        this.connectRetryRecoveredCounts.set(
          packageId,
          (this.connectRetryRecoveredCounts.get(packageId) ?? 0) + 1,
        );
        return client;
      } catch (secondError) {
        this.connectRetryFailedCounts.set(
          packageId,
          (this.connectRetryFailedCounts.get(packageId) ?? 0) + 1,
        );
        preserveFirstAttemptDiagnostics(firstError, secondError, packageId);
        throw secondError;
      }
    }
  }

  private async createAndConnectClient(
    packageId: string,
    config: PackageConfig,
    onClientCreated?: (client: McpClient) => void,
  ): Promise<McpClient> {
    let client: McpClient;
    
    if (config.transport === "stdio") {
      client = new StdioMcpClient(packageId, config);
    } else {
      // Ambient-port coherence (REBEL-7F9 Stage 2c, recall#1 F9): pass the
      // persisted DCR client's callback port through instead of defaulting
      // blind to 5173. Inert today (ambient clients run refresh-only OAuth,
      // which carries no redirect_uri), but the non-5173 saved-registration
      // population grows with the candidate-sequence port ordering, so the
      // ambient default must not diverge from what was actually registered.
      let oauthPort: number | undefined;
      if (config.oauth) {
        oauthPort = await SimpleOAuthProvider.getSavedClientPort(packageId);
      }
      client = new HttpMcpClient(packageId, config, oauthPort ? { oauthPort } : undefined);
    }
    onClientCreated?.(client);

    try {
      // Connect the client
      await client.connect();
    } catch (error) {
      // Handle auth errors gracefully for HTTP clients
      if (config.transport === "http" && error instanceof Error && 
          (error.message.includes("Unauthorized") || 
           error.message.includes("401") ||
           error.message.includes("invalid_token") ||
           error.message.includes("authorization") ||
           error.name === "UnauthorizedError")) {
        logger.info("Package requires authentication", {
          package_id: packageId,
          message: `Use 'authenticate(package_id: "${packageId}")' to sign in`,
          oauth_enabled: config.oauth === true,
        });
        // Return the unconnected client - it will report as needing auth
        // The HttpMcpClient's healthCheck will return "needs_auth"
        return client;
      } else {
        // For non-auth errors and stdio errors, throw as normal
        throw error;
      }
    }
    
    return client;
  }

  /**
   * Normalize a single server entry from raw config to PackageConfig.
   * Used by restartPackage to re-expand environment variables.
   */
  private normalizeServerEntry(id: string, serverConfig: StandardServerConfig | ExtendedServerConfig): PackageConfig {
    const extConfig = serverConfig as ExtendedServerConfig;
    
    let transport: "stdio" | "http" = "stdio";
    let transportType: "sse" | "http" | undefined;
    let baseUrl: string | undefined;
    
    if (extConfig.type === "sse" || extConfig.type === "http" || extConfig.url) {
      transport = "http";
      baseUrl = extConfig.url;
      transportType = extConfig.type === "sse" ? "sse" : "http";
    }
    
    return {
      id,
      name: extConfig.name || id,
      description: extConfig.description,
      transport,
      transportType,
      command: extConfig.command,
      args: extConfig.args,
      env: expandEnvironmentVariables(extConfig.env, id),
      cwd: extConfig.cwd,
      base_url: baseUrl,
      auth: extConfig.auth,
      extra_headers: extConfig.headers,
      visibility: extConfig.visibility || "default",
      oauth: extConfig.oauth,
      oauthClientId: extConfig.oauthClientId,
      oauthClientSecret: extConfig.oauthClientSecret,
      catalogId: extConfig.catalogId,
    };
  }

  /**
   * Restart a package to pick up credential or configuration changes.
   * Closes the existing client and re-expands environment variables from raw config.
   * Next tool call will reconnect with fresh configuration.
   */
  async restartPackage(packageId: string): Promise<{ success: boolean; message: string }> {
    logger.info("Restarting package", { package_id: packageId });
    
    // Check if package exists
    const pkgIndex = this.packages.findIndex(p => p.id === packageId);
    if (pkgIndex < 0) {
      return { success: false, message: `Package '${packageId}' not found in configuration` };
    }
    
    // Wait for any pending connection to complete first (race condition handling)
    const pendingPromise = this.clientPromises.get(packageId);
    if (pendingPromise) {
      logger.debug("Waiting for pending connection before restart", { package_id: packageId });
      try {
        const pendingClient = await pendingPromise;
        await pendingClient.close();
      } catch {
        // Ignore errors - connection may have failed
      }
      this.clientPromises.delete(packageId);
    }
    
    // Close existing client if any
    const client = this.clients.get(packageId);
    if (client) {
      try {
        await client.close();
        logger.debug("Closed existing client", { package_id: packageId });
      } catch (error) {
        logger.warn("Error closing client during restart", {
          package_id: packageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.clients.delete(packageId);
    }

    this.lastActivity.delete(packageId);
    
    // Re-normalize from raw config to pick up env var changes
    const serverConfig = this.config.mcpServers?.[packageId];
    if (serverConfig) {
      const freshPkg = this.normalizeServerEntry(packageId, serverConfig);
      
      // Validate the fresh package before accepting it
      const validationError = PackageRegistry.validateSinglePackage(freshPkg);
      if (validationError) {
        // Remove the invalid package from the list
        this.packages.splice(pkgIndex, 1);
        logger.warn("Package became invalid after restart - removed from registry", {
          package_id: packageId,
          reason: validationError
        });
        return {
          success: false,
          message: `Package '${packageId}' is now invalid: ${validationError}. It has been removed from the registry.`
        };
      }
      
      this.packages[pkgIndex] = freshPkg;
      logger.info("Package config refreshed from raw config", { package_id: packageId });
    } else {
      logger.debug("No raw config found, keeping existing package config", { package_id: packageId });
    }
    
    return {
      success: true,
      message: `Package '${packageId}' restarted. Next tool call will reconnect with fresh configuration.`
    };
  }

  async closeAll(): Promise<void> {
    this.stopIdleReaper();

    logger.info("Closing all clients", {
      client_count: this.clients.size,
    });

    const closePromises = Array.from(this.clients.values()).map(client => 
      client.close().catch(error => 
        logger.error("Error closing client", {
          error: error instanceof Error ? error.message : String(error),
        })
      )
    );

    await Promise.allSettled(closePromises);
    this.clients.clear();
    this.lastActivity.clear();

    logger.info("All clients closed");
  }

  /**
   * Return lightweight per-package lifecycle + activity stats.
   *
   * Stage 4b of `docs/plans/260423_secondary_process_cpu_observability.md`.
   *
   * Iterates `this.packages` (not `this.clients`) so known-but-uncreated
   * packages are included with `connected: false, pid: null, spawn_count: 0`.
   * Emitted by GET /stats; Rebel's perf diagnostic polls and caches this
   * via `SuperMcpHttpManager.fetchStats()`.
   *
   * Pure data read — no I/O, no blocking. Safe to call on every diagnostic
   * tick. Per-child CPU/RSS is NOT reported here (plan §Stage 4b: Node's
   * `process.resourceUsage()` is self-only and cannot query children).
   */
  getChildStats(): ChildStatsEntry[] {
    const now = Date.now();
    return this.packages.map((pkg) => {
      const client = this.clients.get(pkg.id);
      const lastActivity = this.lastActivity.get(pkg.id) ?? null;

      // Best-effort PID extraction without narrowing the `McpClient`
      // interface. Only `StdioMcpClient` has `transport.pid` (available after
      // connect); HTTP clients have no subprocess to attribute.
      let pid: number | null = null;
      if (client && pkg.transport === 'stdio') {
        const maybePid = (client as unknown as { transport?: { pid?: unknown } })?.transport?.pid;
        pid = typeof maybePid === 'number' ? maybePid : null;
      }

      return {
        package_id: pkg.id,
        transport: pkg.transport,
        pid,
        connected: Boolean(client),
        idle_ms: lastActivity != null ? Math.max(0, now - lastActivity) : null,
        last_activity_at: lastActivity,
        // Stage 4b S2 refinement: strict `=== true` guards against a
        // malformed client implementation returning a non-boolean truthy
        // value. The reap-path truthiness guard in `sweepIdleClients()`
        // is intentionally left alone — its semantics ("skip if any
        // pending") match the existing reap behaviour.
        pending_requests: client?.hasPendingRequests?.() === true,
        spawn_count: this.spawnCounts.get(pkg.id) ?? 0,
        reap_count: this.reapCounts.get(pkg.id) ?? 0,
        eviction_count: this.evictionCounts.get(pkg.id) ?? 0,
        connect_retry_count: this.connectRetryCounts.get(pkg.id) ?? 0,
        connect_retry_recovered_count: this.connectRetryRecoveredCounts.get(pkg.id) ?? 0,
        connect_retry_failed_count: this.connectRetryFailedCounts.get(pkg.id) ?? 0,
        connect_retry_skipped_permanent_count:
          this.connectRetrySkippedPermanentCounts.get(pkg.id) ?? 0,
        reestablish_count: this.reestablishCounts.get(pkg.id) ?? 0,
      };
    });
  }

  async healthCheck(packageId: string): Promise<"ok" | "error" | "unavailable"> {
    try {
      const client = await this.getClient(packageId);
      if ("healthCheck" in client && typeof client.healthCheck === "function") {
        const result = await client.healthCheck();
        // Map "needs_auth" to "unavailable" for the registry level
        if (result === "needs_auth") {
          return "unavailable";
        }
        return result;
      }
      return "ok";
    } catch (error) {
      logger.debug("Health check failed", {
        package_id: packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unavailable";
    }
  }
}