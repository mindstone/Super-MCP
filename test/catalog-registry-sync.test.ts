import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHealthCheckPackage } from '../src/handlers/healthCheckPackage.js';
import { handleHealthCheckAll } from '../src/handlers/healthCheck.js';
import { handleRestartPackage } from '../src/handlers/restartPackage.js';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { handleReadResource } from '../src/handlers/readResource.js';
import { Catalog } from '../src/catalog.js';
import { CatalogRefresher } from '../src/catalogRefresher.js';
import type { PackageRegistry, RegistryLifecycleEvent } from '../src/registry.js';
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

// Mock portFinder to avoid real port scanning in authenticate tests
vi.mock('../src/utils/portFinder.js', () => ({
  findAvailablePort: vi.fn().mockResolvedValue(5173),
  checkPortAvailable: vi.fn().mockResolvedValue(true),
}));

// Mock formatError used by authenticate handler
vi.mock('../src/utils/formatError.js', () => ({
  formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

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

/** Create a mock PackageRegistry with configurable behavior. */
function createMockRegistry(overrides: {
  healthCheck?: (id: string) => Promise<'ok' | 'error' | 'unavailable'>;
  getClient?: (id: string) => Promise<McpClient>;
  getPackage?: (id: string) => PackageConfig | undefined;
  getPackages?: (opts?: { safe_only?: boolean }) => PackageConfig[];
  restartPackage?: (id: string) => Promise<{ success: boolean; message: string }>;
} = {}): PackageRegistry {
  const defaultPkg: PackageConfig = {
    id: 'test-pkg',
    name: 'Test Package',
    transport: 'http',
    base_url: 'http://localhost:3000',
    visibility: 'default',
  };
  return {
    healthCheck: overrides.healthCheck ?? vi.fn().mockResolvedValue('ok'),
    getClient: overrides.getClient ?? vi.fn().mockResolvedValue(createMockClient()),
    getPackage: overrides.getPackage ?? vi.fn().mockReturnValue(defaultPkg),
    getPackages: overrides.getPackages ?? vi.fn().mockReturnValue([defaultPkg]),
    restartPackage: overrides.restartPackage ?? vi.fn().mockResolvedValue({ success: true, message: 'restarted' }),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// health_check handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: health_check handler', () => {
  it('clears catalog when catalog="error" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('clears catalog when catalog="auth_required" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'auth_required' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when catalog="ready" and health="ok"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'ready' });
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('does NOT clear catalog when catalog="error" and health="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('error'),
    });

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('does NOT clear catalog when catalog="unknown" and health="ok"', async () => {
    const catalog = createMockCatalog({}); // unknown by default
    const registry = createMockRegistry();

    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// health_check_all handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: health_check_all handler', () => {
  it('clears only the stale-error package, not the ready one', async () => {
    const pkgA: PackageConfig = {
      id: 'pkg-a',
      name: 'Package A',
      transport: 'http',
      base_url: 'http://localhost:3001',
      visibility: 'default',
    };
    const pkgB: PackageConfig = {
      id: 'pkg-b',
      name: 'Package B',
      transport: 'http',
      base_url: 'http://localhost:3002',
      visibility: 'default',
    };

    const catalog = createMockCatalog({ 'pkg-a': 'error', 'pkg-b': 'ready' });
    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      getPackages: vi.fn().mockReturnValue([pkgA, pkgB]),
      getClient: vi.fn().mockResolvedValue(createMockClient()),
    });

    await handleHealthCheckAll({ detailed: false }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('pkg-a');
    expect(catalog.clearPackage).not.toHaveBeenCalledWith('pkg-b');
  });
});

// ---------------------------------------------------------------------------
// restart_package handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: restart_package handler', () => {
  it('clears catalog when restart succeeds and catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      restartPackage: vi.fn().mockResolvedValue({ success: true, message: 'restarted' }),
    });

    await handleRestartPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when restart fails', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      restartPackage: vi.fn().mockResolvedValue({ success: false, message: 'failed' }),
    });

    await handleRestartPackage({ package_id: 'test-pkg' }, registry, catalog);

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('awaits the bounded catalog refresh before returning restart success', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry();
    let releaseRefresh!: () => void;
    const refreshNow = vi.fn(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    let settled = false;

    const resultPromise = handleRestartPackage(
      { package_id: 'test-pkg' },
      registry,
      catalog,
      { refreshNow, scheduleRefresh: vi.fn() },
    ).then((result) => {
      settled = true;
      return result;
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(settled).toBe(false);
    expect(refreshNow).toHaveBeenCalledWith('test-pkg', {
      forceReconnect: true,
      reason: 'restart',
    });
    releaseRefresh();
    await expect(resultPromise).resolves.toMatchObject({ isError: false });
  });
});

// ---------------------------------------------------------------------------
// authenticate handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: authenticate handler', () => {
  it('clears catalog on already_authenticated when catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const client = createMockClient({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      listTools: vi.fn().mockResolvedValue([{ name: 'tool1' }]),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
      getPackage: vi.fn().mockReturnValue({
        id: 'test-pkg',
        name: 'Test',
        transport: 'http',
        base_url: 'http://localhost:3000',
        visibility: 'default',
      }),
    });

    const result = await handleAuthenticate(
      { package_id: 'test-pkg', wait_for_completion: false },
      registry,
      catalog,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('already_authenticated');
    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('skips health check and clears catalog when force=true', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const client = createMockClient({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      listTools: vi.fn().mockResolvedValue([{ name: 'tool1' }]),
      close: vi.fn().mockResolvedValue(undefined),
    });

    // Set up registry with a clients Map so force can delete it
    const clientsMap = new Map<string, McpClient>();
    clientsMap.set('test-pkg', client);
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
      getPackage: vi.fn().mockReturnValue({
        id: 'test-pkg',
        name: 'Test',
        transport: 'http',
        base_url: 'http://localhost:3000',
        visibility: 'default',
      }),
    });
    (registry as any).clients = clientsMap;

    const result = await handleAuthenticate(
      { package_id: 'test-pkg', wait_for_completion: false, force: true },
      registry,
      catalog,
    );

    const parsed = JSON.parse(result.content[0].text);
    // force=true should NOT return already_authenticated — it skips the check entirely
    expect(parsed.status).not.toBe('already_authenticated');
    // The health check should NOT have been called
    expect(client.healthCheck).not.toHaveBeenCalled();
    // The existing client should have been closed
    expect(client.close).toHaveBeenCalled();
    // Catalog should have been cleared
    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when getClient throws (auth failure)', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const registry = createMockRegistry({
      getClient: vi.fn().mockRejectedValue(new Error('connection failed')),
      getPackage: vi.fn().mockReturnValue({
        id: 'test-pkg',
        name: 'Test',
        transport: 'http',
        base_url: 'http://localhost:3000',
        visibility: 'default',
      }),
    });

    // When getClient throws AND the subsequent OAuth flow also fails,
    // catalog should NOT be cleared
    const result = await handleAuthenticate(
      { package_id: 'test-pkg', wait_for_completion: false },
      registry,
      catalog,
    );

    const parsed = JSON.parse(result.content[0].text);
    // Status will be auth_required or error since client isn't healthy
    expect(parsed.status).not.toBe('already_authenticated');
    expect(parsed.status).not.toBe('authenticated');
    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });

  it('awaits the bounded catalog refresh after successful authentication', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    const client = createMockClient({
      healthCheck: vi.fn().mockResolvedValue('ok'),
      listTools: vi.fn().mockResolvedValue([{ name: 'tool1' }]),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
    });
    let releaseRefresh!: () => void;
    const refreshNow = vi.fn(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    let settled = false;

    const resultPromise = handleAuthenticate(
      { package_id: 'test-pkg' },
      registry,
      catalog,
      { refreshNow, scheduleRefresh: vi.fn() },
    ).then((result) => {
      settled = true;
      return result;
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(settled).toBe(false);
    expect(refreshNow).toHaveBeenCalledWith('test-pkg', {
      forceReconnect: true,
      reason: 'authentication',
    });
    releaseRefresh();
    await expect(resultPromise).resolves.toMatchObject({ isError: false });
  });
});

// ---------------------------------------------------------------------------
// list_tool_packages handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: list_tool_packages handler', () => {
  it('refresher clears a stale catalog error after a healthy client lifecycle event', async () => {
    const pkg: PackageConfig = {
      id: 'test-pkg',
      name: 'Test Package',
      transport: 'http',
      base_url: 'http://localhost:3000',
      visibility: 'default',
    };
    const client = createMockClient({
      listTools: vi.fn().mockResolvedValue([{ name: 'recovered_tool' }]),
    });
    let lifecycleListener: ((event: RegistryLifecycleEvent) => void) | undefined;
    const registry = {
      getPackage: vi.fn().mockReturnValue(pkg),
      getPackages: vi.fn().mockReturnValue([pkg]),
      subscribeLifecycle: vi.fn((listener: (event: RegistryLifecycleEvent) => void) => {
        lifecycleListener = listener;
        return vi.fn();
      }),
      connectForCatalog: vi.fn().mockResolvedValue({ kind: 'connected', client }),
    } as unknown as PackageRegistry;
    const catalog = new Catalog(registry);
    const readyGeneration = catalog.beginRefresh(pkg.id);
    catalog.commitReady(pkg.id, [{ name: 'old_tool' }], readyGeneration);
    const refresher = new CatalogRefresher(catalog, registry);
    refresher.start();

    const failureGeneration = catalog.beginRefresh(pkg.id);
    catalog.commitFailure(pkg.id, failureGeneration, {
      status: 'error',
      lastError: 'stale failure',
      failureClass: 'permanent',
      nextRetryAt: null,
      nextAuthProbeAt: null,
    });
    lifecycleListener?.({
      type: 'client_created',
      packageId: pkg.id,
    });
    await vi.waitFor(() => {
      expect(catalog.getPackageStatus(pkg.id)).toBe('ready');
    });

    expect(catalog.getPackageTools(pkg.id).map((tool) => tool.tool.name)).toEqual([
      'recovered_tool',
    ]);
    expect(registry.connectForCatalog).toHaveBeenCalledOnce();
    await refresher.dispose();
  });
});

// ---------------------------------------------------------------------------
// readResource handler
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: readResource handler', () => {
  it('clears catalog after successful readResource when catalog="error"', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('test-pkg');

    const client = createMockClient({
      readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'test://r', text: 'data' }] }),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
    });

    await handleReadResource({ uri: 'test://r' }, registry, catalog);

    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');
  });

  it('does NOT clear catalog when readResource fails', async () => {
    const catalog = createMockCatalog({ 'test-pkg': 'error' });
    (catalog.getPackageForResourceUri as ReturnType<typeof vi.fn>).mockReturnValue('test-pkg');

    const client = createMockClient({
      readResource: vi.fn().mockRejectedValue(new Error('upstream failure')),
    });
    const registry = createMockRegistry({
      getClient: vi.fn().mockResolvedValue(client),
    });

    await expect(
      handleReadResource({ uri: 'test://r' }, registry, catalog),
    ).rejects.toMatchObject({ message: expect.stringContaining('upstream failure') });

    expect(catalog.clearPackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration-style: full flow from stale error to recovery
// ---------------------------------------------------------------------------

describe('Catalog-Registry sync: integration flow', () => {
  it('health_check clears stale catalog error so subsequent reads see fresh state', async () => {
    // Simulates: catalog has stale "error" → health_check returns "ok" → catalog cleared
    // → next ensurePackageLoaded triggers refresh (no stale cache blocking)
    let currentStatus = 'error';
    const catalog = {
      getPackageStatus: vi.fn(() => currentStatus),
      clearPackage: vi.fn(() => { currentStatus = 'unknown'; }),
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      countTools: vi.fn().mockReturnValue(5),
      buildPackageSummary: vi.fn().mockResolvedValue('summary'),
      etag: vi.fn().mockReturnValue('etag'),
      getPackageError: vi.fn().mockReturnValue(undefined),
      getPackageForResourceUri: vi.fn(),
      getKnownResourcePrefixes: vi.fn().mockReturnValue([]),
    } as unknown as Catalog;

    const registry = createMockRegistry({
      healthCheck: vi.fn().mockResolvedValue('ok'),
    });

    // Step 1: health_check returns "ok" → clears stale catalog
    await handleHealthCheckPackage({ package_id: 'test-pkg' }, registry, catalog);
    expect(catalog.clearPackage).toHaveBeenCalledWith('test-pkg');

    // Step 2: After clear, catalog status is no longer "error"
    expect(currentStatus).toBe('unknown');

    // Step 3: Next ensurePackageLoaded would trigger a fresh refresh
    // (catalog has no cached entry → calls refreshPackage)
    // Verify the catalog is in a state where it would re-fetch
    expect(catalog.getPackageStatus('test-pkg')).not.toBe('error');
  });
});
