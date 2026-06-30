import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../../logging.js";
import { SimpleOAuthProvider } from "./simple.js";
import type { OAuthErrorSummary } from "./simple.js";

const logger = getLogger();

/**
 * OAuth provider wrapper that enables silent token refresh but blocks browser redirects.
 * Used during normal connect() to allow refresh tokens to work while preventing
 * unexpected browser windows during tool discovery operations.
 */
export class RefreshOnlyOAuthProvider implements OAuthClientProvider {
  private delegate: SimpleOAuthProvider;
  
  constructor(delegate: SimpleOAuthProvider) {
    this.delegate = delegate;
  }
  
  get redirectUrl(): string {
    return this.delegate.redirectUrl;
  }
  
  get clientMetadata() {
    return this.delegate.clientMetadata;
  }
  
  async clientInformation() {
    return this.delegate.clientInformation();
  }
  
  async saveClientInformation(info: any) {
    return this.delegate.saveClientInformation(info);
  }
  
  async tokens() {
    return this.delegate.tokens();
  }
  
  async saveTokens(tokens: any) {
    return this.delegate.saveTokens(tokens);
  }
  
  async saveCodeVerifier(verifier: string) {
    return this.delegate.saveCodeVerifier(verifier);
  }
  
  async codeVerifier() {
    return this.delegate.codeVerifier();
  }

  consumeLastOAuthError(): OAuthErrorSummary | undefined {
    return this.delegate.consumeLastOAuthError();
  }
  
  async redirectToAuthorization(_authUrl: URL): Promise<void> {
    logger.info("OAuth browser redirect blocked (refresh-only mode)", {
      message: "Use authenticate() to sign in"
    });
    throw new Error("Authentication required. Use 'authenticate(package_id: \"...\")' to sign in.");
  }
  
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'tokens') {
      // Disk-compare aware (replaces the old unconditional swallow): a genuinely
      // dead grant (already flagged by the transactional fetch wrapper) clears so
      // the connector un-wedges, while a peer's freshly-rotated on-disk token is
      // preserved. See SimpleOAuthProvider.invalidateTokensRefreshOnly().
      return this.delegate.invalidateTokensRefreshOnly();
    }

    return this.delegate.invalidateCredentials(scope);
  }
}
