import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PackageRegistry } from '../registry.js';
import type { McpClient, SuperMcpConfig, PackageConfig } from '../types.js';
import { StdioMcpClient } from '../clients/stdioClient.js';

// Suppress logger output during tests (mirrors registry-idle-reaping.test.ts).
vi.mock('../logging.js', () => ({
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
  // Inject packages directly (bypasses config normalization).
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

/**
 * A fake StdioMcpClient-shaped client. We want `client instanceof StdioMcpClient`
 * to hold (so the Part-B pre-send re-check fires) but without spawning a real
 * child. `Object.setPrototypeOf` re-tags a plain mock as a StdioMcpClient.
 */
function createFakeStdioClient(
  overrides: Partial<McpClient> & { isTransportClosed?: () => boolean } = {},
): McpClient & { isTransportClosed: () => boolean } {
  const base = {
    ...createMockClient(),
    // Default: transport reports alive so the pre-send re-establish does NOT fire.
    isTransportClosed: overrides.isTransportClosed ?? (() => false),
    ...overrides,
  };
  Object.setPrototypeOf(base, StdioMcpClient.prototype);
  return base as McpClient & { isTransportClosed: () => boolean };
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

/** A manually-resolvable deferred. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PackageRegistry Stage 6 reaper-race fix', () => {
  beforeEach(() => {
    delete process.env.SUPER_MCP_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaper skips a leased in-flight call (no -32000)', async () => {
    const pkg = stdioPackage('leased-pkg');
    const registry = createRegistry([pkg]);

    // callTool resolves only when we release the deferred — simulating an
    // in-flight request that outlives a reaper sweep.
    const callGate = deferred<{ content: unknown[] }>();
    const client = createFakeStdioClient({
      callTool: vi.fn().mockReturnValue(callGate.promise),
    });

    (registry as any).clients.set('leased-pkg', client);
    // Force the client to be reap-eligible by age.
    (registry as any).lastActivity.set('leased-pkg', Date.now() - 400_000);

    // Start the call but do NOT await yet — the lease is acquired synchronously.
    const callPromise = registry.callTool('leased-pkg', 'do_thing', {});

    // While the call is pending, run a sweep with the client well past idle.
    (registry as any).sweepIdleClients();

    // The lease must have prevented the reaper from closing the client.
    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('leased-pkg')).toBe(true);

    // Let the in-flight call finish; it resolves normally (no ConnectionClosed).
    callGate.resolve({ content: [] });
    await expect(callPromise).resolves.toEqual({ content: [] });

    // Lease released after the call completes.
    expect((registry as any).activeLeases.has('leased-pkg')).toBe(false);
  });

  it('re-establishes a stdio client whose transport closed BEFORE send', async () => {
    const pkg = stdioPackage('stale-pkg');
    const registry = createRegistry([pkg]);

    // First client: transport already closed before any bytes go out.
    const staleClient = createFakeStdioClient({
      isTransportClosed: () => true,
      callTool: vi.fn(), // must NOT be called — it is stale
    });
    (registry as any).clients.set('stale-pkg', staleClient);
    (registry as any).lastActivity.set('stale-pkg', Date.now());

    // Fresh client returned by re-establishment; its transport is alive.
    const freshClient = createFakeStdioClient({
      isTransportClosed: () => false,
      callTool: vi.fn().mockResolvedValue({ content: ['ok'] }),
    });
    const createSpy = vi
      .spyOn(registry as any, 'createAndConnectClient')
      .mockResolvedValue(freshClient);

    const result = await registry.callTool('stale-pkg', 'do_thing', {});

    // Stale client deleted, fresh one created and used.
    expect(staleClient.callTool).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(freshClient.callTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: ['ok'] });
    // No -32000 surfaced.

    // FIX 2: the re-establish observability counter incremented exactly once
    // for this package and is surfaced via getChildStats().
    const stats = registry.getChildStats().find((s) => s.package_id === 'stale-pkg');
    expect(stats?.reestablish_count).toBe(1);
  });

  it('does NOT retry when the transport closes MID-call (-32000 propagates once)', async () => {
    const pkg = stdioPackage('midcall-pkg');
    const registry = createRegistry([pkg]);

    // Transport reports alive at the pre-send check (bytes WILL be sent), then
    // callTool rejects with a ConnectionClosed / -32000 mid-flight.
    const connectionClosed = Object.assign(new Error('MCP error -32000: Connection closed'), {
      code: -32000,
    });
    const callTool = vi.fn().mockRejectedValue(connectionClosed);
    const client = createFakeStdioClient({
      isTransportClosed: () => false,
      callTool,
    });
    (registry as any).clients.set('midcall-pkg', client);
    (registry as any).lastActivity.set('midcall-pkg', Date.now());

    const createSpy = vi.spyOn(registry as any, 'createAndConnectClient');

    await expect(registry.callTool('midcall-pkg', 'do_thing', {})).rejects.toThrow(
      /-32000|Connection closed/,
    );

    // Called exactly once — NO auto-retry around the actual dispatch.
    expect(callTool).toHaveBeenCalledTimes(1);
    // No fresh client established for a mid-call close.
    expect(createSpy).not.toHaveBeenCalled();
    // Lease released even on throw.
    expect((registry as any).activeLeases.has('midcall-pkg')).toBe(false);
  });

  it('still respects hasPendingRequests (no lease, pending requests → reaper skips)', () => {
    const pkg = stdioPackage('pending-pkg');
    const registry = createRegistry([pkg]);
    const client = createFakeStdioClient({
      hasPendingRequests: vi.fn().mockReturnValue(true),
    });

    (registry as any).clients.set('pending-pkg', client);
    (registry as any).lastActivity.set('pending-pkg', Date.now() - 400_000);
    // No active lease held.
    expect((registry as any).activeLeases.has('pending-pkg')).toBe(false);

    (registry as any).sweepIdleClients();

    expect(client.close).not.toHaveBeenCalled();
    expect((registry as any).clients.has('pending-pkg')).toBe(true);
  });
});
