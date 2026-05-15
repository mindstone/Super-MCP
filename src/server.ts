import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import express from "express";
import PQueue from "p-queue";
import { ERROR_CODES } from "./types.js";
import { PackageRegistry } from "./registry.js";
import { Catalog } from "./catalog.js";
import { getValidator } from "./validator.js";
import { getLogger } from "./logging.js";
import { ConfigWatcher } from "./configWatcher.js";
import { getSecurityPolicy } from "./security.js";
import {
  handleListToolPackages,
  handleListTools,
  handleGetToolDetails,
  handleUseTool,
  handleHealthCheckAll,
  handleHealthCheckPackage,
  handleAuthenticate,
  handleGetHelp,
  handleRestartPackage,
  handleSearchTools,
  handleReadResource,
  computeSecurityAnnotation,
  extractRawToolId,
} from "./handlers/index.js";
import { formatError } from "./utils/formatError.js";

const logger = getLogger();

type ToolCatalogEntry = {
  package_id: string;
  package_name: string;
  tool_id: string;
  name: string;
  description: string;
  summary?: string;
  input_schema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  blocked?: boolean;
  blocked_reason?: string;
  user_disabled?: boolean;
  admin_disabled?: boolean;
};

type ManifestPackageEntry = {
  package_id: string;
  package_name: string;
  tool_count: number;
  embedding_hash: string;
  status: string;
};

function parseRequestedPackageIds(queryValue: unknown): string[] | null {
  const rawValues = Array.isArray(queryValue) ? queryValue : [queryValue];
  const packageIds = rawValues
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);

  return packageIds.length > 0 ? packageIds : null;
}

function selectPackages(registry: PackageRegistry, requestedPackageIds: string[] | null): ReturnType<PackageRegistry["getPackages"]> {
  const packages = registry.getPackages();
  if (!requestedPackageIds) {
    return packages;
  }

  const requestedSet = new Set(requestedPackageIds);
  return packages.filter((pkg) => requestedSet.has(pkg.id));
}

export function registerHttpApiRoutes(
  app: express.Express,
  options: {
    registry: PackageRegistry;
    catalog: Catalog;
    dnsRebindingGuard: express.RequestHandler;
  }
): void {
  const { registry, catalog, dnsRebindingGuard } = options;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http" });
  });

  // Lightweight config-hash endpoint: returns a hash of the package registry config
  // without spinning up any MCP servers. Used by Rebel as a cheap first-tier check
  // to skip the full manifest endpoint on most startups (config unchanged = tools unchanged).
  app.get("/api/tools/config-hash", (_req, res) => {
    try {
      const packages = registry.getPackages();
      const configEntries = packages.map(pkg => {
        // Hash config-relevant fields (exclude runtime state like env var values that
        // change between runs but don't affect tool availability)
        return `${pkg.id}:${pkg.name}:${pkg.transport}:${pkg.command ?? ''}:${(pkg.args ?? []).join(',')}:${pkg.base_url ?? ''}:${pkg.visibility ?? 'default'}`;
      }).sort();
      const configHash = crypto.createHash('sha256').update(configEntries.join('\n')).digest('hex');

      const securityPolicy = getSecurityPolicy();
      const securityHash = `${securityPolicy.getUserDisabledHash()}-${securityPolicy.getAdminDisabledHash()}`;

      res.json({
        config_hash: configHash,
        security_hash: securityHash,
        package_ids: packages.map(p => p.id).sort(),
        package_count: packages.length,
      });
    } catch (error) {
      logger.error("Failed to compute config hash", { error: formatError(error) });
      res.status(500).json({ error: "Failed to compute config hash" });
    }
  });

  app.get("/api/tools/manifest", async (_req, res) => {
    try {
      const packages = registry.getPackages();
      const queue = new PQueue({ concurrency: 5 });

      await Promise.all(
        packages.map((pkg) =>
          queue.add(async () => {
            try {
              await catalog.ensurePackageLoaded(pkg.id);
            } catch (pkgError) {
              logger.warn("Failed to load package for manifest", {
                package_id: pkg.id,
                error: pkgError instanceof Error ? pkgError.message : String(pkgError),
              });
            }
          })
        )
      );

      const packageEntries: ManifestPackageEntry[] = packages.map((pkg) => ({
        package_id: pkg.id,
        package_name: pkg.name || pkg.id,
        tool_count: catalog.countTools(pkg.id),
        embedding_hash: catalog.computePackageEmbeddingHash(pkg.id),
        status: catalog.getPackageStatus(pkg.id),
      }));

      const securityPolicy = getSecurityPolicy();
      const securityHash = `${securityPolicy.getUserDisabledHash()}-${securityPolicy.getAdminDisabledHash()}`;

      res.json({
        packages: packageEntries,
        security_hash: securityHash,
        package_count: packages.length,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to build tool manifest", {
        error: formatError(error),
      });
      res.status(500).json({ error: "Failed to build tool manifest" });
    }
  });

  app.get("/api/tools", async (req, res) => {
    try {
      const requestedPackageIds = parseRequestedPackageIds(req.query.packages);
      const packages = selectPackages(registry, requestedPackageIds);

      if (requestedPackageIds) {
        logger.debug("Selective tool fetch", {
          requested: requestedPackageIds.length,
          matched: packages.length,
          requested_package_ids: requestedPackageIds,
        });
      }

      const queue = new PQueue({ concurrency: 5 });

      const results = await Promise.all(
        packages.map((pkg) =>
          queue.add(async (): Promise<ToolCatalogEntry[]> => {
            try {
              await catalog.ensurePackageLoaded(pkg.id);
              const tools = await catalog.buildToolInfos(pkg.id, {
                summarize: true,
                include_schemas: true,
                include_descriptions: true,
              });

              return tools.map((tool) => ({
                package_id: pkg.id,
                package_name: pkg.name || pkg.id,
                tool_id: tool.tool_id,
                name: tool.name,
                description: tool.description || tool.summary || "",
                summary: tool.summary,
                input_schema: tool.schema,
                ...(tool.annotations ? { annotations: tool.annotations } : {}),
                ...computeSecurityAnnotation(pkg.id, pkg.catalogId, extractRawToolId(tool.tool_id)),
              }));
            } catch (pkgError) {
              logger.warn("Failed to load tools for package", {
                package_id: pkg.id,
                error: pkgError instanceof Error ? pkgError.message : String(pkgError),
              });
              return [];
            }
          })
        )
      );

      const allTools = results.flat().filter((tool): tool is ToolCatalogEntry => tool !== undefined);

      // Per-package content hashes (same algorithm as /api/tools/manifest).
      // Rebel stores these during full refresh so that later manifest comparisons
      // don't falsely detect changes due to different hash algorithms.
      const packageHashes: Record<string, string> = {};
      for (const pkg of packages) {
        const hash = catalog.computePackageEmbeddingHash(pkg.id);
        packageHashes[pkg.id] = hash; // includes "" for unloaded/empty packages
      }

      const securityPolicy = getSecurityPolicy();
      const userDisabledSummary = securityPolicy.getUserDisabledSummary();
      const userDisabledHash = securityPolicy.getUserDisabledHash();
      const adminDisabledSummary = securityPolicy.getAdminDisabledSummary();
      const adminDisabledHash = securityPolicy.getAdminDisabledHash();
      const baseEtag = catalog.etag();
      const combinedEtag = `"${baseEtag.replace(/"/g, "")}-ud${userDisabledHash}-ad${adminDisabledHash}"`;

      res.setHeader("ETag", combinedEtag);
      res.json({
        tools: allTools,
        etag: combinedEtag,
        tool_count: allTools.length,
        package_count: packages.length,
        package_hashes: packageHashes,
        user_disabled_count: userDisabledSummary.totalDisabled,
        admin_disabled_count: adminDisabledSummary.totalDisabled,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to build tool catalog", {
        error: formatError(error),
      });
      res.status(500).json({ error: "Failed to build tool catalog" });
    }
  });

  app.get("/api/skipped-servers", dnsRebindingGuard, (_req, res) => {
    res.json({ packages: registry.getSkippedPackages() });
  });

  // Stage 4b of docs/plans/260423_secondary_process_cpu_observability.md:
  // lightweight per-child lifecycle/activity metadata for Rebel's perf
  // diagnostic. Localhost-only (dnsRebindingGuard is defense-in-depth).
  // Per-child CPU/RSS is NOT reported here — Node's `process.resourceUsage()`
  // is self-only; Rebel samples per-PID CPU via its own subprocess sampler
  // using the PIDs returned in `children[].pid`.
  app.get("/stats", dnsRebindingGuard, (_req, res) => {
    try {
      const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
      res.json({
        router: {
          running: true,
          pid: process.pid,
          uptime_ms: Math.round(process.uptime() * 1000),
          started_at: startedAt,
          // Stage 4b S3 refinement: start_count/restart_count are always
          // 1/0 at the router level; super-mcp itself doesn't self-restart.
          // Rebel-side restart count lives on
          // `superMcpHttpManager.getSubprocessInfo()`.
          start_count: 1,
          restart_count: 0,
        },
        children: registry.getChildStats(),
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to build /stats payload", {
        error: formatError(error),
      });
      res.status(500).json({ error: "Failed to build stats" });
    }
  });
}

export async function startServer(options: {
  configPath?: string;
  configPaths?: string[];
  logLevel?: string;
  transport?: "stdio" | "http";
  port?: number;
}): Promise<void> {
  const { configPath, configPaths, logLevel = "info", transport = "stdio", port = 3000 } = options;
  
  const paths = configPaths || (configPath ? [configPath] : ["super-mcp-config.json"]);

  logger.setLevel(logLevel as any);
  
  logger.info("Starting Super MCP Router", {
    config_paths: paths,
    log_level: logLevel,
    transport_mode: transport,
    ...(transport === "http" && { port }),
  });

  try {
    const registry = await PackageRegistry.fromConfigFiles(paths);
    registry.startIdleReaper();
    const catalog = new Catalog(registry);
    const validator = getValidator();
    
    const configWatcher = new ConfigWatcher(paths);
    await configWatcher.start();

    function createMcpServer(): Server {
      const srv = new Server(
        {
          name: "super-mcp-router",
          version: "0.1.0",
        },
        {
          capabilities: {
            tools: {},
            resources: {},
          },
        }
      );
      registerHandlers(srv);
      return srv;
    }

    function registerHandlers(server: Server): void {

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_tool_packages",
            description: "List available MCP packages and discover their capabilities. Start here to see what tools you have access to. Each package provides a set of related tools (e.g., filesystem operations, API integrations). Returns package IDs needed for list_tools.",
            inputSchema: {
              type: "object",
              properties: {
                safe_only: {
                  type: "boolean",
                  description: "Only return packages that are considered safe",
                  default: true,
                },
                limit: {
                  type: "number",
                  description: "Maximum number of packages to return",
                  default: 100,
                },
                include_health: {
                  type: "boolean",
                  description: "Include health status for each package (shows if package is connected and ready)",
                  default: true,
                },
              },
              examples: [
                { safe_only: true, include_health: true },
                { limit: 10 }
              ],
            },
          },
          {
            name: "list_tools",
            description: `Explore tools within a specific package. Use the package_id from list_tool_packages.

Use detail="lite" for lightweight browsing (names + descriptions only), detail="full" for complete schemas and argument skeletons.

Use detail="lite" for lightweight browsing (names + descriptions only), or detail="full" for complete schemas ready to call. Use get_tool_details to hydrate specific tools by ID.`,
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "Package ID from list_tool_packages (e.g., 'filesystem', 'github', 'notion-api'). Availability depends on your super-mcp config — always verify with list_tool_packages first.",
                  examples: ["filesystem", "github", "notion-api"],
                },
                detail: {
                  type: "string",
                  enum: ["lite", "full"],
                  description: "Response detail level. 'lite' returns tool names and descriptions only (for browsing). 'full' returns names, descriptions, argument skeletons, and full JSON schemas (for ready-to-call).",
                },
                page_size: {
                  type: "number",
                  description: "Number of tools to return per page",
                  default: 20,
                },
                page_token: {
                  type: ["string", "null"],
                  description: "Token for pagination (from previous response's next_page_token)",
                },
              },
              required: ["package_id"],
              examples: [
                { package_id: "filesystem", detail: "lite" },
                { package_id: "github", detail: "full", page_size: 10 }
              ],
            },
          },
          {
            name: "get_tool_details",
            description: "Get full details and schemas for specific tools by ID. Use this to hydrate tool schemas before calling use_tool. Accepts up to 10 tool IDs at once. Always call this before using a tool for the first time.",
            inputSchema: {
              type: "object",
              properties: {
                tool_ids: {
                  type: "array",
                  items: { type: "string" },
                  description: "Array of namespaced tool IDs (e.g., ['GoogleWorkspace__send_email', 'Slack__post_message']). Max 10.",
                  maxItems: 10,
                },
              },
              required: ["tool_ids"],
            },
          },
          {
            name: "use_tool",
            description: "Execute a specific tool from a package. First use list_tool_packages to find packages, then get_tool_details to get the schema, then use this to execute. The args must match the tool's schema exactly, including casing and underscores.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "Package ID containing the tool (from list_tool_packages)",
                  examples: ["filesystem", "github"],
                },
                tool_id: {
                  type: "string",
                  description: "Tool name/ID to execute (from list_tools)",
                  examples: ["read_file", "search_repositories", "create_page"],
                },
                args: {
                  type: "object",
                  description: "Tool-specific arguments matching the schema from get_tool_details or list_tools",
                  examples: [
                    { path: "/Users/example/file.txt" },
                    { query: "language:python stars:>100" }
                  ],
                },
                dry_run: {
                  type: "boolean",
                  description: "Validate arguments without executing (useful for testing)",
                  default: false,
                },
                max_output_chars: {
                  type: ["number", "null"],
                  description: "Maximum characters to return in the output. If the tool output exceeds this limit, text content will be truncated. Use null for unlimited output.",
                },
                result_id: {
                  type: "string",
                  description: "Retrieve cached output from a previous truncated call. When provided, output_offset is required and package_id/tool_id/args are ignored.",
                },
                output_offset: {
                  type: "number",
                  description: "Character offset to start reading from in the cached result (used with result_id). Use 0 to get the full untruncated output.",
                },
                schema_hash: {
                  type: "string",
                  description: "Optional. Hash from get_tool_details response to verify schema freshness.",
                },
              },
              required: ["package_id", "tool_id", "args"],
              examples: [
                { 
                  package_id: "filesystem", 
                  tool_id: "read_file", 
                  args: { path: "/tmp/test.txt" } 
                },
                {
                  package_id: "github",
                  tool_id: "search_repositories",
                  args: { query: "mcp tools", limit: 5 },
                  dry_run: true
                },
                {
                  package_id: "filesystem",
                  tool_id: "read_file",
                  args: { path: "/tmp/large_file.log" },
                  max_output_chars: 50000
                }
              ],
            },
          },
          {
            name: "get_help",
            description: "Get detailed guidance on using Super-MCP effectively. Provides step-by-step instructions, common workflows, troubleshooting tips, and best practices. Use this when you need clarification on how to accomplish tasks.",
            inputSchema: {
              type: "object",
              properties: {
                topic: {
                  type: "string",
                  description: "Help topic to explore",
                  enum: ["getting_started", "workflow", "authentication", "tool_discovery", "error_handling", "common_patterns", "package_types"],
                  default: "getting_started",
                },
                package_id: {
                  type: "string",
                  description: "Get package-specific help and usage patterns",
                  examples: ["filesystem", "github", "notion-api"],
                },
                error_code: {
                  type: "number",
                  description: "Get help for a specific error code",
                  examples: [-33001, -33002, -33003],
                },
              },
              examples: [
                { topic: "getting_started" },
                { topic: "workflow" },
                { package_id: "github" },
                { error_code: -33005 }
              ],
            },
          },
          {
            name: "health_check_all",
            description: "Check connection status and health of all configured packages. Useful for diagnosing issues or verifying which packages are available and authenticated. Shows which packages need authentication.",
            inputSchema: {
              type: "object",
              properties: {
                detailed: {
                  type: "boolean",
                  description: "Include detailed information for each package",
                  default: false,
                },
              },
            },
          },
          {
            name: "health_check",
            description: "Check health of a single MCP package. Faster than health_check_all when you only need one package's status. Returns connection status and authentication state.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "Package ID to check (from list_tool_packages)",
                  examples: ["filesystem", "gmail", "notion-api"]
                }
              },
              required: ["package_id"]
            }
          },
          {
            name: "authenticate",
            description: "Start authentication for packages that require it. For OAuth packages (e.g., Notion, HubSpot), opens the browser for authorization. For stdio packages with their own authentication tool (e.g., Slack's authenticate_slack_workspace), delegates to that tool. Use health_check_all first to see which packages need authentication. If a package reports 'already_authenticated' but tools still fail with auth errors, use force: true to bypass the check and re-authenticate.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "The package ID to authenticate (must be an OAuth-enabled package)",
                  examples: ["notion-api", "slack"],
                },
                wait_for_completion: {
                  type: "boolean",
                  description: "Whether to wait for OAuth completion before returning",
                  default: true,
                },
                force: {
                  type: "boolean",
                  description: "Force re-authentication even if the package appears already authenticated. Use this when tools fail with auth errors but authenticate() returns 'already_authenticated'.",
                  default: false,
                },
              },
              required: ["package_id"],
            },
          },
          {
            name: "restart_package",
            description: "Restart a package to pick up credential or configuration changes. Use this after updating API keys or environment variables for a package. Closes the existing connection and re-reads configuration.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "The package ID to restart",
                  examples: ["filesystem", "github", "notion-api"],
                },
              },
              required: ["package_id"],
            },
          },
          {
            name: "search_tools",
            description: "Search across all tools using natural language. Returns the most relevant tools matching your query with full schemas, ready to use. Much faster than browsing packages manually. Use this when you know what you want to do but not which tool to use.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Natural language description of what you want to do (e.g., 'send a slack message', 'read a file', 'create calendar event')",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of results to return",
                  default: 5,
                },
                threshold: {
                  type: "number",
                  description: "Minimum relevance score (0-1) for results",
                  default: 0,
                },
                packages: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional: limit search to specific packages",
                },
              },
              required: ["query"],
              examples: [
                { query: "send a message to slack" },
                { query: "read file contents", limit: 3 },
                { query: "calendar events", packages: ["GoogleWorkspace"] },
              ],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "list_tool_packages":
            return await handleListToolPackages(args as any, registry, catalog);

          case "list_tools":
            return await handleListTools(args as any, catalog, validator, registry);

          case "get_tool_details":
            return await handleGetToolDetails(args as any, catalog, registry);

          case "use_tool":
            return await handleUseTool(args as any, registry, catalog, validator);

          case "health_check_all":
            return await handleHealthCheckAll(args as any, registry, catalog);

          case "health_check":
            return await handleHealthCheckPackage(args as any, registry, catalog);

          case "authenticate":
            return await handleAuthenticate(args as any, registry, catalog);

          case "get_help":
            return await handleGetHelp(args as any, registry);

          case "restart_package":
            return await handleRestartPackage(args as any, registry, catalog);

          case "search_tools":
            return await handleSearchTools(args as any, registry, catalog);

          default:
            throw {
              code: ERROR_CODES.INVALID_PARAMS,
              message: `Unknown tool: ${name}`,
            };
        }
      } catch (error) {
        logger.error("Tool execution failed", {
          tool_name: name,
          error: formatError(error),
        });

        if (error && typeof error === "object" && "code" in error) {
          const errorCode = (error as any).code;
          let helpfulMessage = (error as any).message;
          
          switch (errorCode) {
            case ERROR_CODES.PACKAGE_NOT_FOUND:
              helpfulMessage += ". Run 'list_tool_packages()' to see available packages.";
              break;
            case ERROR_CODES.TOOL_NOT_FOUND:
              helpfulMessage += ". Try 'search_tools(query: \"...\")' to find tools by intent, or 'list_tools(package_id: \"...\", detail: \"lite\")' to browse.";
              break;
            case ERROR_CODES.ARG_VALIDATION_FAILED:
              helpfulMessage += ". Use 'get_tool_details' to review the schema, or 'dry_run: true' to test arguments.";
              break;
            case ERROR_CODES.AUTH_REQUIRED:
              helpfulMessage += ". Run 'authenticate(package_id: \"...\")' to connect this package.";
              break;
            case ERROR_CODES.PACKAGE_UNAVAILABLE:
              helpfulMessage += ". Run 'health_check_all()' to diagnose the issue.";
              break;
            case ERROR_CODES.DOWNSTREAM_ERROR:
              helpfulMessage += ". Check the error details above. If the error persists, try 'restart_package(package_id: \"...\")' to reconnect.";
              break;
            case ERROR_CODES.TOOL_BLOCKED:
              helpfulMessage += ". This tool has been blocked by the security policy.";
              break;
          }
          
          throw {
            ...error,
            message: helpfulMessage,
          };
        }

        throw {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: `${formatError(error)}. Try 'get_help(topic: "error_handling")' for general troubleshooting.`,
          data: { tool_name: name },
        };
      }
    });

    // MCP Resources handlers for MCP Apps support
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // Phase 1: Return empty list (minimal implementation)
      // Can aggregate resources from packages in future if needed
      logger.debug("Handling resources/list request (returning empty list)");
      return { resources: [] };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri, _meta } = request.params;
      logger.info("Handling resources/read request", { uri });
      
      try {
        const result = await handleReadResource({ uri, _meta }, registry, catalog);
        // Cast to satisfy MCP SDK type requirements
        return result as unknown as { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> };
      } catch (error) {
        logger.error("Resource read failed", {
          uri,
          error: formatError(error),
        });
        throw error;
      }
    });

    } // end registerHandlers

    if (transport === "http") {
      const app = express();

      // DNS rebinding protection - validate Host header
      // Must be placed BEFORE body parsing middleware
      // Note: Server binds to 127.0.0.1 only (IPv4). If IPv6 binding is added,
      // also allow '::1' here.
      const dnsRebindingGuard: express.RequestHandler = (req, res, next) => {
        const host = req.headers.host?.split(':')[0]?.toLowerCase(); // Case-insensitive per RFC 7230
        if (host !== 'localhost' && host !== '127.0.0.1') {
          logger.warn("Request rejected - invalid Host header (DNS rebinding protection)", {
            host_header: req.headers.host // Log original for debugging
          });
          res.status(403).json({ error: 'Forbidden - invalid host' });
          return;
        }
        next();
      };

      // Apply DNS rebinding protection to /mcp endpoint; /health is left open for external probes
      app.use('/mcp', dnsRebindingGuard);

      app.use(express.json());
      registerHttpApiRoutes(app, { registry, catalog, dnsRebindingGuard });

      interface SessionEntry {
        server: Server;
        transport: StreamableHTTPServerTransport;
        lastActive: number;
      }
      const sessions = new Map<string, SessionEntry>();

      const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

      const gcInterval = setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of sessions) {
          if (now - entry.lastActive > SESSION_IDLE_TIMEOUT_MS) {
            logger.debug("Reaping idle MCP session", { sessionId: id });
            entry.server.close().catch(() => {});
            sessions.delete(id);
          }
        }
      }, GC_INTERVAL_MS);

      const mcpHandler = async (req: any, res: any) => {
        try {
          const body = req.body;
          const isInitializeRequest =
            (typeof body === "object" && body !== null && !Array.isArray(body) && body.method === "initialize") ||
            (Array.isArray(body) &&
              body.some(
                (message: any) =>
                  typeof message === "object" && message !== null && message.method === "initialize"
              ));

          if (isInitializeRequest) {
            const sessionServer = createMcpServer();
            const sessionTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (sessionId: string) => {
                sessions.set(sessionId, {
                  server: sessionServer,
                  transport: sessionTransport,
                  lastActive: Date.now(),
                });
                logger.debug("MCP session initialized", { sessionId, activeSessions: sessions.size });
              },
              onsessionclosed: (sessionId: string) => {
                sessions.delete(sessionId);
                sessionServer.close().catch(() => {});
                logger.debug("MCP session closed", { sessionId, activeSessions: sessions.size });
              },
            });
            await sessionServer.connect(sessionTransport);
            await sessionTransport.handleRequest(req, res, req.body);
            return;
          }

          // Non-initialize requests: route by session ID
          // Express lowercases headers; MCP SDK sends 'Mcp-Session-Id' which becomes 'mcp-session-id'
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          if (!sessionId) {
            res.status(400).json({ error: "Bad Request: Mcp-Session-Id header is required" });
            return;
          }

          const session = sessions.get(sessionId);
          if (!session) {
            res.status(404).json({ error: "Session not found" });
            return;
          }

          session.lastActive = Date.now();
          await session.transport.handleRequest(req, res, req.body);
        } catch (error) {
          logger.error("Failed to handle MCP request", {
            error: formatError(error),
          });
          if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
          }
        }
      };

      app.post("/mcp", mcpHandler);
      app.get("/mcp", mcpHandler);
      app.delete("/mcp", mcpHandler);

      const httpServer = app.listen(port, '127.0.0.1', () => {
        logger.info("Super MCP Router started successfully", {
          transport: "http",
          port,
          endpoint: `http://localhost:${port}/mcp`,
        });
      });

      const shutdown = async () => {
        logger.info("Shutting down HTTP server...");
        clearInterval(gcInterval);
        await configWatcher.stop();
        httpServer.close(() => {
          logger.info("HTTP server closed");
        });
        for (const [id, entry] of sessions) {
          await entry.server.close().catch(() => {});
          sessions.delete(id);
        }
        logger.info("All MCP sessions closed");
        await registry.closeAll();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      const server = createMcpServer();
      const stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);

      logger.info("Super MCP Router started successfully", {
        transport: "stdio",
      });

      const shutdown = async () => {
        logger.info("Shutting down...");
        await configWatcher.stop();
        await registry.closeAll();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    
  } catch (error) {
    logger.fatal("Failed to start server", {
      error: formatError(error),
    });
    throw error;
  }
}
