import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../../logging.js";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const logger = getLogger();
const OAUTH_TOKEN_DIR_ENV = "SUPER_MCP_OAUTH_TOKEN_DIR";

function getOAuthTokenStoragePath(): string {
  return process.env[OAUTH_TOKEN_DIR_ENV] || path.join(homedir(), ".super-mcp", "oauth-tokens");
}

/**
 * Simple OAuth provider that opens browser for authorization
 */
export interface StaticOAuthCredentials {
  clientId: string;
  clientSecret?: string;
}

export class SimpleOAuthProvider implements OAuthClientProvider {
  private packageId: string;
  private savedTokens?: any;
  private codeVerifierValue?: string;
  private savedClientInfo?: any;
  private tokenStoragePath: string;
  private oauthPort: number;
  private stateValue?: string;
  private staticCredentials?: StaticOAuthCredentials;
  private redirectStarted: boolean = false;
  
  constructor(packageId: string, oauthPort: number = 5173, staticCredentials?: StaticOAuthCredentials) {
    this.packageId = packageId;
    this.oauthPort = oauthPort;
    this.tokenStoragePath = getOAuthTokenStoragePath();
    this.staticCredentials = staticCredentials;
    
    // Pre-populate client info from static credentials (skips DCR)
    if (staticCredentials) {
      this.savedClientInfo = {
        client_id: staticCredentials.clientId,
        ...(staticCredentials.clientSecret && { client_secret: staticCredentials.clientSecret }),
        redirect_uris: [`http://localhost:${oauthPort}/oauth/callback`],
      };
      logger.info("Using pre-registered OAuth client credentials (DCR skipped)", {
        package_id: packageId,
        client_id: staticCredentials.clientId,
      });
    }
  }
  
  /**
   * Get the OAuth callback port from a saved client registration.
   * Returns undefined if no registration exists or redirect_uri is malformed.
   */
  static async getSavedClientPort(packageId: string): Promise<number | undefined> {
    try {
      const tokenStoragePath = getOAuthTokenStoragePath();
      const clientPath = path.join(tokenStoragePath, `${packageId}_client.json`);
      const clientData = await fs.readFile(clientPath, "utf8");
      const clientInfo = JSON.parse(clientData);
      
      const redirectUri = clientInfo?.redirect_uris?.[0];
      if (!redirectUri) return undefined;
      
      const url = new URL(redirectUri);
      const port = parseInt(url.port, 10);
      return isNaN(port) ? undefined : port;
    } catch {
      return undefined; // No saved client or parse error
    }
  }
  
  async initialize() {
    await this.loadPersistedData();
  }
  
  private async loadPersistedData() {
    // Skip loading persisted client info if static credentials were provided
    if (!this.staticCredentials) {
      try {
        const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
        const clientData = await fs.readFile(clientPath, "utf8");
        this.savedClientInfo = JSON.parse(clientData);
        logger.debug("Loaded persisted client info", { 
          package_id: this.packageId,
          client_id: this.savedClientInfo?.client_id 
        });
      } catch (error) {
        // No saved client info
      }
    }
    
    try {
      const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
      const tokenData = await fs.readFile(tokenPath, "utf8");
      this.savedTokens = JSON.parse(tokenData);
      logger.info("Loaded persisted OAuth tokens", { 
        package_id: this.packageId,
        has_access_token: !!this.savedTokens?.access_token
      });
    } catch (error) {
      // No saved tokens
    }
  }
  
  get redirectUrl(): string {
    return `http://localhost:${this.oauthPort}/oauth/callback`;
  }
  
  get clientMetadata() {
    return {
      client_name: "super-mcp-router",  // RFC 7591 standard
      name: "super-mcp-router",         // Fallback for non-compliant servers
      description: "MCP Router for aggregating multiple MCP servers",
      redirect_uris: [`http://localhost:${this.oauthPort}/oauth/callback`]
    };
  }
  
  async clientInformation() {
    // Re-hydrate from static credentials if cleared by invalidateCredentials()
    if (!this.savedClientInfo && this.staticCredentials) {
      this.savedClientInfo = {
        client_id: this.staticCredentials.clientId,
        ...(this.staticCredentials.clientSecret && { client_secret: this.staticCredentials.clientSecret }),
        redirect_uris: [`http://localhost:${this.oauthPort}/oauth/callback`],
      };
      logger.debug("Restored static OAuth client info after invalidation", {
        package_id: this.packageId,
        client_id: this.staticCredentials.clientId,
      });
    }
    return this.savedClientInfo;
  }
  
  async saveClientInformation(info: any) {
    // For static credentials, update redirect_uris but keep the original client_id/secret
    if (this.staticCredentials) {
      this.savedClientInfo = {
        ...this.savedClientInfo,
        ...info,
        client_id: this.staticCredentials.clientId,
        client_secret: this.staticCredentials.clientSecret,
      };
      logger.debug("Updated static OAuth client info (credentials preserved)", {
        package_id: this.packageId,
        client_id: this.staticCredentials.clientId,
      });
      return;
    }
    
    this.savedClientInfo = info;
    
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true, mode: 0o700 });
      const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
      await fs.writeFile(clientPath, JSON.stringify(info, null, 2), { mode: 0o600 });
      logger.info("OAuth client information saved to disk", { 
        package_id: this.packageId,
        client_id: info?.client_id,
        path: clientPath
      });
    } catch (error) {
      logger.error("Failed to persist OAuth client info", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  async tokens() {
    return this.savedTokens;
  }
  
  async saveTokens(tokens: any) {
    const mergedTokens = {
      ...(this.savedTokens || {}),
      ...tokens,
    };

    // OAuth refresh responses often omit refresh_token when it has not rotated.
    // Preserve the existing refresh token so a routine access-token refresh does
    // not make the next app launch require full browser authentication.
    if (!tokens?.refresh_token && this.savedTokens?.refresh_token) {
      mergedTokens.refresh_token = this.savedTokens.refresh_token;
    }

    this.savedTokens = mergedTokens;
    
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true, mode: 0o700 });
      const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
      await fs.writeFile(tokenPath, JSON.stringify(mergedTokens, null, 2), { mode: 0o600 });
      logger.info("OAuth tokens saved to disk", { 
        package_id: this.packageId,
        path: tokenPath,
        has_refresh_token: !!mergedTokens.refresh_token,
      });
    } catch (error) {
      logger.error("Failed to persist OAuth tokens", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  async redirectToAuthorization(authUrl: URL) {
    this.redirectStarted = true;
    logger.info("Opening browser for OAuth", { 
      package_id: this.packageId,
      url: authUrl.toString() 
    });
    
    const clientId = authUrl.searchParams.get('client_id');
    if (clientId && !this.savedClientInfo) {
      this.savedClientInfo = {
        client_id: clientId,
        client_secret: undefined
      };
      logger.info("Extracted client_id from OAuth URL", {
        package_id: this.packageId,
        client_id: clientId
      });
    }
    
    const urlString = authUrl.toString();
    try {
      let child;
      if (process.platform === 'darwin') {
        child = spawn('open', [urlString], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'win32') {
        // Use rundll32 instead of cmd/start to avoid shell metacharacter issues with & in URLs
        child = spawn('rundll32', ['url.dll,FileProtocolHandler', urlString], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [urlString], { detached: true, stdio: 'ignore' });
      }
      // Handle spawn errors to prevent crashing the process
      child.on('error', (err) => {
        logger.error("Failed to open browser", {
          package_id: this.packageId,
          error: err.message
        });
      });
      child.unref();
      logger.info("Browser opened for OAuth", { package_id: this.packageId });
    } catch (error) {
      logger.error("Failed to open browser", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  hasStartedRedirect(): boolean {
    return this.redirectStarted;
  }
  
  async saveCodeVerifier(verifier: string) {
    this.codeVerifierValue = verifier;
  }
  
  async codeVerifier() {
    if (!this.codeVerifierValue) {
      throw new Error("PKCE code verifier not set - saveCodeVerifier() must be called first");
    }
    return this.codeVerifierValue;
  }
  
  /**
   * Returns the OAuth state parameter for CSRF protection.
   * Generates a cryptographically random 32-byte hex string on first call,
   * then returns the cached value for subsequent calls within the same auth flow.
   */
  async state(): Promise<string> {
    if (!this.stateValue) {
      this.stateValue = randomBytes(32).toString('hex');
      logger.debug("Generated OAuth state parameter", {
        package_id: this.packageId,
        state_length: this.stateValue.length
      });
    }
    return this.stateValue;
  }
  
  /**
   * Returns the stored state value without generating a new one.
   * Used for validation in the callback server.
   */
  getStoredState(): string | undefined {
    return this.stateValue;
  }
  
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery' = 'all') {
    logger.info("Invalidating OAuth credentials", { 
      package_id: this.packageId,
      scope 
    });
    
    if (scope === 'all' || scope === 'tokens') {
      this.savedTokens = undefined;
      try {
        const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
        await fs.unlink(tokenPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'client') {
      this.savedClientInfo = undefined;
      try {
        const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
        await fs.unlink(clientPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
    }
    
    // Always clear state on 'all' - state is session-specific
    if (scope === 'all') {
      this.stateValue = undefined;
    }
  }
  
  /**
   * Check if the saved client registration has a different port than current.
   * If mismatch detected, invalidates ALL credentials (client + tokens).
   * 
   * @returns true if credentials were invalidated due to mismatch
   */
  async checkAndInvalidateOnPortMismatch(): Promise<boolean> {
    if (!this.savedClientInfo?.redirect_uris?.[0]) {
      return false; // No saved client, nothing to mismatch
    }
    
    try {
      const savedUri = this.savedClientInfo.redirect_uris[0];
      const savedUrl = new URL(savedUri);
      const savedPort = parseInt(savedUrl.port, 10);
      
      if (isNaN(savedPort) || savedPort === this.oauthPort) {
        return false; // No mismatch
      }
      
      // For static credentials, just update the redirect URI (don't invalidate the client)
      if (this.staticCredentials) {
        this.savedClientInfo.redirect_uris = [`http://localhost:${this.oauthPort}/oauth/callback`];
        logger.info("Updated static OAuth redirect_uri for new port", {
          package_id: this.packageId,
          old_port: savedPort,
          new_port: this.oauthPort,
        });
        // Still invalidate tokens (they may be bound to the old redirect_uri)
        await this.invalidateCredentials('tokens');
        return true;
      }
      
      logger.warn("OAuth port mismatch detected, invalidating stale credentials", {
        package_id: this.packageId,
        saved_port: savedPort,
        current_port: this.oauthPort,
        message: "Will re-register client with new redirect_uri"
      });
      
      // Must invalidate BOTH - tokens are bound to client_id
      await this.invalidateCredentials('all');
      return true;
    } catch (error) {
      logger.debug("Error checking port mismatch", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}
