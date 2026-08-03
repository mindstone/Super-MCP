import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import PQueue from "p-queue";
import { McpClient, PackageConfig, ReadResourceResult } from "../types.js";
import { getLogger } from "../logging.js";
import { SimpleOAuthProvider, RefreshOnlyOAuthProvider } from "../auth/providers/index.js";
import { OAUTH_REDIRECT_URI_REJECTED_CODE } from "../auth/authorizeProbe.js";
import type { OAuthErrorSummary, StaticOAuthCredentials } from "../auth/providers/simple.js";
import { runRefreshTransaction } from "../auth/refreshTransaction.js";

const logger = getLogger();

export type OAuthDiscoveryKind =
  | "protected-resource"
  | "authorization-server"
  | "openid-configuration"
  | "registration"
  | "jwks"
  | "token"
  | "other-well-known";

export type OAuthDiscoveryScope = "path-relative" | "origin";
export type OAuthDiscoveryStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "network-error";

export interface OAuthDiscoveryTraceEntry {
  kind: OAuthDiscoveryKind;
  scope: OAuthDiscoveryScope;
  statusClass: OAuthDiscoveryStatusClass;
  timestampMs: number;
}

export const OAUTH_DISCOVERY_TRACE_ERROR_MARKER = "\n[super-mcp-oauth-discovery-trace:v1]";
const OAUTH_DISCOVERY_TRACE_CAPACITY = 10;

type OAuthDiscoveryClassification = Pick<OAuthDiscoveryTraceEntry, "kind" | "scope">;

const WELL_KNOWN_DISCOVERY_PATHS: ReadonlyArray<{
  path: string;
  kind: OAuthDiscoveryKind;
}> = [
  { path: "/.well-known/oauth-protected-resource", kind: "protected-resource" },
  {
    path: "/.well-known/oauth-authorization-server",
    kind: "authorization-server",
  },
  { path: "/.well-known/openid-configuration", kind: "openid-configuration" },
];

const OAUTH_ENDPOINT_PATHS: ReadonlyArray<{
  path: string;
  kind: OAuthDiscoveryKind;
}> = [
  { path: "/register", kind: "registration" },
  { path: "/jwks", kind: "jwks" },
  { path: "/token", kind: "token" },
];

function getRequestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = (input as { url?: unknown }).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

/**
 * Classify OAuth discovery traffic without retaining any URL component.
 * Only the parsed pathname participates; hosts, queries, and fragments are discarded.
 */
export function classifyOAuthDiscoveryRequest(input: RequestInfo | URL): OAuthDiscoveryClassification | undefined {
  const rawUrl = getRequestUrl(input);
  if (!rawUrl) {
    return undefined;
  }

  let pathname: string;
  try {
    pathname = new URL(rawUrl, "https://invalid.local").pathname;
  } catch {
    return undefined;
  }

  for (const candidate of WELL_KNOWN_DISCOVERY_PATHS) {
    const markerIndex = pathname.indexOf(candidate.path);
    if (markerIndex === -1) {
      continue;
    }
    const trailingPath = pathname.slice(markerIndex + candidate.path.length);
    if (trailingPath !== "" && trailingPath !== "/" && !trailingPath.startsWith("/")) {
      continue;
    }
    return {
      kind: candidate.kind,
      scope: trailingPath === "" || trailingPath === "/" ? "origin" : "path-relative",
    };
  }

  const otherWellKnownIndex = pathname.indexOf("/.well-known/");
  if (otherWellKnownIndex !== -1) {
    const wellKnownPath = pathname.slice(otherWellKnownIndex + "/.well-known/".length);
    const segmentCount = wellKnownPath.split("/").filter(Boolean).length;
    if (segmentCount > 0) {
      return {
        kind: "other-well-known",
        scope: segmentCount > 1 ? "path-relative" : "origin",
      };
    }
  }

  for (const candidate of OAUTH_ENDPOINT_PATHS) {
    if (pathname === candidate.path || pathname.endsWith(candidate.path)) {
      return {
        kind: candidate.kind,
        scope: pathname === candidate.path ? "origin" : "path-relative",
      };
    }
  }

  return undefined;
}

function classifyOAuthDiscoveryStatus(status: unknown): OAuthDiscoveryStatusClass {
  if (typeof status !== "number") {
    return "network-error";
  }
  if (status >= 200 && status < 300) {
    return "2xx";
  }
  if (status >= 300 && status < 400) {
    return "3xx";
  }
  if (status >= 400 && status < 500) {
    return "4xx";
  }
  if (status >= 500 && status < 600) {
    return "5xx";
  }
  return "network-error";
}

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
function createResponseNormalizingFetch(
  baseFetch: typeof fetch,
  onOAuthError?: (error: OAuthErrorSummary) => void,
  refreshProvider?: SimpleOAuthProvider,
  onOAuthDiscoveryRequest?: (
    classification: OAuthDiscoveryClassification,
    statusClass: OAuthDiscoveryStatusClass,
  ) => void,
): typeof fetch {
  // OAuth refresh / code-exchange failures (invalid_grant, invalid_client, …) hit the
  // authorization server's token endpoint. Scope error capture to that endpoint so a
  // normal non-OK MCP/JSON-RPC API response that happens to carry a string `error`
  // field cannot be mis-attributed as an OAuth error in a later invalidation log.
  const isOAuthTokenEndpoint = (input: RequestInfo | URL): boolean => {
    try {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request)?.url ?? "";
      if (!raw) {
        return false;
      }
      let pathname = raw;
      try {
        pathname = new URL(raw).pathname;
      } catch {
        // raw is not an absolute URL; fall back to matching the whole string
      }
      return /token/i.test(pathname);
    } catch {
      return false;
    }
  };

  const captureOAuthErrorIfPresent = async (response: Response): Promise<void> => {
    if (response.ok) {
      return;
    }

    try {
      const body = await response.clone().json();
      if (body && typeof body === "object") {
        const oauthBody = body as { error?: unknown; error_description?: unknown };
        if (typeof oauthBody.error !== "string") {
          return;
        }
        onOAuthError?.({
          error: oauthBody.error,
          ...(typeof oauthBody.error_description === "string"
            ? { error_description: oauthBody.error_description }
            : {}),
        });
      }
    } catch {
      // Ignore non-JSON or unreadable responses
    }
  };

  // Detect a refresh-token grant POST so the wrapper can run it as a
  // package-scoped atomic transaction (the rotation-race fix). Only the refresh
  // grant is intercepted; the authorization_code exchange and all other requests
  // flow through unchanged.
  const isRefreshGrantBody = (init?: RequestInit): boolean => {
    const body = init?.body;
    let params: URLSearchParams | undefined;
    if (body instanceof URLSearchParams) {
      params = body;
    } else if (typeof body === "string") {
      try {
        params = new URLSearchParams(body);
      } catch {
        return false;
      }
    }
    return params?.get("grant_type") === "refresh_token";
  };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const discoveryClassification = classifyOAuthDiscoveryRequest(input);
    // Token-endpoint refresh POSTs run through the transactional path: re-read
    // disk under a per-package cross-process lock, short-circuit on a still-valid
    // disk token, present the freshest refresh token, and recover/clear on
    // invalid_grant. The transaction internally calls baseFetch, so the result
    // still flows through the normalization + error-capture below.
    let response: unknown;
    try {
      response =
        refreshProvider && isOAuthTokenEndpoint(input) && isRefreshGrantBody(init)
          ? await runRefreshTransaction({ provider: refreshProvider, baseFetch }, input, init)
          : await baseFetch(input, init);
    } catch (error) {
      if (discoveryClassification) {
        onOAuthDiscoveryRequest?.(discoveryClassification, "network-error");
      }
      throw error;
    }
    if (discoveryClassification) {
      const status =
        response !== null && typeof response === "object" && "status" in response
          ? (response as { status?: unknown }).status
          : undefined;
      onOAuthDiscoveryRequest?.(discoveryClassification, classifyOAuthDiscoveryStatus(status));
    }
    let normalizedResponse: Response;
    if (
      response !== null &&
      typeof response === 'object' &&
      'status' in response &&
      'headers' in response &&
      !(response instanceof Response)
    ) {
      // Cross-realm Response detected — re-wrap with globalThis.Response
      const r = response as { body?: ReadableStream | null; status: number; statusText?: string; headers: HeadersInit };
      normalizedResponse = new Response(r.body ?? null, {
        status: r.status,
        statusText: r.statusText ?? '',
        headers: new Headers(r.headers),
      });
    } else {
      normalizedResponse = response as Response;
    }

    if (isOAuthTokenEndpoint(input)) {
      await captureOAuthErrorIfPresent(normalizedResponse);
    }
    return normalizedResponse;
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
// negotiation + OAuth token refresh cycle. Exported so the OAuth budget
// invariant test can assert the sum of inner legs stays inside the desktop
// host's outer authenticate budget.
export const CONNECT_TIMEOUT_MS = 30_000;

// Bounds the OAuth token exchange (transport.finishAuth) so a hung token
// endpoint fails fast instead of consuming the desktop host's whole outer
// authenticate budget (AUTHENTICATE_TOOL_TIMEOUT_MS in the app repo's
// src/main/services/mcpService.ts, which outer-bounds this leg plus the
// callback wait, post-exchange reconnect, and health check).
export const FINISH_AUTH_TIMEOUT_MS = 30_000;

// Machine code carried on the finishAuth timeout rejection so
// handleAuthenticate can classify it as a fatal outcome WITHOUT matching on
// message strings (audit F1, Stage 7 of the app repo's
// docs/plans/260728_mcp-connector-setup-failures: the message-only rejection
// was swallowed as non-fatal and reported as "auth_required").
export const OAUTH_FINISH_AUTH_TIMEOUT_CODE = "OAUTH_FINISH_AUTH_TIMEOUT";

// Re-exported so handleAuthenticate can import both OAuth machine codes from
// one place (the OAUTH_FINISH_AUTH_TIMEOUT_CODE precedent above). Defined in
// auth/authorizeProbe.ts to avoid an import cycle: auth/providers/simple.ts
// throws the coded error and is itself imported by this module.
export { OAUTH_REDIRECT_URI_REJECTED_CODE } from "../auth/authorizeProbe.js";

// Default SDK request timeout for listTools (env override:
// SUPER_MCP_LIST_TOOLS_TIMEOUT). Exported because healthCheck() delegates to
// listTools(), making this the bound on BOTH health-check legs of the
// authenticate pre-check path — a leg of the OAuth budget invariant
// (src/handlers/__tests__/oauthBudgetInvariant.test.ts).
export const LIST_TOOLS_TIMEOUT_MS = 10_000;

/**
 * Pure form of the auth-like message vocabulary, exported so the authorize
 * probe's rejection-message contract can be pinned by tests (recall#2 F2(c)):
 * a message matching these tokens is treated as an EXPECTED auth outcome and
 * swallowed (connectWithOAuth below), so the probe's coded rejection message
 * must provably never contain any of them.
 */
export function isAuthLikeErrorMessageText(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("redirect initiated") ||
    normalized.includes("unauthorized") ||
    normalized.includes("401") ||
    normalized.includes("invalid_token") ||
    normalized.includes("missing authorization") ||
    normalized.includes("authentication required");
}

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
  private usedStreamableHttpFallback: boolean = false;
  private oauthDiscoveryTrace: OAuthDiscoveryTraceEntry[] = [];

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

  private getOAuthDiscoveryTrace(): OAuthDiscoveryTraceEntry[] {
    return this.oauthDiscoveryTrace.map((entry) => ({ ...entry }));
  }

  private recordOAuthDiscoveryRequest(
    classification: OAuthDiscoveryClassification,
    statusClass: OAuthDiscoveryStatusClass,
  ): void {
    this.oauthDiscoveryTrace.push({
      ...classification,
      statusClass,
      timestampMs: Date.now(),
    });
    if (this.oauthDiscoveryTrace.length > OAUTH_DISCOVERY_TRACE_CAPACITY) {
      this.oauthDiscoveryTrace.splice(0, this.oauthDiscoveryTrace.length - OAUTH_DISCOVERY_TRACE_CAPACITY);
    }
  }

  private attachOAuthDiscoveryTrace<T extends Error>(
    error: T,
  ): T & { oauthDiscoveryTrace: OAuthDiscoveryTraceEntry[] } {
    const oauthDiscoveryTrace = this.getOAuthDiscoveryTrace();
    const markerIndex = error.message.lastIndexOf(OAUTH_DISCOVERY_TRACE_ERROR_MARKER);
    const baseMessage = markerIndex === -1 ? error.message : error.message.slice(0, markerIndex);
    error.message = `${baseMessage}${OAUTH_DISCOVERY_TRACE_ERROR_MARKER}${JSON.stringify(oauthDiscoveryTrace)}`;
    Object.defineProperty(error, "oauthDiscoveryTrace", {
      configurable: true,
      enumerable: true,
      value: oauthDiscoveryTrace,
      writable: false,
    });
    return error as T & { oauthDiscoveryTrace: OAuthDiscoveryTraceEntry[] };
  }

  private isAuthLikeErrorMessage(message: string): boolean {
    return isAuthLikeErrorMessageText(message);
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

  private async recreateClientForStreamableHttpFallback(reason: string): Promise<void> {
    logger.warn("Retrying OAuth bootstrap with Streamable HTTP fallback", {
      package_id: this.packageId,
      reason,
    });

    try {
      await this.client.close();
    } catch (closeError) {
      logger.debug("Error closing client during OAuth Streamable HTTP fallback (expected)", {
        package_id: this.packageId,
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }

    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
    this.transport = undefined;
    this.usedStreamableHttpFallback = true;
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
      
      // Detect transport negotiation errors that indicate the chosen transport
      // isn't supported by the server. Covers two error shapes:
      //   - StreamableHTTP-side: "Missing sessionId parameter", "HTTP 404",
      //     "405 Method Not Allowed" (from StreamableHTTPClientTransport)
      //   - SSE-side: "SSE error: Non-200 status code (404)" / "(405)" (from
      //     SSEClientTransport's SseError when the GET returns 404/405)
      // Narrow — 404/405 only; 401/auth, 5xx, and network errors are NOT
      // negotiation errors and must not trigger fallback.
      const isTransportNegotiationError = 
        errorMessage.includes("Missing sessionId parameter") ||
        errorMessage.includes("HTTP 404") ||
        errorMessage.includes("405 Method Not Allowed") ||
        errorMessage.includes("Non-200 status code (404)") ||
        errorMessage.includes("Non-200 status code (405)");
      
      // StreamableHTTP -> SSE fallback: only when currently using StreamableHTTP
      // (explicit http config, or already fallen back to StreamableHTTP) and not
      // already fallen back to SSE.
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
          const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          // Auth-like errors on the fallback leg are the EXPECTED OAuth-redirect
          // outcome (the SDK threw UnauthorizedError / "redirect initiated" after
          // redirectToAuthorization), not a fallback failure. Surface the original
          // error unwrapped so downstream classification (error name + message
          // substring in connectWithOAuth / registry / authenticate) survives SDK
          // message churn. Only genuine negotiation failures get the error-log +
          // "Transport negotiation failed" wrap.
          if (this.isAuthLikeErrorMessage(fallbackErrorMessage)) {
            logger.debug("SSE fallback reached OAuth redirect (expected)", {
              package_id: this.packageId,
              original_error: errorMessage,
              fallback_error: fallbackErrorMessage,
            });
            throw fallbackError;
          }
          logger.error("SSE fallback also failed", {
            package_id: this.packageId,
            original_error: errorMessage,
            fallback_error: fallbackErrorMessage,
          });
          // Continue to throw the original error with fallback context
          throw new Error(
            `Transport negotiation failed. Original: ${errorMessage}. ` +
            `SSE fallback: ${fallbackErrorMessage}`
          );
        }
      }

      // SSE -> StreamableHTTP fallback (mirror): only for explicit-SSE configs that
      // hit a negotiation-shaped error on the SSE leg, and only once. This is the
      // root-cause fix for REBEL-75V: an explicit-SSE connector against a
      // StreamableHTTP-only server (post-2025-03-26 spec norm) is otherwise a
      // guaranteed dead end — the SSE GET 404/405s, OAuth discovery never runs,
      // and the asymmetric fallback above explicitly skipped explicit-SSE.
      const canFallBackToStreamableHttp =
        this.config.transportType === "sse" &&
        !this.usedSseFallback &&
        !this.usedStreamableHttpFallback;

      if (isTransportNegotiationError && canFallBackToStreamableHttp) {
        logger.warn("SSE transport failed, falling back to Streamable HTTP transport", {
          package_id: this.packageId,
          original_error: errorMessage,
        });

        try {
          try {
            await this.client.close();
          } catch (closeError) {
            logger.debug("Error closing client during Streamable HTTP fallback (expected)", {
              package_id: this.packageId,
              error: closeError instanceof Error ? closeError.message : String(closeError),
            });
          }

          this.client = new Client(
            { name: "super-mcp-router", version: "0.1.0" },
            { capabilities: {} }
          );

          // Mark that we're using Streamable HTTP fallback - this affects
          // createTransport() and persists through finishOAuth()'s transport
          // recreation so the post-token-exchange connect uses the same transport.
          this.usedStreamableHttpFallback = true;

          this.transport = this.createTransport();
          await this.connectWithTimeout(this.client, this.transport);
          this.isConnected = true;

          logger.info("Successfully connected to MCP server using Streamable HTTP fallback", {
            package_id: this.packageId,
          });
          return;
        } catch (fallbackError) {
          const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          // Auth-like errors on the fallback leg are the EXPECTED OAuth-redirect
          // outcome (the SDK threw UnauthorizedError / "redirect initiated" after
          // redirectToAuthorization), not a fallback failure. Surface the original
          // error unwrapped so downstream classification (error name + message
          // substring in connectWithOAuth / registry / authenticate) survives SDK
          // message churn. Only genuine negotiation failures get the error-log +
          // "Transport negotiation failed" wrap. Mirrors the SSE-fallback branch
          // above.
          if (this.isAuthLikeErrorMessage(fallbackErrorMessage)) {
            logger.debug("Streamable HTTP fallback reached OAuth redirect (expected)", {
              package_id: this.packageId,
              original_error: errorMessage,
              fallback_error: fallbackErrorMessage,
            });
            throw fallbackError;
          }
          logger.error("Streamable HTTP fallback also failed", {
            package_id: this.packageId,
            original_error: errorMessage,
            fallback_error: fallbackErrorMessage,
          });
          throw new Error(
            `Transport negotiation failed. Original: ${errorMessage}. ` +
            `Streamable HTTP fallback: ${fallbackErrorMessage}`
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
    
    // Use SSE transport if explicitly configured or if we previously fell back to SSE,
    // UNLESS we fell back from SSE to Streamable HTTP (usedStreamableHttpFallback),
    // in which case Streamable HTTP wins — including during finishOAuth()'s transport
    // recreation so the post-token-exchange connect uses the same transport.
    if (
      (this.config.transportType === "sse" || this.usedSseFallback) &&
      !this.usedStreamableHttpFallback
    ) {
      logger.debug("Using HTTP+SSE transport", { 
        package_id: this.packageId,
        reason: this.usedSseFallback ? "fallback" : "configured"
      });
      return new SSEClientTransport(url, options);
    } else {
      logger.debug("Using Streamable HTTP transport", {
        package_id: this.packageId,
        reason: this.usedStreamableHttpFallback ? "fallback" : "configured",
      });
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
    options.fetch = createResponseNormalizingFetch(
      fetch,
      (error) => {
        this.simpleOAuthProvider?.setLastOAuthError(error);
      },
      this.simpleOAuthProvider,
      (classification, statusClass) => {
        this.recordOAuthDiscoveryRequest(classification, statusClass);
      },
    );

    return options;
  }

  async listTools(): Promise<any[]> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    const timeout = parseInt(process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT || String(LIST_TOOLS_TIMEOUT_MS));

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
    this.oauthDiscoveryTrace = [];
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

      // Mirror: explicit-SSE configs that hit an auth-like error on the SSE leg
      // (without having started a redirect) retry once via Streamable HTTP. This is
      // the connectWithOAuth() counterpart to the connect() SSE->StreamableHTTP
      // negotiation-error fallback. ONE retry only; no fallback if a redirect
      // already started or a prior fallback already fired.
      //
      // Defensive mirror of the pre-existing StreamableHTTP->SSE branch above
      // (:945-957). In the common shapes this branch is effectively unreachable:
      // for a negotiation-shaped SSE 404/405, connect()'s own SSE->StreamableHTTP
      // fallback fires first and sets usedStreamableHttpFallback (so the
      // `!usedStreamableHttpFallback` guard below is false); for an SSE 401, the
      // SDK's _authThenStart runs auth() and either starts a redirect
      // (hasStartedRedirect() true -> guard false) or throws a non-auth-like
      // discovery/DCR error (first condition false). The one shape it would catch
      // is an auth-like error on the SSE leg without a started redirect and
      // without the negotiation fallback having fired — kept as a defensive
      // counterpart to the symmetric pre-existing branch. No test: no confirmed
      // real firing shape.
      if (this.isAuthLikeErrorMessage(authError.message) &&
          !this.simpleOAuthProvider?.hasStartedRedirect() &&
          this.config.transportType === "sse" &&
          !this.usedSseFallback &&
          !this.usedStreamableHttpFallback) {
        await this.recreateClientForStreamableHttpFallback(authError.message);
        try {
          await this.connect();
          this.isConnected = true;
          return;
        } catch (httpError) {
          authError = httpError instanceof Error ? httpError : new Error(String(httpError));
        }
      }

      // Pre-browser probe rejection (REBEL-7F9 Stage 3): an EXPECTED outcome on
      // strict allow-list authorization servers, classified by machine code —
      // never by message text, and deliberately NOT auth-like vocabulary (the
      // auth-like branch below would swallow it and hang the callback wait).
      // Rethrown with the discovery trace so authenticate.ts can advance the
      // port-retry loop; the .code survives on the same error object.
      if ((authError as NodeJS.ErrnoException).code === OAUTH_REDIRECT_URI_REJECTED_CODE) {
        logger.info("Authorize URL rejected by provider (pre-browser probe)", {
          package_id: this.packageId,
        });
        throw this.attachOAuthDiscoveryTrace(authError);
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
        throw this.attachOAuthDiscoveryTrace(authError);
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
      // finishAuth has no timeout of its own; unbounded, a hung token endpoint
      // would eat the desktop host's outer authenticate budget and report the
      // user's completed sign-in as a timeout.
      const finishAuthPromise = Promise.resolve(this.transport.finishAuth(authCode));
      let finishAuthTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          finishAuthPromise,
          new Promise<never>((_, reject) => {
            finishAuthTimer = setTimeout(() => {
              const timeoutError = new Error(
                `OAuth token exchange timed out after ${FINISH_AUTH_TIMEOUT_MS}ms`
              );
              // Machine-classifiable marker — handleAuthenticate keys its fatal
              // classification off this code, never the message text.
              (timeoutError as NodeJS.ErrnoException).code = OAUTH_FINISH_AUTH_TIMEOUT_CODE;
              reject(timeoutError);
            }, FINISH_AUTH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (finishAuthTimer !== undefined) {
          clearTimeout(finishAuthTimer);
        }
        // Suppress a late rejection from the losing promise after a timeout win
        finishAuthPromise.catch(() => {});
      }
      logger.info("OAuth token exchange completed", { package_id: this.packageId });

      // A completed browser re-auth means any prior dead-grant marker is now
      // stale — clear it so the host stops surfacing a reconnect prompt for a
      // connector that just reconnected. The refresh path clears the marker on a
      // successful rotation (refreshTransaction.ts); this is the sibling clear
      // for the interactive authorization-code path, which persists tokens via
      // the SDK's saveTokens() (which does NOT itself clear the marker). Gated on
      // the marker existing, so the common first-time-connect path is a no-op.
      await this.simpleOAuthProvider?.clearNeedsReconnectMarker();

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
