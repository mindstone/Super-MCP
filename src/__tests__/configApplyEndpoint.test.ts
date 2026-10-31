import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackageRegistry } from '../registry.js';
import type { Catalog } from '../catalog.js';
import { registerHttpApiRoutes } from '../server.js';

const { logger, setPolicy } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn() },
  setPolicy: vi.fn(),
}));
vi.mock('../logging.js', () => ({ getLogger: () => logger }));
vi.mock('../security.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../security.js')>(),
  setSecurityPolicy: setPolicy,
}));

describe('POST /api/config/apply', () => {
  let dir: string;
  let configPath: string;
  const apply = vi.fn();
  const changed = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    apply.mockReset().mockResolvedValue({ status: 'ok', added: ['Beta'], needsReload: [
      { packageId: 'Alpha', reason: 'removed' }, { reason: 'config_files_changed' },
    ] });
    changed.mockReset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-mcp-apply-endpoint-'));
    configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{}');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  function register(options: { noPaths?: boolean; noRefresher?: boolean } = {}) {
    let handlers: express.RequestHandler[] = [];
    const app = {
      get: vi.fn(),
      post: vi.fn((route: string, ...registered: express.RequestHandler[]) => {
        if (route === '/api/config/apply') handlers = registered;
      }),
    } as unknown as express.Express;
    registerHttpApiRoutes(app, {
      registry: { applyConfigFromFiles: apply } as unknown as PackageRegistry,
      catalog: {} as Catalog,
      configPaths: options.noPaths ? undefined : [configPath],
      catalogRefresher: options.noRefresher ? undefined : {
        configurationChanged: changed, scheduleRefresh: vi.fn(), whenCurrentGenerationReady: vi.fn(),
      },
      dnsRebindingGuard: (req, res, next) => {
        if (req.headers.host !== 'localhost') { res.status(403).json({ status: 'failed' }); return; }
        next();
      },
    });
    expect(handlers).toHaveLength(2);
    return async (headers: Record<string, string> = { host: 'localhost' }) => {
      let status = 200;
      let body: unknown;
      const response = {
        status: (value: number) => { status = value; return response; },
        json: (value: unknown) => { body = value; return response; },
      } as unknown as express.Response;
      const request = { headers } as express.Request;
      let route: unknown;
      handlers[0](request, response, () => { route = handlers[1](request, response, vi.fn()); });
      await route;
      return { status, body };
    };
  }

  it('returns the wire shape and notifies the catalog once after applying under the new policy', async () => {
    const order: string[] = [];
    setPolicy.mockImplementationOnce(() => { order.push('security'); });
    apply.mockImplementationOnce(async () => { order.push('apply'); return { status: 'ok', added: ['Beta'], needsReload: [{ packageId: 'Alpha', reason: 'env_changed' }, { reason: 'config_files_changed' }] }; });
    changed.mockImplementationOnce(() => { order.push('catalog'); });
    expect(await register()()).toEqual({ status: 200, body: {
      status: 'ok', added: ['Beta'], needs_reload: [{ package_id: 'Alpha', reason: 'env_changed' }, { reason: 'config_files_changed' }],
    } });
    expect(order).toEqual(['security', 'apply', 'catalog']);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([configPath]);
  });

  it.each(['https://example.com', 'null', ''])('rejects Origin %j', async (origin) => {
    expect((await register()({ host: 'localhost', origin })).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it('uses the DNS rebinding guard', async () => {
    expect((await register()({ host: 'example.com' })).status).toBe(403);
    expect(setPolicy).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([{ noPaths: true }, { noRefresher: true }])('returns 404 when unavailable: %j', async (options) => {
    expect(await register(options)()).toEqual({ status: 404, body: { status: 'failed' } });
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails without admitting packages when security cannot reload', async () => {
    await fs.writeFile(configPath, '{"private-parser-content');
    expect(await register()()).toEqual({ status: 200, body: { status: 'failed' } });
    expect(apply).not.toHaveBeenCalled();
    expect(setPolicy).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-parser-content');
  });

  it('notifies once even when apply fails', async () => {
    apply.mockResolvedValueOnce({ status: 'failed' });
    expect(await register()()).toEqual({ status: 200, body: { status: 'failed' } });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('converts an apply throw to failed without logging its content', async () => {
    apply.mockRejectedValueOnce(new Error('private-error-content'));
    expect(await register()()).toEqual({ status: 200, body: { status: 'failed' } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-error-content');
  });

  it('returns 500 for an unexpected error without logging content', async () => {
    changed.mockImplementationOnce(() => { throw new Error('private-unexpected-content'); });
    expect(await register()()).toEqual({ status: 500, body: { status: 'failed' } });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-unexpected-content');
  });

  it('notifies once for each POST', async () => {
    const post = register();
    await post();
    expect(changed).toHaveBeenCalledTimes(1);
    await post();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
