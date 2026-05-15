import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";
import { findAvailablePort, checkPortAvailable } from "../utils/portFinder.js";
import { SimpleOAuthProvider } from "../auth/providers/simple.js";
import { formatError } from "../utils/formatError.js";
import { coerceStringifiedBoolean } from "../utils/normalizeInput.js";

const logger = getLogger();

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
  
  if (pkg.transport === "stdio") {
    try {
      const client = await registry.getClient(package_id);
      const tools = await client.listTools();
      const authTool = tools.find(
        (t: any) =>
          typeof t?.name === "string" &&
          (t.name === "authenticate" || t.name.startsWith("authenticate_"))
      );

      if (authTool) {
        logger.info("Delegating to stdio package's auth tool", {
          package_id,
          tool: authTool.name,
        });
        return await client.callTool(authTool.name, {});
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
            message: "stdio packages don't require authentication",
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
        const defaultTimeoutMs = isWindows ? 30000 : 10000;
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
        // Wait for callback with state validation for CSRF protection
        // 5 minutes timeout - OAuth flows can take time (login, 2FA, permissions review, workspace selection)
        const callbackPromise = callbackServer.waitForCallback(300000, oauthState);
        
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
            setTimeout(() => resolve("timeout"), 20000)
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
        const isFatalSetupError = typeof errMsg === 'string' && errMsg.startsWith('OAuth setup failed:');
        
        logger.error("OAuth failed", {
          package_id,
          error: errMsg,
          isFatalSetupError,
        });
        
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
