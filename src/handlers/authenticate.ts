import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";
import { findAvailablePort, checkPortAvailable } from "../utils/portFinder.js";
import { SimpleOAuthProvider } from "../auth/providers/simple.js";
import { OAUTH_FINISH_AUTH_TIMEOUT_CODE } from "../clients/httpClient.js";
import { formatError } from "../utils/formatError.js";
import { coerceStringifiedBoolean } from "../utils/normalizeInput.js";
import { getValidator } from "../validator.js";

const logger = getLogger();
const STDIO_AUTH_DELEGATION_TIMEOUT_MS = 60_000;

// Budget legs of the wait_for_completion OAuth path. The desktop host bounds the
// WHOLE handleAuthenticate call with AUTHENTICATE_TOOL_TIMEOUT_MS (app repo:
// src/main/services/mcpService.ts) — if you change any constant here, or
// FINISH_AUTH_TIMEOUT_MS / CONNECT_TIMEOUT_MS / LIST_TOOLS_TIMEOUT_MS in
// ../clients/httpClient.ts, or REGISTRY_CONNECT_ATTEMPTS in ../registry.ts, the
// desktop constant and src/handlers/__tests__/oauthBudgetInvariant.test.ts must
// move with it. The pre-check leg is branch-aware: registry.getClient() may
// health-check a cached client (LIST_TOOLS_TIMEOUT_MS) and reconnect with one
// retry (REGISTRY_CONNECT_ATTEMPTS × CONNECT_TIMEOUT_MS) BEFORE the handler's
// own health check + listTools race below.
// 5 minutes — OAuth flows can take time (login, 2FA, permissions review,
// workspace selection).
export const OAUTH_CALLBACK_TIMEOUT_MS = 300_000;
export const HEALTH_CHECK_TIMEOUT_MS = 20_000;

// Defaults for the pre-check listTools race (env override:
// SUPER_MCP_LIST_TOOLS_TIMEOUT_MS). Windows needs a longer default because of
// antivirus/firewall checks on cold-start; the Windows value is the worst case
// the OAuth budget invariant sums.
export const PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS = 30_000;
export const PRE_CHECK_LIST_TOOLS_TIMEOUT_DEFAULT_MS = 10_000;

type AuthDelegationToolCandidate = {
  name?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
};

type NamedAuthDelegationToolCandidate = AuthDelegationToolCandidate & { name: string };

function getInputSchema(tool: AuthDelegationToolCandidate): unknown {
  return tool.inputSchema ?? tool.input_schema;
}

function getRequiredArguments(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return undefined;
  }

  return (inputSchema as { required?: unknown }).required;
}

export function isEligibleForZeroArgAuthDelegation(
  tool: AuthDelegationToolCandidate,
): tool is NamedAuthDelegationToolCandidate {
  if (typeof tool.name !== "string") {
    return false;
  }

  if (tool.name !== "authenticate" && !tool.name.startsWith("authenticate_")) {
    return false;
  }

  // Eligible only if the tool can actually be invoked with `{}`. Answer that by
  // validating an empty arg object against the tool's own input schema using the
  // same Ajv validator Super-MCP enforces at call time — so this catches not just
  // top-level `required`, but `$ref` / `anyOf` / `oneOf` / `allOf` / `minProperties`
  // shapes where `{}` is invalid WITHOUT a top-level `required`. No schema → no
  // constraints → eligible. A malformed/uncompilable schema → ineligible (fail closed).
  const schema = getInputSchema(tool);
  if (schema === undefined || schema === null) {
    return true;
  }
  try {
    return getValidator().validate(schema, {}).valid;
  } catch {
    return false;
  }
}

function requiredArgsForMessage(tool: AuthDelegationToolCandidate): string[] {
  const required = getRequiredArguments(getInputSchema(tool));
  if (!Array.isArray(required)) {
    return [];
  }

  return required.filter((arg): arg is string => typeof arg === "string");
}

export async function handleAuthenticate(
  input: { package_id: string; wait_for_completion?: boolean; force?: boolean },
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  let { package_id, wait_for_completion = true, force = false } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  wait_for_completion = coerceStringifiedBoolean(wait_for_completion, {
    handler: "authenticate",
    field: "wait_for_completion",
  }) as typeof wait_for_completion;
  force = coerceStringifiedBoolean(force, { handler: "authenticate", field: "force" }) as typeof force;
  
  logger.info("=== AUTHENTICATE START ===", { 
    package_id,
    wait_for_completion,
    force,
    timestamp: new Date().toISOString(),
  });
  
  const pkg = registry.getPackage(package_id);
  if (!pkg) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            error: "Package not found",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }

  if (pkg.transport === "http" && pkg.oauth === true && wait_for_completion === false) {
    wait_for_completion = true;
    logger.warn("OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth", {
      package_id,
    });
  }
  
  if (pkg.transport === "stdio") {
    try {
      const client = await registry.getClient(package_id);
      const tools = await client.listTools();
      const authTools = tools.filter(
        (t: AuthDelegationToolCandidate): t is NamedAuthDelegationToolCandidate =>
          typeof t?.name === "string" &&
          (t.name === "authenticate" || t.name.startsWith("authenticate_")),
      );
      const authTool = authTools.find(isEligibleForZeroArgAuthDelegation);

      if (!authTool && authTools.length > 0) {
        const ineligibleTools = authTools.map((tool) => ({
          tool: tool.name,
          required: requiredArgsForMessage(tool),
        }));
        logger.warn("Stdio auth tools require arguments; refusing zero-arg generic delegation", {
          package_id,
          tools: ineligibleTools,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                error:
                  "This connector's authentication tool needs additional information, so Rebel cannot start it automatically. Please reconnect this connector from Settings.",
                ineligible_auth_tools: ineligibleTools,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      if (authTool) {
        logger.info("Delegating to stdio package's auth tool", {
          package_id,
          tool: authTool.name,
        });
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Delegated stdio auth tool timed out after ${STDIO_AUTH_DELEGATION_TIMEOUT_MS}ms`,
              ),
            );
          }, STDIO_AUTH_DELEGATION_TIMEOUT_MS);
        });

        try {
          return await Promise.race([
            client.callTool(authTool.name, {}),
            timeoutPromise,
          ]);
        } catch (err) {
          const error = formatError(err);
          const timedOut =
            typeof error === "string" &&
            error.includes(
              `timed out after ${STDIO_AUTH_DELEGATION_TIMEOUT_MS}ms`,
            );

          logger.warn(
            timedOut
              ? "Delegated stdio auth tool timed out"
              : "Failed to delegate to stdio auth tool",
            {
              package_id,
              tool: authTool.name,
              error,
            },
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  error: `Authentication delegation failed: ${error}`,
                  delegated_tool: authTool.name,
                }, null, 2),
              },
            ],
            isError: true,
          };
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to delegate to stdio auth tool, falling back to legacy response", {
        package_id,
        error: formatError(err),
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "success",
            message: "Package does not expose an authentication tool — no action needed.",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
  
  if (force) {
    logger.info("Force re-auth requested, skipping health check", { package_id });
    
    // Close and remove existing client to release resources
    const clients = (registry as any).clients as Map<string, any>;
    const existingClient = clients.get(package_id);
    if (existingClient) {
      try {
        await existingClient.close();
      } catch (err) {
        logger.debug("Error closing existing client during force re-auth", {
          package_id,
          error: formatError(err),
        });
      }
      clients.delete(package_id);
    }
    
    // Invalidate stored OAuth tokens so the new flow starts fresh.
    // Port is irrelevant for credential invalidation (operates on files by package_id).
    try {
      const tempProvider = new SimpleOAuthProvider(package_id, 5173);
      await tempProvider.initialize();
      await tempProvider.invalidateCredentials('all');
      logger.info("Invalidated stored OAuth credentials", { package_id });
    } catch (err) {
      logger.debug("No stored credentials to invalidate", {
        package_id,
        error: formatError(err),
      });
    }
    
    catalog.clearPackage(package_id);
  }
  
  if (!force) {
  try {
    logger.info("Checking if already authenticated", { package_id });
    const client = await registry.getClient(package_id);
    const health = client.healthCheck ? await client.healthCheck() : "ok";
    logger.info("Client health check", { package_id, health });
    
    if (health === "ok") {
      try {
        logger.info("Testing tool access", { package_id });
        // Timeout to prevent hanging on slow/unresponsive MCP servers
        // Windows needs longer timeout due to antivirus/firewall checks on cold-start
        const isWindows = process.platform === 'win32';
        const defaultTimeoutMs = isWindows
          ? PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS
          : PRE_CHECK_LIST_TOOLS_TIMEOUT_DEFAULT_MS;
        const timeoutMs = Number(process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS) || defaultTimeoutMs;
        const toolsPromise = client.listTools();
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`listTools timed out after ${timeoutMs}ms`)), timeoutMs)
        );
        const tools = await Promise.race([toolsPromise, timeoutPromise]);
        logger.info("Tools accessible", { package_id, tool_count: tools.length });
        catalog.clearPackage(package_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "already_authenticated",
                message: "Package is already authenticated and connected",
              }, null, 2),
            },
          ],
          isError: false,
        };
      } catch (error) {
        logger.info("Tool access failed, need to authenticate", { 
          package_id,
          error: formatError(error),
        });
      }
    }
  } catch (error) {
    logger.info("Client not available or errored", { 
      package_id,
      error: formatError(error),
    });
  }
  } // end if (!force)
  
  try {
    let callbackServer: any = null;
    let oauthPort = 5173;
    let oauthProvider: SimpleOAuthProvider | undefined;
    let oauthState: string | undefined;
    
    if (wait_for_completion) {
      try {
        // Part A: Try to reuse saved OAuth port if available
        const savedPort = await SimpleOAuthProvider.getSavedClientPort(package_id);
        if (savedPort) {
          const savedPortAvailable = await checkPortAvailable(savedPort);
          if (savedPortAvailable) {
            oauthPort = savedPort;
            logger.info("Reusing saved OAuth port", { package_id, oauth_port: oauthPort });
          } else {
            logger.info("Saved OAuth port busy, finding new port", { 
              package_id, 
              saved_port: savedPort,
              message: "Client registration will be invalidated if mismatch"
            });
            oauthPort = await findAvailablePort(5173, 10);
          }
        } else {
          oauthPort = await findAvailablePort(5173, 10);
          logger.info("Found available OAuth port", { package_id, oauth_port: oauthPort });
        }
      } catch (portError) {
        logger.error("Failed to find available port", { 
          package_id,
          error: formatError(portError)
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                message: "Failed to find available port for OAuth callback",
                error: formatError(portError),
              }, null, 2),
            },
          ],
          isError: false,
        };
      }
      
      const { OAuthCallbackServer } = await import("../auth/callbackServer.js");
      callbackServer = new OAuthCallbackServer(oauthPort);
      callbackServer.setServiceId(package_id);
      
      // Create OAuth provider early and generate state for CSRF protection
      // Pass static credentials from config if available (for servers without DCR like Asana V2)
      const staticCreds = pkg.oauthClientId
        ? { clientId: pkg.oauthClientId, clientSecret: pkg.oauthClientSecret }
        : undefined;
      oauthProvider = new SimpleOAuthProvider(package_id, oauthPort, staticCreds);
      await oauthProvider.initialize();
      
      // Check for port mismatch and invalidate stale credentials if needed
      // This ensures we re-register with the OAuth server if the port changed
      const invalidated = await oauthProvider.checkAndInvalidateOnPortMismatch();
      if (invalidated) {
        logger.info("OAuth credentials invalidated due to port mismatch, will re-register", {
          package_id,
          oauth_port: oauthPort
        });
      }
      
      oauthState = await oauthProvider.state();
      logger.info("OAuth state generated for CSRF protection", { 
        package_id, 
        state_length: oauthState.length 
      });
      
      try {
        await callbackServer.start();
        logger.info("OAuth callback server started", { package_id, oauth_port: oauthPort });
        
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error("Failed to start callback server", { 
          package_id,
          error: formatError(error)
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                message: "Failed to start OAuth callback server",
                error: formatError(error),
              }, null, 2),
            },
          ],
          isError: false,
        };
      }
    }
    
    const clients = (registry as any).clients as Map<string, any>;
    clients.delete(package_id);
    
    logger.info("Creating HTTP client with OAuth enabled", { package_id, oauth_port: oauthPort });
    const { HttpMcpClient } = await import("../clients/httpClient.js");
    const httpClient = new HttpMcpClient(package_id, pkg, { 
      oauthPort,
      oauthProvider  // Pass pre-configured provider with state already generated
    });
    
    logger.info("Triggering OAuth connection", { package_id });
    
    const connectPromise = httpClient.connectWithOAuth();
    
    if (wait_for_completion && callbackServer) {
      logger.info("Waiting for OAuth callback", { package_id });
      
      try {
        // Wait for callback with state validation for CSRF protection.
        // Outer bound: the desktop host budgets this whole call (callback wait +
        // finishOAuth token exchange + reconnect + health check) with
        // AUTHENTICATE_TOOL_TIMEOUT_MS in src/main/services/mcpService.ts —
        // that constant must strictly exceed the sum of these inner legs.
        const callbackPromise = callbackServer.waitForCallback(OAUTH_CALLBACK_TIMEOUT_MS, oauthState);
        
        // Create a promise that rejects early if connectWithOAuth fails with a fatal error.
        // Without this, a DCR failure or connect timeout would silently fail and the callback
        // server would wait the full 5 minutes for a browser redirect that will never arrive.
        const fatalConnectErrorPromise = new Promise<string>((_, reject) => {
          connectPromise.catch(err => {
            const errMsg = formatError(err);
            const isFatalAuthError = typeof errMsg === 'string' && (
              errMsg.includes("does not support dynamic client registration") ||
              errMsg.includes("Incompatible auth server") ||
              /timed?\s*out|timeout/i.test(errMsg) ||
              errMsg.includes("client registration failed")
            );
            
            if (isFatalAuthError) {
              logger.error("OAuth failed with fatal error, aborting callback wait", {
                package_id,
                error: errMsg,
              });
              reject(new Error(`OAuth setup failed: ${errMsg}`));
            } else {
              logger.debug("OAuth redirect initiated (expected)", {
                package_id,
                error: errMsg,
              });
              // Non-fatal errors (e.g., redirect initiated) — don't abort the callback wait
            }
          });
        });
        
        const authCode = await Promise.race([callbackPromise, fatalConnectErrorPromise]);
        // Suppress unhandled rejection from the losing promise after the race settles
        callbackPromise.catch(() => {});
        logger.info("OAuth callback received", { package_id, has_code: !!authCode });
        
        logger.info("Exchanging authorization code for tokens", { package_id });
        await httpClient.finishOAuth(authCode);
        
        logger.info("OAuth flow completed, verifying connection", { package_id });
        
        clients.set(package_id, httpClient);
        
        let health: "ok" | "error" | "needs_auth" | "timeout" = "timeout";
        try {
          const healthPromise = httpClient.healthCheck ? httpClient.healthCheck() : Promise.resolve("ok" as const);
          const timeoutPromise = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), HEALTH_CHECK_TIMEOUT_MS)
          );
          health = await Promise.race([healthPromise, timeoutPromise]);
        } catch (err) {
          logger.warn("Connection verification failed - tokens saved but server rejected request. Try using a tool to confirm.", { 
            package_id, 
            error: formatError(err) 
          });
          health = "error";
        }
        
        if (health === "ok") {
          logger.info("Authentication verified successfully", { package_id });
          catalog.clearPackage(package_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "authenticated",
                  message: "Successfully authenticated and verified. Ready to use.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        } else if (health === "timeout") {
          logger.info("Authentication completed, verification pending (slow server)", { package_id });
          catalog.clearPackage(package_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "authenticated",
                  message: "Successfully authenticated. The server was slow to respond, so full verification will happen on first tool use. Try using a tool to confirm everything works.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        } else {
          logger.error("Authentication verification failed", { package_id, health });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  message: `Authentication completed but verification failed (${health}). The OAuth tokens were saved, but the server rejected the connection. Try using a tool - if it fails, you may need to re-authenticate.`,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        const errMsg = formatError(error);
        // finishAuth timeout: classified by machine code, NOT message text
        // (audit F1 — the message-only rejection was swallowed as non-fatal and
        // misreported as "auth_required").
        const isFinishAuthTimeout =
          (error as { code?: unknown } | null)?.code === OAUTH_FINISH_AUTH_TIMEOUT_CODE;
        const isFatalSetupError = typeof errMsg === 'string' && errMsg.startsWith('OAuth setup failed:');
        
        logger.error("OAuth failed", {
          package_id,
          error: errMsg,
          isFatalSetupError,
          isFinishAuthTimeout,
        });
        
        // The user completed sign-in but the token exchange hung past its
        // bound. This is a terminal outcome for this attempt — report it
        // honestly instead of falling through to the pending
        // "check browser for OAuth prompt" response the desktop can't act on.
        if (isFinishAuthTimeout) {
          // Desktop (mcpService.ts) displays `parsed.error` first and only
          // falls back to `parsed.message`, so the friendly copy must live in
          // `error` and the raw internal detail in `message`. Inverted from the
          // sibling `isFatalSetupError` branch (audit F1 / Stage 7 review F1:
          // the raw "OAuth token exchange timed out after 30000ms" is jargon the
          // user would see instead of plain-language copy).
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  error: "The sign-in took too long, so we stopped waiting. Please try connecting again.",
                  message: errMsg,
                }, null, 2),
              },
            ],
            isError: false,
          };
        }
        
        // If this was a fatal setup error (DCR failure, connect timeout), return an
        // actionable error immediately instead of falling through to the generic
        // "check browser for OAuth prompt" message.
        if (isFatalSetupError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  error: errMsg,
                  message: "This connector's OAuth setup failed. It may require manual configuration (API key or pre-registered client credentials) instead of automatic sign-in.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        }
      } finally {
        if (callbackServer) {
          try {
            await callbackServer.stop();
            logger.info("OAuth callback server stopped", { package_id });
          } catch (err) {
            logger.debug("Error stopping callback server", { 
              package_id,
              error: formatError(err)
            });
          }
        }
      }
    } else {
      connectPromise.catch(err => {
        logger.debug("OAuth connection error (expected)", { 
          package_id,
          error: formatError(err)
        });
      });
    }
    
    clients.set(package_id, httpClient);
    
    const health = httpClient.healthCheck ? await httpClient.healthCheck() : "needs_auth";
    
    if (health === "ok") {
      catalog.clearPackage(package_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "authenticated",
              message: "Successfully authenticated",
            }, null, 2),
          },
        ],
        isError: false,
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "auth_required",
              message: "Authentication required - check browser for OAuth prompt",
            }, null, 2),
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    logger.error("Authentication failed", {
      package_id,
      error: formatError(error),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            message: "Authentication failed",
            error: formatError(error),
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
}
