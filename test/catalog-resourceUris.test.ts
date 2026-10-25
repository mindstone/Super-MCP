import { describe, it, expect, vi } from 'vitest';
import { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import type { PackageConfig } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Create a minimal mock PackageRegistry for Catalog construction. */
function createMockRegistry(): PackageRegistry {
  const defaultPkg: PackageConfig = {
    id: 'test-pkg',
    name: 'Test Package',
    transport: 'http',
    base_url: 'http://localhost:3000',
    visibility: 'default',
  };
  return {
    getClient: vi.fn(),
    getPackage: vi.fn().mockReturnValue(defaultPkg),
    setupBlockReason: vi.fn().mockReturnValue(undefined),
    getPackages: vi.fn().mockReturnValue([defaultPkg]),
    healthCheck: vi.fn(),
    restartPackage: vi.fn(),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// registerResourceUris / getPackageForResourceUri
// ---------------------------------------------------------------------------

describe('Catalog resource URI mapping', () => {
  it('registerResourceUris maps tool URI to package', () => {
    const catalog = new Catalog(createMockRegistry());

    catalog.registerResourceUris('my-pkg', [
      { name: 'dashboard', _meta: { ui: { resourceUri: 'ui://my-app/dashboard' } } },
    ]);

    expect(catalog.getPackageForResourceUri('ui://my-app/dashboard')).toBe('my-pkg');
  });

  it('registerResourceUris ignores tools without _meta.ui.resourceUri', () => {
    const catalog = new Catalog(createMockRegistry());

    catalog.registerResourceUris('my-pkg', [
      { name: 'plain-tool' },
      { name: 'meta-but-no-ui', _meta: { other: 'data' } },
      { name: 'ui-but-no-uri', _meta: { ui: {} } },
    ]);

    expect(catalog.getKnownResourcePrefixes()).toEqual([]);
  });

  it('clearResourceUrisForPackage removes only that package mappings', () => {
    const catalog = new Catalog(createMockRegistry());

    catalog.registerResourceUris('pkg-a', [
      { name: 'tool-a', _meta: { ui: { resourceUri: 'ui://app-a/page' } } },
    ]);
    catalog.registerResourceUris('pkg-b', [
      { name: 'tool-b', _meta: { ui: { resourceUri: 'ui://app-b/page' } } },
    ]);

    // Both should resolve before clearing
    expect(catalog.getPackageForResourceUri('ui://app-a/page')).toBe('pkg-a');
    expect(catalog.getPackageForResourceUri('ui://app-b/page')).toBe('pkg-b');

    catalog.clearResourceUrisForPackage('pkg-a');

    // pkg-a should be gone, pkg-b should remain
    expect(catalog.getPackageForResourceUri('ui://app-a/page')).toBeUndefined();
    expect(catalog.getPackageForResourceUri('ui://app-b/page')).toBe('pkg-b');
  });

  it('getKnownResourcePrefixes returns all registered prefixes', () => {
    const catalog = new Catalog(createMockRegistry());

    catalog.registerResourceUris('pkg-a', [
      { name: 'tool-a', _meta: { ui: { resourceUri: 'ui://app-a/page' } } },
    ]);
    catalog.registerResourceUris('pkg-b', [
      { name: 'tool-b', _meta: { ui: { resourceUri: 'ui://app-b/dashboard' } } },
    ]);

    const prefixes = catalog.getKnownResourcePrefixes();
    expect(prefixes).toContain('ui://app-a');
    expect(prefixes).toContain('ui://app-b');
    expect(prefixes).toHaveLength(2);
  });
});
