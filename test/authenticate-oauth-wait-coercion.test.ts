import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import type { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import type { McpClient, PackageConfig } from '../src/types.js';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/logging.js', () => ({
  getLogger: () => mockLogger,
}));

vi.mock('../src/utils/portFinder.js', () => ({
  findAvailablePort: vi.fn().mockResolvedValue(5173),
  checkPortAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/utils/formatError.js', () => ({
  formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockCallbackServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  setServiceId: vi.fn(),
  waitForCallback: vi.fn().mockRejectedValue(new Error('OAuth callback timeout')),
};

const OAuthCallbackServerCtor = vi.hoisted(() =>
  vi.fn(function MockOAuthCallbackServer() {
    return mockCallbackServer;
  }),
);

vi.mock('../src/auth/callbackServer.js', () => ({
  OAuthCallbackServer: OAuthCallbackServerCtor,
}));

vi.mock('../src/auth/providers/simple.js', () => {
  function MockSimpleOAuthProvider() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      checkAndInvalidateOnPortMismatch: vi.fn().mockResolvedValue(false),
      state: vi.fn().mockResolvedValue('test-state'),
      invalidateCredentials: vi.fn().mockResolvedValue(undefined),
    };
  }
  MockSimpleOAuthProvider.getSavedClientPort = vi.fn().mockResolvedValue(undefined);
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

const mockHttpClient = {
  connectWithOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue('needs_auth' as const),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../src/clients/httpClient.js', () => ({
  HttpMcpClient: function () {
    return mockHttpClient;
  },
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

function oauthHttpPkg(): PackageConfig {
  return {
    id: 'notion-api',
    name: 'Notion',
    transport: 'http',
    base_url: 'https://notion.example.com/mcp',
    oauth: true,
    visibility: 'default',
  };
}

function nonOauthHttpPkg(): PackageConfig {
  return {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'http',
    base_url: 'https://filesystem.example.com/mcp',
    oauth: false,
    visibility: 'default',
  };
}

function stdioPkg(): PackageConfig {
  return {
    id: 'slack',
    name: 'Slack',
    transport: 'stdio',
    command: 'slack-mcp',
    visibility: 'default',
  };
}

describe('authenticate wait_for_completion coercion for OAuth packages (FOX-3326)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpClient.connectWithOAuth.mockReset();
    mockHttpClient.connectWithOAuth.mockRejectedValue(new Error('redirect initiated'));
    mockHttpClient.healthCheck.mockResolvedValue('needs_auth' as const);
    mockCallbackServer.waitForCallback.mockRejectedValue(new Error('OAuth callback timeout'));
  });

  it('coerces OAuth HTTP wait_for_completion=false (boolean) to true and enters callback-server path', async () => {
    await handleAuthenticate(
      { package_id: 'notion-api', wait_for_completion: false },
      createMockRegistry(oauthHttpPkg()),
      createMockCatalog(),
    );

    expect(OAuthCallbackServerCtor).toHaveBeenCalledTimes(1);
    expect(mockCallbackServer.start).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth',
      { package_id: 'notion-api' },
    );
  });

  it('coerces OAuth HTTP wait_for_completion="false" (stringified) to true and enters callback-server path', async () => {
    await handleAuthenticate(
      { package_id: 'notion-api', wait_for_completion: 'false' as unknown as boolean },
      createMockRegistry(oauthHttpPkg()),
      createMockCatalog(),
    );

    expect(OAuthCallbackServerCtor).toHaveBeenCalledTimes(1);
    expect(mockCallbackServer.start).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth',
      { package_id: 'notion-api' },
    );
  });

  it('does not coerce wait_for_completion=false for non-OAuth HTTP packages', async () => {
    await handleAuthenticate(
      { package_id: 'filesystem', wait_for_completion: false },
      createMockRegistry(nonOauthHttpPkg()),
      createMockCatalog(),
    );

    expect(OAuthCallbackServerCtor).not.toHaveBeenCalled();
    expect(mockCallbackServer.start).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth',
      expect.any(Object),
    );
  });

  it('does not coerce wait_for_completion=false for stdio packages', async () => {
    const registry = createMockRegistry(stdioPkg());
    (registry.getClient as any).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn(),
    } as unknown as McpClient);

    await handleAuthenticate(
      { package_id: 'slack', wait_for_completion: false },
      registry,
      createMockCatalog(),
    );

    expect(OAuthCallbackServerCtor).not.toHaveBeenCalled();
    expect(mockCallbackServer.start).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth',
      expect.any(Object),
    );
  });

  it('leaves wait_for_completion=true unchanged for OAuth packages (no coercion warn)', async () => {
    await handleAuthenticate(
      { package_id: 'notion-api', wait_for_completion: true },
      createMockRegistry(oauthHttpPkg()),
      createMockCatalog(),
    );

    expect(OAuthCallbackServerCtor).toHaveBeenCalledTimes(1);
    expect(mockCallbackServer.start).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth',
      expect.any(Object),
    );
  });
});
