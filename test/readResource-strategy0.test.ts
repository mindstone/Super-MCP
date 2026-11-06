import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReadResource } from '../src/handlers/readResource.js';
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

/** Create a mock McpClient with optional overrides. */
function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue('ok'),
    requiresAuth: vi.fn().mockResolvedValue(false),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'test://r', text: 'data' }] }),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** Create a mock Catalog with configurable per-package status. */
function createMockCatalog(statusMap: Record<string, string> = {}): Catalog {
  return {
    getPackageStatus: vi.fn((id: string) => statusMap[id] ?? 'unknown'),
    clearPackage: vi.fn(),
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    countTools: vi.fn().mockReturnValue(3),
    buildPackageSummary: vi.fn().mockResolvedValue('mock summary'),
    etag: vi.fn().mockReturnValue('etag-1'),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getPackageForResourceUri: vi.fn().mockReturnValue(undefined),
    getKnownResourcePrefixes: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
}

/** Create a mock PackageRegistry with configurable behavior. */
function createMockRegistry(overrides: {
  getClient?: (id: string) => Promise<McpClient>;
  getPackage?: (id: string) => PackageConfig | undefined;
} = {}): PackageRegistry {
  const defaultPkg: PackageConfig = {
    id: 'test-pkg',
    name: 'Test Package',
    transport: 'http',
    base_url: 'http://localhost:3000',
    visibility: 'default',
  };
  return {
    getClient: overrides.getClient ?? vi.fn().mockResolvedValue(createMockClient()),
    getPackage: overrides.getPackage ?? vi.fn().mockReturnValue(defaultPkg),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// Strategy 0: _meta.rebel_packageId hint routing
// ---------------------------------------------------------------------------

describe('readResource Strategy 0: _meta.rebel_packageId routing', () => {
  it('routes to hinted package when valid', async () => {
    const hintedPkg: PackageConfig = {
      id: 'GoogleWorkspace-sam',
      name: 'Google Workspace (Sam)',
      transport: 'http',
      base_url: 'http://localhost:4000',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => (id === 'GoogleWorkspace-sam' ? hintedPkg : undefined));

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();

    await handleReadResource(
      { uri: 'ui://google-workspace/compose-email', _meta: { rebel_packageId: 'GoogleWorkspace-sam' } },
      registry,
      catalog,
    );

    // Should route via Strategy 0 hint
    expect(getClient).toHaveBeenCalledWith('GoogleWorkspace-sam');
    // Strategy 1 should NOT be consulted
    expect(catalog.getPackageForResourceUri).not.toHaveBeenCalled();
  });

  it('falls through to Strategy 1 when hint is invalid (nonexistent package)', async () => {
    const actualPkg: PackageConfig = {
      id: 'actual-pkg',
      name: 'Actual Package',
      transport: 'http',
      base_url: 'http://localhost:5000',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => (id === 'actual-pkg' ? actualPkg : undefined));

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('actual-pkg');

    await handleReadResource(
      { uri: 'ui://google-workspace/compose-email', _meta: { rebel_packageId: 'nonexistent-pkg' } },
      registry,
      catalog,
    );

    // Strategy 1 should be consulted since hint was invalid
    expect(catalog.getPackageForResourceUri).toHaveBeenCalledWith('ui://google-workspace/compose-email');
    // Should route to the package found by Strategy 1
    expect(getClient).toHaveBeenCalledWith('actual-pkg');
  });

  it('falls through when rebel_packageId is empty string', async () => {
    const actualPkg: PackageConfig = {
      id: 'actual-pkg',
      name: 'Actual Package',
      transport: 'http',
      base_url: 'http://localhost:5000',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => (id === 'actual-pkg' ? actualPkg : undefined));

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('actual-pkg');

    await handleReadResource(
      { uri: 'ui://google-workspace/compose-email', _meta: { rebel_packageId: '' } },
      registry,
      catalog,
    );

    // Empty string should fall through — Strategy 1 consulted
    expect(catalog.getPackageForResourceUri).toHaveBeenCalledWith('ui://google-workspace/compose-email');
    expect(getClient).toHaveBeenCalledWith('actual-pkg');
  });

  it('falls through when rebel_packageId is non-string (number)', async () => {
    const actualPkg: PackageConfig = {
      id: 'actual-pkg',
      name: 'Actual Package',
      transport: 'http',
      base_url: 'http://localhost:5000',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => (id === 'actual-pkg' ? actualPkg : undefined));

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('actual-pkg');

    await handleReadResource(
      { uri: 'ui://google-workspace/compose-email', _meta: { rebel_packageId: 123 } },
      registry,
      catalog,
    );

    // Non-string should fall through — Strategy 1 consulted
    expect(catalog.getPackageForResourceUri).toHaveBeenCalledWith('ui://google-workspace/compose-email');
    expect(getClient).toHaveBeenCalledWith('actual-pkg');
  });

  it('takes priority over Strategy 1 when both would match', async () => {
    const pkgA: PackageConfig = {
      id: 'PackageA',
      name: 'Package A',
      transport: 'http',
      base_url: 'http://localhost:3001',
      visibility: 'default',
    };
    const pkgB: PackageConfig = {
      id: 'PackageB',
      name: 'Package B',
      transport: 'http',
      base_url: 'http://localhost:3002',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => {
      if (id === 'PackageA') return pkgA;
      if (id === 'PackageB') return pkgB;
      return undefined;
    });

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();
    // Strategy 1 would return PackageA
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('PackageA');

    await handleReadResource(
      { uri: 'ui://shared-app/page', _meta: { rebel_packageId: 'PackageB' } },
      registry,
      catalog,
    );

    // Strategy 0 hint (PackageB) should win over Strategy 1 (PackageA)
    expect(getClient).toHaveBeenCalledWith('PackageB');
    // Strategy 1 should NOT be consulted
    expect(catalog.getPackageForResourceUri).not.toHaveBeenCalled();
  });

  it('works normally without _meta (falls through to Strategy 1/2)', async () => {
    const actualPkg: PackageConfig = {
      id: 'mapped-pkg',
      name: 'Mapped Package',
      transport: 'http',
      base_url: 'http://localhost:6000',
      visibility: 'default',
    };

    const client = createMockClient();
    const getClient = vi.fn().mockResolvedValue(client);
    const getPackage = vi.fn((id: string) => (id === 'mapped-pkg' ? actualPkg : undefined));

    const registry = createMockRegistry({ getClient, getPackage });
    const catalog = createMockCatalog();
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('mapped-pkg');

    await handleReadResource(
      { uri: 'ui://google-workspace/compose-email' },
      registry,
      catalog,
    );

    // Strategy 1 should be consulted
    expect(catalog.getPackageForResourceUri).toHaveBeenCalledWith('ui://google-workspace/compose-email');
    expect(getClient).toHaveBeenCalledWith('mapped-pkg');
  });
});
