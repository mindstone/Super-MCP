import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import type { McpClient, SuperMcpConfig, PackageConfig } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Create a minimal PackageRegistry with the given packages pre-configured. */
function createRegistry(packages: PackageConfig[]): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  const registry = new PackageRegistry(config);
  // Inject packages directly (bypasses config normalization)
  (registry as any).packages = packages;
  return registry;
}

/** Create a mock McpClient with optional overrides. */
function createMockClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    hasPendingRequests: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** A stdio package config for testing. */
function stdioPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'node',
    args: ['mock-server.js'],
    visibility: 'default',
  };
}

/** An HTTP package config for testing. */
function httpPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: 'http',
    base_url: 'http://localhost:3000',
    visibility: 'default',
  };
}

describe('PackageRegistry idle reaping', () => {
  const originalEnv = process.env.SUPER_MCP_IDLE_TIMEOUT_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.SUPER_MCP_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.SUPER_MCP_IDLE_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.SUPER_MCP_IDLE_TIMEOUT_MS;
    }
  });

  it('reaps idle stdio clients after timeout', () => {
    const pkg = stdioPackage('test-stdio');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    // Inject mock client and set activity in the distant past
    (registry as any).clients.set('test-stdio', client);
    (registry as any).lastActivity.set('test-stdio', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000); // One sweep cycle

    expect(client.close).toHaveBeenCalledOnce();
    expect((registry as any).clients.has('test-stdio')).toBe(false);
    expect((registry as any).lastActivity.has('test-stdio')).toBe(false);

    registry.stopIdleReaper();
  });

  it('does NOT reap recently-active clients', () => {
    const pkg = stdioPackage('active-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    (registry as any).clients.set('active-pkg', client);
    (registry as any).lastActivity.set('active-pkg', Date.now() - 30_000); // 30s ago

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('active-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('does NOT reap clients with in-flight requests', () => {
    const pkg = stdioPackage('busy-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient({
      hasPendingRequests: vi.fn().mockReturnValue(true),
    });

    (registry as any).clients.set('busy-pkg', client);
    (registry as any).lastActivity.set('busy-pkg', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('busy-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('does NOT reap clients that hold live state', () => {
    const pkg = stdioPackage('browser-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient({
      holdsLiveState: vi.fn().mockReturnValue(true),
    });

    (registry as any).clients.set('browser-pkg', client);
    (registry as any).lastActivity.set('browser-pkg', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('browser-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('does NOT reap clients with queued requests (size > 0, pending === 0)', () => {
    // hasPendingRequests checks both pending > 0 || size > 0
    // Simulating the "queued but not running" case means hasPendingRequests returns true
    const pkg = stdioPackage('queued-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient({
      hasPendingRequests: vi.fn().mockReturnValue(true),
    });

    (registry as any).clients.set('queued-pkg', client);
    (registry as any).lastActivity.set('queued-pkg', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('queued-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('never reaps HTTP clients', () => {
    const pkg = httpPackage('http-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    (registry as any).clients.set('http-pkg', client);
    (registry as any).lastActivity.set('http-pkg', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('http-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('skips clients with pending clientPromises', () => {
    const pkg = stdioPackage('connecting-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    (registry as any).clients.set('connecting-pkg', client);
    (registry as any).lastActivity.set('connecting-pkg', Date.now() - 400_000);
    // Simulate a connection in progress
    (registry as any).clientPromises.set(
      'connecting-pkg',
      Promise.resolve(client),
    );

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('connecting-pkg')).toBe(true);

    registry.stopIdleReaper();
  });

  it('getClient() reconnects after reaping by creating a new client', async () => {
    const pkg = stdioPackage('reap-reconnect');
    const registry = createRegistry([pkg]);
    const oldClient = createMockClient();

    (registry as any).clients.set('reap-reconnect', oldClient);
    (registry as any).lastActivity.set('reap-reconnect', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    // Client should be reaped
    expect(oldClient.close).toHaveBeenCalledOnce();
    expect((registry as any).clients.has('reap-reconnect')).toBe(false);

    // After reaping, getClient() should trigger new creation.
    // We mock createAndConnectClient to return a fresh mock.
    const newClient = createMockClient();
    vi.spyOn(registry as any, 'createAndConnectClient').mockResolvedValue(
      newClient,
    );

    const result = await registry.getClient('reap-reconnect');
    expect(result).toBe(newClient);
    expect((registry as any).clients.has('reap-reconnect')).toBe(true);

    registry.stopIdleReaper();
  });

  it('SUPER_MCP_IDLE_TIMEOUT_MS=0 disables reaping', () => {
    process.env.SUPER_MCP_IDLE_TIMEOUT_MS = '0';

    const pkg = stdioPackage('disabled-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    (registry as any).clients.set('disabled-pkg', client);
    (registry as any).lastActivity.set('disabled-pkg', Date.now() - 400_000);

    registry.startIdleReaper();

    // No interval should be created
    expect((registry as any).reaperInterval).toBeNull();

    vi.advanceTimersByTime(120_000); // Two sweep cycles

    expect(client.close).not.toHaveBeenCalled();
  });

  it('startIdleReaper() is idempotent', () => {
    const registry = createRegistry([]);

    registry.startIdleReaper();
    const firstInterval = (registry as any).reaperInterval;
    expect(firstInterval).not.toBeNull();

    registry.startIdleReaper();
    const secondInterval = (registry as any).reaperInterval;

    // Same interval reference — no duplicate
    expect(secondInterval).toBe(firstInterval);

    registry.stopIdleReaper();
  });

  it('still removes client from maps when close() throws during reap', () => {
    const pkg = stdioPackage('fail-close-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient({
      close: vi.fn().mockRejectedValue(new Error('close failed')),
    });

    (registry as any).clients.set('fail-close-pkg', client);
    (registry as any).lastActivity.set('fail-close-pkg', Date.now() - 400_000);

    registry.startIdleReaper();
    vi.advanceTimersByTime(60_000);

    // Client should still be removed from maps even though close() failed
    expect(client.close).toHaveBeenCalledOnce();
    expect((registry as any).clients.has('fail-close-pkg')).toBe(false);
    expect((registry as any).lastActivity.has('fail-close-pkg')).toBe(false);

    registry.stopIdleReaper();
  });

  it('falls back to default timeout for invalid SUPER_MCP_IDLE_TIMEOUT_MS', () => {
    process.env.SUPER_MCP_IDLE_TIMEOUT_MS = 'not-a-number';

    const registry = createRegistry([]);
    registry.startIdleReaper();

    // Should use default timeout (300_000ms), not crash
    expect((registry as any).reaperInterval).not.toBeNull();
    expect((registry as any).reaperTimeoutMs).toBe(300_000);

    registry.stopIdleReaper();
  });

  it('closeAll() stops the reaper and clears lastActivity', async () => {
    const pkg = stdioPackage('cleanup-pkg');
    const registry = createRegistry([pkg]);
    const client = createMockClient();

    (registry as any).clients.set('cleanup-pkg', client);
    (registry as any).lastActivity.set('cleanup-pkg', Date.now());

    registry.startIdleReaper();
    expect((registry as any).reaperInterval).not.toBeNull();

    await registry.closeAll();

    expect((registry as any).reaperInterval).toBeNull();
    expect((registry as any).lastActivity.size).toBe(0);
    expect((registry as any).clients.size).toBe(0);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
