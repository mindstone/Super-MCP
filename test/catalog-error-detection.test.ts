import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import type { PackageConfig, McpClient } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Create a minimal mock McpClient whose connect/listTools reject with the given error. */
function createFailingClient(error: Error): McpClient {
  return {
    connect: vi.fn().mockRejectedValue(error),
    listTools: vi.fn().mockRejectedValue(error),
    callTool: vi.fn().mockRejectedValue(error),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue('error'),
    requiresAuth: vi.fn().mockResolvedValue(false),
    isAuthenticated: vi.fn().mockResolvedValue(false),
    readResource: vi.fn().mockRejectedValue(error),
    hasPendingRequests: vi.fn().mockReturnValue(false),
  } as unknown as McpClient;
}

/** Create a mock PackageRegistry that returns the given package config and throws the given error from getClient. */
function createMockRegistry(pkg: PackageConfig | undefined, clientError: Error): PackageRegistry {
  return {
    getClient: vi.fn().mockRejectedValue(clientError),
    getPackage: vi.fn().mockReturnValue(pkg),
    isSetupBlocked: vi.fn().mockReturnValue(false),
    getPackages: vi.fn().mockReturnValue(pkg ? [pkg] : []),
    healthCheck: vi.fn().mockResolvedValue('error'),
    restartPackage: vi.fn().mockResolvedValue({ success: false, message: 'not running' }),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// Connection-refused error detection on localhost URLs
// ---------------------------------------------------------------------------

describe('Catalog error detection: localhost ECONNREFUSED', () => {
  const localhostPkg: PackageConfig = {
    id: 'beeper',
    name: 'Beeper',
    transport: 'http',
    base_url: 'http://localhost:23373/v0/mcp',
    visibility: 'default',
  };

  const localhost127Pkg: PackageConfig = {
    id: 'figma-desktop',
    name: 'Figma (Desktop)',
    transport: 'http',
    base_url: 'http://127.0.0.1:3845/mcp',
    visibility: 'default',
  };

  const remotePkg: PackageConfig = {
    id: 'remote-service',
    name: 'Remote Service',
    transport: 'http',
    base_url: 'https://api.example.com/mcp',
    visibility: 'default',
  };

  it('returns friendly message for ECONNREFUSED on localhost URL', async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:23373');
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toBe(
      "Beeper isn't running. Open Beeper on your computer and try again."
    );
  });

  it('returns friendly message for ECONNREFUSED on 127.0.0.1 URL', async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3845');
    const registry = createMockRegistry(localhost127Pkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('figma-desktop');

    expect(catalog.getPackageStatus('figma-desktop')).toBe('error');
    expect(catalog.getPackageError('figma-desktop')).toBe(
      "Figma (Desktop) isn't running. Open Figma (Desktop) on your computer and try again."
    );
  });

  it('returns generic error for ECONNREFUSED on non-localhost URL', async () => {
    const error = new Error('connect ECONNREFUSED 93.184.216.34:443');
    const registry = createMockRegistry(remotePkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('remote-service');

    expect(catalog.getPackageStatus('remote-service')).toBe('error');
    // Should contain the raw error message, not the friendly one
    expect(catalog.getPackageError('remote-service')).toContain('ECONNREFUSED');
    expect(catalog.getPackageError('remote-service')).not.toContain("isn't running");
  });

  it('returns generic error for non-ECONNREFUSED error on localhost URL', async () => {
    const error = new Error('Request timeout after 30000ms');
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toContain('timeout');
    expect(catalog.getPackageError('beeper')).not.toContain("isn't running");
  });

  it('returns auth_required for auth errors on localhost URL (auth takes precedence)', async () => {
    const error = new Error('401 Unauthorized');
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('auth_required');
    expect(catalog.getPackageError('beeper')).toBeUndefined();
  });

  it('detects TypeError("fetch failed") with .cause containing ECONNREFUSED', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:23373');
    const error = new TypeError('fetch failed');
    (error as any).cause = cause;
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toBe(
      "Beeper isn't running. Open Beeper on your computer and try again."
    );
  });

  it('detects error with .cause.code === "ECONNREFUSED"', async () => {
    const cause = new Error('some socket error');
    (cause as any).code = 'ECONNREFUSED';
    const error = new TypeError('fetch failed');
    (error as any).cause = cause;
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toBe(
      "Beeper isn't running. Open Beeper on your computer and try again."
    );
  });

  it('uses generic fallback message when package name is empty', async () => {
    const noNamePkg: PackageConfig = {
      id: 'unnamed-local',
      name: '',
      transport: 'http',
      base_url: 'http://localhost:9999/mcp',
      visibility: 'default',
    };
    const error = new Error('connect ECONNREFUSED 127.0.0.1:9999');
    const registry = createMockRegistry(noNamePkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('unnamed-local');

    expect(catalog.getPackageStatus('unnamed-local')).toBe('error');
    expect(catalog.getPackageError('unnamed-local')).toBe(
      "A local app isn't running. Check that the required app is open on your computer and try again."
    );
  });

  it('detects ECONNREFUSED through registry-wrapped errors (.originalError)', async () => {
    // The registry wraps connection errors: new Error(enhancedMessage) with .originalError = original
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:23373');
    const fetchError = new TypeError('fetch failed');
    (fetchError as any).cause = cause;
    // Simulate registry wrapper
    const wrappedError = new Error(
      "Failed to connect to MCP package 'beeper'.\nTransport: http\nURL: http://localhost:23373/v0/mcp\n\nOriginal error: fetch failed"
    );
    (wrappedError as any).originalError = fetchError;
    const registry = createMockRegistry(localhostPkg, wrappedError);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toBe(
      "Beeper isn't running. Open Beeper on your computer and try again."
    );
  });

  it('detects error with top-level .code === "ECONNREFUSED"', async () => {
    const error = new Error('some connection error');
    (error as any).code = 'ECONNREFUSED';
    const registry = createMockRegistry(localhostPkg, error);
    const catalog = new Catalog(registry);

    await catalog.refreshPackage('beeper');

    expect(catalog.getPackageStatus('beeper')).toBe('error');
    expect(catalog.getPackageError('beeper')).toBe(
      "Beeper isn't running. Open Beeper on your computer and try again."
    );
  });
});
