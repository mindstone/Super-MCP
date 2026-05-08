import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import PQueue from "p-queue";
import { McpClient, PackageConfig, ReadResourceResult } from "../types.js";
import { getLogger } from "../logging.js";
import { SimpleOAuthProvider, RefreshOnlyOAuthProvider } from "../auth/providers/index.js";
import type { StaticOAuthCredentials } from "../auth/providers/simple.js";

const logger = getLogger();

/**
 * Wraps a fetch function to normalize Response objects from foreign realms.
 *
 * The MCP SDK's `parseErrorResponse()` uses `input instanceof Response` to
 * detect Response objects. This check fails when the fetch implementation
 * returns a Response from a different realm (e.g., undici vs native, or
 * bundled Node.js in Electron). When it fails, the SDK passes the raw object
 * to JSON.parse(), producing: "[object Response]" is not valid JSON.
 *
 * This wrapper detects the mismatch and re-creates the Response using
 * `globalThis.Response` so the SDK's instanceof check succeeds.
 */
function createResponseNormalizingFetch(baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response: unknown = await baseFetch(input, init);
    if (
      response !== null &&
      typeof response === 'object' &&
      'status' in response &&
      'headers' in response &&
      !(response instanceof Response)
    ) {
      // Cross-realm Response detected — re-wrap with globalThis.Response
      const r = response as { body?: ReadableStream | null; status: number; statusText?: string; headers: HeadersInit };
      return new Response(r.body ?? null, {
        status: r.status,
        statusText: r.statusText ?? '',
        headers: new Headers(r.headers),
      });
    }
    return response as Response;
  }) as typeof fetch;
}

// HTTP transport can handle more concurrent requests than STDIO, but we still
// limit concurrency to prevent overwhelming upstream servers and to provide
// fair scheduling when multiple agents share the same MCP connection
const HTTP_CONCURRENCY = 5;

export interface HttpMcpClientOptions {
  oauthPort?: number;
  /**
   * Optional pre-configured OAuth provider.
   * If provided, this provider will be used instead of creating a new one.
   * This allows the caller to pre-generate state for CSRF protection.
   */
  oauthProvider?: SimpleOAuthProvider;
}

// Default timeout for connect() to prevent hanging on unresponsive OAuth
// discovery endpoints or slow MCP servers. Covers the full transport
// negotiation + OAuth token refresh cycle.
const CONNECT_TIMEOUT_MS = 30_000;

export class HttpMcpClient implements McpClient {
  private client: Client;
  private transport?: SSEClientTransport | StreamableHTTPClientTransport;
  private packageId: string;
  private config: PackageConfig;
  private isConnected: boolean = false;
  private useOAuth: boolean = false;
  private oauthProvider?: OAuthClientProvider;
  private oauthPort: number;
  private requestQueue: PQueue;
  private externalOAuthProvider?: SimpleOAuthProvider;
  private simpleOAuthProvider?: SimpleOAuthProvider;
  private usedSseFallback: boolean = false;

  constructor(packageId: string, config: PackageConfig, options?: HttpMcpClientOptions) {
    this.packageId = packageId;
    this.config = config;
    this.oauthPort = options?.oauthPort ?? 5173;
    this.externalOAuthProvider = options?.oauthProvider;
    
    // Request queue to limit concurrent calls to this HTTP client
    this.requestQueue = new PQueue({ concurrency: HTTP_CONCURRENCY });
    
    logger.info("Created HTTP MCP client with request queue", {
      package_id: packageId,
      queue_concurrency: HTTP_CONCURRENCY,
    });
    
    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
  }
  
  private getStaticCredentials(): StaticOAuthCredentials | undefined {
    if (this.config.oauthClientId) {
      return {
        clientId: this.config.oauthClientId,
        clientSecret: this.config.oauthClientSecret,
      };
    }
    return undefined;
  }

  private isAuthLikeErrorMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("redirect initiated") ||
      normalized.includes("unauthorized") ||
      normalized.includes("401") ||
      normalized.includes("invalid_token") ||
      normalized.includes("missing authorization") ||
      normalized.includes("authentication required");
  }

  private async recreateClientForSseFallback(reason: string): Promise<void> {
    logger.warn("Retrying OAuth bootstrap with SSE fallback", {
      package_id: this.packageId,
      reason,
    });

    try {
      await this.client.close();
    } catch (closeError) {
      logger.debug("Error closing client during OAuth SSE fallback (expected)", {
        package_id: this.packageId,
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }

    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
    this.transport = undefined;
    this.usedSseFallback = true;
    this.isConnected = false;
  }

  private async initializeOAuthIfNeeded(forceOAuth: boolean = false) {
    if (this.config.oauth && !this.oauthProvider) {
      // Use external provider if provided, otherwise create a new one
      const staticCreds = this.getStaticCredentials();
      const simpleProvider = this.externalOAuthProvider ?? new SimpleOAuthProvider(this.packageId, this.oauthPort, staticCreds);
      this.simpleOAuthProvider = simpleProvider;
      
      // Only initialize if we created it (external provider should already be initialized)
      if (!this.externalOAuthProvider) {
        await simpleProvider.initialize();
      }
      
      if (forceOAuth) {
        // Part B: Safety net - invalidate stale credentials on port mismatch
        // Only check when forceOAuth=true (explicit authenticate call)
        // Don't check on normal startup to avoid breaking refresh-only flows
        // IMPORTANT: Skip this check for external providers to avoid invalidating
        // state that was already captured by the caller (race condition fix)
        if (!this.externalOAuthProvider) {
          const invalidated = await simpleProvider.checkAndInvalidateOnPortMismatch();
          if (invalidated) {
            logger.info("OAuth credentials invalidated due to port mismatch, will re-register", {
              package_id: this.packageId,
              oauth_port: this.oauthPort
            });
          }
        }
        
        this.oauthProvider = simpleProvider;
        this.useOAuth = true;
        logger.debug("OAuth provider initialized for browser flow", { 
          package_id: this.packageId, 
          oauth_port: this.oauthPort,
          external_provider: !!this.externalOAuthProvider
        });
      } else {
        const tokens = await simpleProvider.tokens();
        
        if (tokens && tokens.access_token) {
          this.oauthProvider = new RefreshOnlyOAuthProvider(simpleProvider);
          this.useOAuth = true;
          logger.debug("OAuth provider initialized for refresh-only mode (no browser)", { package_id: this.packageId });
        } else {
          logger.debug("No OAuth tokens found, will connect without auth", { package_id: this.packageId });
        }
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (!this.config.base_url) {
      throw new Error("Base URL is required for HTTP MCP client");
    }

    await this.initializeOAuthIfNeeded(false);

    logger.info("Connecting to MCP server", {
      package_id: this.packageId,
      base_url: this.config.base_url,
      using_oauth: this.useOAuth,
    });

    this.transport = this.createTransport();

    try {
      await this.connectWithTimeout(this.client, this.transport);
      this.isConnected = true;

      logger.info("Successfully connected to MCP server", {
        package_id: this.packageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Detect transport negotiation errors that indicate Streamable HTTP isn't supported
      // These errors occur when the server only supports SSE transport
      const isTransportNegotiationError = 
        errorMessage.includes("Missing sessionId parameter") ||
        errorMessage.includes("HTTP 404") ||
        errorMessage.includes("405 Method Not Allowed");
      
      // Only attempt SSE fallback if we're currently using Streamable HTTP (not already SSE)
      const currentlyUsingStreamableHttp = this.config.transportType !== "sse" && !this.usedSseFallback;
      
      if (isTransportNegotiationError && currentlyUsingStreamableHttp) {
        logger.warn("Streamable HTTP transport failed, falling back to SSE transport", {
          package_id: this.packageId,
          original_error: errorMessage,
        });
        
        try {
          // Close the existing client before creating a new one
          try {
            await this.client.close();
          } catch (closeError) {
            logger.debug("Error closing client during SSE fallback (expected)", {
              package_id: this.packageId,
              error: closeError instanceof Error ? closeError.message : String(closeError)
            });
          }
          
          // Create a fresh client for the SSE transport
          this.client = new Client(
            { name: "super-mcp-router", version: "0.1.0" },
            { capabilities: {} }
          );
          
          // Mark that we're using SSE fallback - this affects createTransport()
          this.usedSseFallback = true;
          
          // Create SSE transport and connect
          this.transport = this.createTransport();
          await this.connectWithTimeout(this.client, this.transport);
          this.isConnected = true;
          
          logger.info("Successfully connected to MCP server using SSE fallback", {
            package_id: this.packageId,
          });
          return;
        } catch (fallbackError) {
          logger.error("SSE fallback also failed", {
            package_id: this.packageId,
            original_error: errorMessage,
            fallback_error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
          // Continue to throw the original error with fallback context
          throw new Error(
            `Transport negotiation failed. Original: ${errorMessage}. ` +
            `SSE fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
          );
        }
      }
      
      if (errorMessage.includes("Client ID mismatch")) {
        logger.error("OAuth tokens are invalid (Client ID mismatch)", {
          package_id: this.packageId,
          message: "Clearing invalid tokens and requiring re-authentication",
        });
        
        if (this.oauthProvider?.invalidateCredentials) {
          await this.oauthProvider.invalidateCredentials('all');
          logger.info("Invalidated OAuth credentials using SDK method", { package_id: this.packageId });
        }
        
        const authError = new Error(
          `OAuth tokens are invalid (Client ID mismatch). Tokens have been cleared.\n` +
          `Please run 'authenticate(package_id: "${this.packageId}")' to sign in again.`
        );
        authError.name = "InvalidTokenError";
        throw authError;
      }
      
      if (this.isAuthLikeErrorMessage(errorMessage)) {
        logger.error("Authentication required for MCP server", {
          package_id: this.packageId,
          message: `Run 'authenticate(package_id: "${this.packageId}")' to connect`,
          oauth_configured: this.config.oauth === true,
          has_saved_tokens: this.useOAuth,
        });
        const authError = new Error(
          `Authentication required. Use 'authenticate(package_id: "${this.packageId}")' to sign in.`
        );
        authError.name = "UnauthorizedError";
        throw authError;
      }
      
      logger.error("Failed to connect to MCP server", {
        package_id: this.packageId,
        error: errorMessage,
      });
      throw error;
    }
  }

  private async connectWithTimeout(
    client: Client,
    transport: SSEClientTransport | StreamableHTTPClientTransport
  ): Promise<void> {
    const timeoutMs = Number(process.env.SUPER_MCP_CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connection timed out after ${timeoutMs}ms for package '${this.packageId}'`)),
        timeoutMs
      );
    });
    const connectPromise = client.connect(transport);
    try {
      await Promise.race([connectPromise, timeout]);
    } finally {
      clearTimeout(timer!);
      connectPromise.catch(() => {});
    }
  }

  private createTransport(): SSEClientTransport | StreamableHTTPClientTransport {
    const url = new URL(this.config.base_url!);
    const options = this.getTransportOptions();
    
    // Use SSE transport if explicitly configured or if we previously fell back to SSE
    if (this.config.transportType === "sse" || this.usedSseFallback) {
      logger.debug("Using HTTP+SSE transport", { 
        package_id: this.packageId,
        reason: this.usedSseFallback ? "fallback" : "configured"
      });
      return new SSEClientTransport(url, options);
    } else {
      logger.debug("Using Streamable HTTP transport", { package_id: this.packageId });
      return new StreamableHTTPClientTransport(url, options);
    }
  }

  private getTransportOptions() {
    const options: any = {};
    
    if (this.oauthProvider) {
      options.authProvider = this.oauthProvider;
      logger.debug("OAuth provider added to transport", { package_id: this.packageId });
    }

    if (this.config.extra_headers) {
      options.requestInit = {
        headers: this.config.extra_headers
      };
    }

    // Workaround for MCP SDK's parseErrorResponse() using `instanceof Response`
    // which fails when the fetch implementation returns a Response from a different
    // realm (e.g., bundled Node.js in Electron, undici vs native). When instanceof
    // fails, the SDK passes the raw object to JSON.parse() producing:
    //   "[object Response]" is not valid JSON
    // This wrapper re-creates the Response using globalThis.Response when a mismatch
    // is detected, ensuring the SDK can properly read the response body.
    options.fetch = createResponseNormalizingFetch(fetch);

    return options;
  }

  async listTools(): Promise<any[]> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    const timeout = parseInt(process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT || '10000');

    logger.info("Listing tools from HTTP MCP", {
      package_id: this.packageId,
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.listTools(undefined, { timeout });
        return response.tools || [];
      } catch (error) {
        logger.error("Failed to list tools", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<any[]>;
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    // 4h sentinel — aligned with Rebel Core's TOOL_CALL_TIMEOUT so this upstream
    // layer never kills long-running tools (deep research, pair waiting, large
    // data queries) before the outer layer's timer fires. The agent-turn watchdog
    // (Layer 2) is the real effective ceiling. Env var overrides for ops tuning.
    // See: src/core/rebelCore/mcpClient.ts.
    const timeout = this.config.timeout ||
                    parseInt(process.env.SUPER_MCP_TOOL_TIMEOUT || '14400000');

    logger.info("Calling tool on HTTP MCP", {
      package_id: this.packageId,
      tool_name: name,
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.callTool({
          name,
          arguments: args || {},
        }, undefined, {
          timeout,
          resetTimeoutOnProgress: true,
        });
        return response;
      } catch (error) {
        logger.error("Tool call failed", {
          package_id: this.packageId,
          tool_name: name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    logger.info("Closing HTTP MCP client", {
      package_id: this.packageId,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    try {
      // Clear any pending requests in the queue
      this.requestQueue.clear();
      
      await this.client.close();
      this.isConnected = false;
    } catch (error) {
      logger.error("Error closing client", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async healthCheck(): Promise<"ok" | "error" | "needs_auth"> {
    if (!this.isConnected) {
      return "needs_auth";
    }

    try {
      await this.listTools();
      return "ok";
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes("Unauthorized") || error.message.includes("401"))) {
        return "needs_auth";
      }
      return "error";
    }
  }

  async requiresAuth(): Promise<boolean> {
    return this.config.oauth === true;
  }

  async isAuthenticated(): Promise<boolean> {
    return this.isConnected;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    logger.info("Reading resource from HTTP MCP", {
      package_id: this.packageId,
      uri,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.readResource({ uri });
        return { contents: response.contents || [] };
      } catch (error) {
        logger.error("Failed to read resource", {
          package_id: this.packageId,
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<ReadResourceResult>;
  }

  supportsResources(): boolean {
    // The MCP SDK Client doesn't expose server capabilities directly,
    // so we optimistically assume resources are supported and let the
    // request fail if they're not. This is consistent with how tools work.
    return true;
  }

  hasPendingRequests(): boolean {
    return this.requestQueue.pending > 0 || this.requestQueue.size > 0;
  }

  async connectWithOAuth(): Promise<void> {
    await this.initializeOAuthIfNeeded(true);
    
    this.useOAuth = true;
    this.isConnected = false;
    
    try {
      await this.connect();
      this.isConnected = true;
    } catch (error) {
      let authError = error instanceof Error ? error : new Error(String(error));

      if (this.isAuthLikeErrorMessage(authError.message) &&
          !this.simpleOAuthProvider?.hasStartedRedirect() &&
          this.config.transportType !== "sse" &&
          !this.usedSseFallback) {
        await this.recreateClientForSseFallback(authError.message);
        try {
          await this.connect();
          this.isConnected = true;
          return;
        } catch (sseError) {
          authError = sseError instanceof Error ? sseError : new Error(String(sseError));
        }
      }

      if (this.isAuthLikeErrorMessage(authError.message)) {
        logger.debug("OAuth redirect initiated or auth needed (expected)", {
          package_id: this.packageId,
          error: authError.message
        });
      } else {
        logger.error("Unexpected error during OAuth connect", {
          package_id: this.packageId,
          error: authError.message
        });
        throw authError;
      }
    }
  }

  async finishOAuth(authCode: string): Promise<void> {
    if (!this.transport) {
      throw new Error("Transport not initialized");
    }

    logger.info("Finishing OAuth with authorization code", { 
      package_id: this.packageId,
      has_code: !!authCode 
    });

    if ('finishAuth' in this.transport && typeof this.transport.finishAuth === 'function') {
      await this.transport.finishAuth(authCode);
      logger.info("OAuth token exchange completed", { package_id: this.packageId });
      
      try {
        try {
          await this.client.close();
        } catch (closeError) {
          logger.debug("Error closing client (expected)", {
            package_id: this.packageId,
            error: closeError instanceof Error ? closeError.message : String(closeError)
          });
        }
        
        this.client = new Client(
          { name: "super-mcp-router", version: "0.1.0" },
          { capabilities: {} }
        );
        
        this.transport = this.createTransport();
        
        await this.connectWithTimeout(this.client, this.transport);
        this.isConnected = true;
        logger.info("Client connected successfully with OAuth tokens", { package_id: this.packageId });
      } catch (error) {
        logger.error("Failed to connect after OAuth", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error)
        });
        this.isConnected = false;
        throw error;
      }
    } else {
      throw new Error("Transport doesn't support OAuth finishAuth");
    }
  }
}
