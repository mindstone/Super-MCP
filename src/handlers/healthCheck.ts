import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { PackageConfig } from "../types.js";
import { getLogger } from "../logging.js";
import { coerceStringifiedBoolean } from "../utils/normalizeInput.js";

const logger = getLogger();

// Limit concurrent health checks to avoid spawning too many MCP processes at once
// This is especially important on Windows where process spawning is slower
const HEALTH_CHECK_CONCURRENCY = 5;

/**
 * Run async functions with limited concurrency.
 * Processes items in order but limits how many are in-flight simultaneously.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const promise = fn(item).then(result => {
      results[i] = result;
    }).finally(() => {
      executing.delete(promise);
    });
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

export async function handleHealthCheckAll(
  input: { detailed?: boolean },
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  let { detailed = false } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  detailed = coerceStringifiedBoolean(detailed, { handler: "health_check_all", field: "detailed" }) as typeof detailed;

  logger.info("Performing health check on all packages");

  const packages = registry.getPackages({ safe_only: false });
  
  // Use concurrency-limited health checks to avoid overwhelming the system
  const results = await mapWithConcurrencyLimit(
    packages,
    async (pkg: PackageConfig) => {
      try {
        const healthResult = typeof registry.healthCheckWithClient === "function"
          ? await registry.healthCheckWithClient(pkg.id)
          : {
              health: await registry.healthCheck(pkg.id),
              client: await registry.getClient(pkg.id),
            };
        if (healthResult.error) throw healthResult.error;
        const { health } = healthResult;

        // Sync catalog if registry reports healthy but catalog has stale error
        const catalogStatus = catalog.getPackageStatus(pkg.id);
        if (health === "ok" && (catalogStatus === "error" || catalogStatus === "auth_required")) {
          catalog.clearPackage(pkg.id);
        }

        const client = healthResult.client;
        if (!client) throw new Error(`Package '${pkg.id}' is unavailable`);
        const requiresAuth = client.requiresAuth ? await client.requiresAuth() : false;
        const isAuthenticated = requiresAuth && client.isAuthenticated ? await client.isAuthenticated() : true;

        const result: any = {
          package_id: pkg.id,
          name: pkg.name,
          transport: pkg.transport,
          status: health,
          requires_auth: requiresAuth,
          is_authenticated: isAuthenticated,
        };
        
        if (health !== "ok") {
          result.diagnostic = "Package is not healthy";
          
          if (health === "unavailable") {
            result.suggested_actions = [];
            if (pkg.transport === "stdio") {
              result.suggested_actions.push(`Check if '${pkg.command}' is installed`);
              if (pkg.command === "npx" && pkg.args?.[0]) {
                result.suggested_actions.push(`Try: npm install -g ${pkg.args[0]}`);
              }
            } else if (pkg.transport === "http") {
              result.suggested_actions.push(`Check network connectivity to ${pkg.base_url}`);
              if (requiresAuth && !isAuthenticated) {
                result.suggested_actions.push(`Run: authenticate(package_id: "${pkg.id}")`);
              }
            }
          }
        }
        
        if (pkg.env) {
          const envIssues: string[] = [];
          for (const [key, value] of Object.entries(pkg.env)) {
            if (!value || value === "" || value.includes("YOUR_") || value.startsWith("${")) {
              envIssues.push(`${key} appears unset or invalid`);
            }
          }
          if (envIssues.length > 0) {
            result.env_issues = envIssues;
          }
        }

        if (detailed) {
          result.description = pkg.description;
          result.visibility = pkg.visibility;
          if (pkg.transport === "http") {
            result.base_url = pkg.base_url;
          }
          if (pkg.transport === "stdio") {
            result.command = pkg.command;
            result.args = pkg.args;
          }
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const diagnostic: any = {
          package_id: pkg.id,
          name: pkg.name,
          transport: pkg.transport,
          status: "error",
          error: errorMessage,
          diagnostic: "Failed to check package health",
          suggested_actions: []
        };
        
        if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
          diagnostic.suggested_actions.push(`Install the MCP server: ${pkg.command}`);
        } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission")) {
          diagnostic.suggested_actions.push(`Check file permissions for: ${pkg.command}`);
        } else if (errorMessage.includes("auth")) {
          diagnostic.suggested_actions.push(`Check authentication credentials`);
        }
        
        return diagnostic;
      }
    },
    HEALTH_CHECK_CONCURRENCY
  );

  const summary = {
    total: results.length,
    healthy: results.filter((r) => r.status === "ok").length,
    errored: results.filter((r) => r.status === "error").length,
    unavailable: results.filter((r) => r.status === "unavailable").length,
    requiring_auth: results.filter((r) => r.requires_auth).length,
    authenticated: results.filter((r) => r.is_authenticated).length,
    with_env_issues: results.filter((r) => r.env_issues && r.env_issues.length > 0).length,
  };
  
  const recommendations: string[] = [];
  if (summary.errored > 0) {
    recommendations.push("Some packages have errors - check the 'suggested_actions' for each");
  }
  if (summary.unavailable > 0) {
    recommendations.push("Some packages are unavailable - they may need installation or authentication");
  }
  if (summary.with_env_issues > 0) {
    recommendations.push("Some packages have environment variable issues - check 'env_issues' for details");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ 
          summary, 
          recommendations: recommendations.length > 0 ? recommendations : undefined,
          packages: results 
        }, null, 2),
      },
    ],
    isError: false,
  };
}
