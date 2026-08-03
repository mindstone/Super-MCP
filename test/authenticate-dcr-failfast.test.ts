import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import type { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import type { McpClient, PackageConfig } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../src/utils/portFinder.js', () => ({
  findAvailablePort: vi.fn().mockResolvedValue(5173),
  checkPortAvailable: vi.fn().mockResolvedValue(true),
  findAvailablePortFromCandidates: vi.fn().mockResolvedValue(5173),
  getOAuthCallbackPortCandidates: vi.fn(() => [5173, 8080, 5174]),
}));

vi.mock('../src/utils/formatError.js', () => ({
  formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// Track the callback reject function so we can verify it's called by the handler
let capturedCallbackReject: ((err: Error) => void) | undefined;
let callbackWasRejectedByHandler = false;

const mockCallbackServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  setServiceId: vi.fn(),
  waitForCallback: vi.fn().mockImplementation((_timeout: number) => {
    return new Promise((_resolve, reject) => {
      capturedCallbackReject = (err: Error) => {
        callbackWasRejectedByHandler = true;
        reject(err);
      };
      // Simulate timeout after a short delay (instead of real 300s)
      setTimeout(() => {
        if (!callbackWasRejectedByHandler) {
          reject(new Error('OAuth callback timeout'));
        }
      }, 200);
    });
  }),
};

vi.mock('../src/auth/callbackServer.js', () => ({
  OAuthCallbackServer: function() { return mockCallbackServer; },
}));

// Mock SimpleOAuthProvider including the static method
vi.mock('../src/auth/providers/simple.js', () => {
  function MockSimpleOAuthProvider() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      checkAndInvalidateOnPortMismatch: vi.fn().mockResolvedValue(false),
      state: vi.fn().mockResolvedValue('mock-state-value'),
      invalidateCredentials: vi.fn().mockResolvedValue(undefined),
      setSkipAuthorizeProbe: vi.fn(),
      consumeProbeVerdict: vi.fn().mockReturnValue(undefined),
    };
  }
  MockSimpleOAuthProvider.getSavedClientPort = vi.fn().mockResolvedValue(undefined);
  MockSimpleOAuthProvider.hasPersistedAccessToken = vi.fn().mockResolvedValue(false);
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

// Mock HttpMcpClient to simulate DCR failure
const mockHttpClient = {
  connectWithOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue('needs_auth' as const),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../src/clients/httpClient.js', async (importOriginal) => ({
  // Keep the real exported constants (e.g. OAUTH_FINISH_AUTH_TIMEOUT_CODE,
  // statically imported by authenticate.ts) — only the client class is faked.
  ...(await importOriginal<typeof import('../src/clients/httpClient.js')>()),
  HttpMcpClient: function() { return mockHttpClient; },
}));

function createMockCatalog(): Catalog {
  return {
    getPackageStatus: vi.fn().mockReturnValue('unknown'),
    clearPackage: vi.fn(),
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    countTools: vi.fn().mockReturnValue(0),
    buildPackageSummary: vi.fn().mockResolvedValue(''),
    etag: vi.fn().mockReturnValue('etag'),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getPackageForResourceUri: vi.fn().mockReturnValue(undefined),
    getKnownResourcePrefixes: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
}

function createMockRegistry(pkg: PackageConfig): PackageRegistry {
  const clients = new Map<string, McpClient>();
  return {
    getPackage: vi.fn().mockReturnValue(pkg),
    getClient: vi.fn().mockRejectedValue(new Error('not connected')),
    healthCheck: vi.fn().mockResolvedValue('error'),
    clients,
  } as unknown as PackageRegistry;
}

describe('authenticate handler: DCR fail-fast (FOX-2926)', () => {
  const oauthHttpPkg: PackageConfig = {
    id: 'zapier',
    name: 'Zapier',
    transport: 'http',
    base_url: 'https://actions.zapier.com/mcp/',
    oauth: true,
    visibility: 'default',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbackReject = undefined;
    callbackWasRejectedByHandler = false;
    mockHttpClient.connectWithOAuth.mockReset();
    mockHttpClient.healthCheck.mockResolvedValue('needs_auth' as const);
  });

  it('should complete within seconds when connectWithOAuth fails with DCR error, not wait 5 minutes', async () => {
    // Simulate DCR failure: connectWithOAuth rejects immediately
    const dcrError = new Error('Incompatible auth server: does not support dynamic client registration');
    mockHttpClient.connectWithOAuth.mockRejectedValue(dcrError);

    const startTime = Date.now();
    const result = await handleAuthenticate(
      { package_id: 'zapier', wait_for_completion: true },
      createMockRegistry(oauthHttpPkg),
      createMockCatalog(),
    );
    const elapsed = Date.now() - startTime;

    const parsed = JSON.parse(result.content[0].text);

    // Handler should complete quickly, not wait for the full callback timeout
    expect(elapsed).toBeLessThan(5_000);
    expect(parsed.status).toMatch(/error|auth_required/);
  });

  it('should surface a DCR-related error message when dynamic client registration fails', async () => {
    const dcrError = new Error('Incompatible auth server: does not support dynamic client registration');
    mockHttpClient.connectWithOAuth.mockRejectedValue(dcrError);

    const result = await handleAuthenticate(
      { package_id: 'zapier', wait_for_completion: true },
      createMockRegistry(oauthHttpPkg),
      createMockCatalog(),
    );

    const parsed = JSON.parse(result.content[0].text);

    // After the fix, the error should mention the DCR issue or suggest manual setup.
    // Currently returns generic "auth_required" with no mention of DCR.
    expect(
      parsed.error || parsed.message || ''
    ).toMatch(/dynamic client registration|manual setup|client credentials|does not support/i);
  });

  it('should surface a connection timeout error when connect times out', async () => {
    const timeoutError = new Error("Connection timed out after 30000ms for package 'zapier'");
    mockHttpClient.connectWithOAuth.mockRejectedValue(timeoutError);

    const result = await handleAuthenticate(
      { package_id: 'zapier', wait_for_completion: true },
      createMockRegistry(oauthHttpPkg),
      createMockCatalog(),
    );

    const parsed = JSON.parse(result.content[0].text);

    // After the fix, should surface the timeout error instead of waiting 5 more minutes
    expect(
      parsed.error || parsed.message || ''
    ).toMatch(/timed?\s*out|timeout|connection failed|manual setup/i);
  });
});
