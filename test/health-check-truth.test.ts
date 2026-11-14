import { describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { handleHealthCheckPackage } from '../src/handlers/healthCheckPackage.js';
import { handleHealthCheckAll } from '../src/handlers/healthCheck.js';
import type { Catalog } from '../src/catalog.js';
import type { McpClient, PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}) }));

const pkg: PackageConfig = { id: 'tarrowline-wiki', name: 'tarrowline-wiki',
  transport: 'http', base_url: 'https://mcp.example.com/mcp', visibility: 'default' };
const catalog = { getPackageStatus: () => 'unknown', clearPackage: vi.fn() } as unknown as Catalog;
function registryFor(getClient: () => Promise<McpClient>): PackageRegistry {
  return {
    getClient, getPackages: () => [pkg], getPackage: () => pkg,
    healthCheckWithClient: PackageRegistry.prototype.healthCheckWithClient,
    healthCheck: PackageRegistry.prototype.healthCheck,
  } as unknown as PackageRegistry;
}
const parse = (result: any) => JSON.parse(result.content[0].text);

describe('health tools preserve observed sign-in challenges', () => {
  it.each([[false, 'single'], [true, 'single'], [false, 'all'], [true, 'all']] as const)('reports a flagless challenge with connected=%s through %s', async (connected, tool) => {
    const client = new HttpMcpClient(pkg.id, pkg);
    Reflect.set(client, 'isConnected', connected);
    vi.spyOn(client, 'listTools').mockRejectedValue(new Error('Unauthorized: HTTP 401'));
    const registry = registryFor(async () => client);
    if (tool === 'single') {
      const single = parse(await handleHealthCheckPackage({ package_id: pkg.id }, registry, catalog));
      expect(single).toMatchObject({ health: 'unavailable', needs_sign_in: true, detail: expect.stringContaining('last answered') });
      expect(single).not.toHaveProperty('error');
      expect(single).not.toHaveProperty('message');
    } else {
      const all = parse(await handleHealthCheckAll({}, registry, catalog));
      expect(all.packages[0]).toMatchObject({ status: 'unavailable', requires_auth: true, is_authenticated: false });
      expect(all.packages[0].suggested_actions).toEqual([`Run: authenticate(package_id: "${pkg.id}")`]);
      expect(all.packages[0].diagnostic).toContain('last answered');
      expect(all.summary).toMatchObject({ requiring_auth: 1, authenticated: 0, unavailable: 1 });
      expect(all.recommendations.join(' ')).toContain('authenticate');
    }
  });

  it('keeps fresh connection failures unavailable with detail and all-packages error status', async () => {
    const registry = registryFor(async () => { throw new Error('connect ECONNREFUSED'); });
    const single = parse(await handleHealthCheckPackage({ package_id: pkg.id }, registry, catalog));
    expect(single).toEqual({ package_id: pkg.id, health: 'unavailable', detail: 'connect ECONNREFUSED' });
    const all = parse(await handleHealthCheckAll({}, registry, catalog));
    expect(all.packages[0].status).toBe('error');
    expect(all.packages[0]).not.toHaveProperty('requires_auth');
  });

  it('retains the healthCheck-only test-registry fallback', async () => {
    const registry = { healthCheck: vi.fn(async () => 'ok') } as unknown as PackageRegistry;
    expect(parse(await handleHealthCheckPackage({ package_id: pkg.id }, registry, catalog)))
      .toEqual({ package_id: pkg.id, health: 'ok' });
  });
});
