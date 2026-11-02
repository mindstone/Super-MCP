import { describe, expect, it, vi } from 'vitest';
import type express from 'express';
import { registerShutdownRoute } from '../server.js';

vi.mock('../logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn() }),
}));

function register(ownerId?: string) {
  let handlers: express.RequestHandler[] = [];
  const app = {
    post: vi.fn((route: string, ...registered: express.RequestHandler[]) => {
      if (route === '/api/shutdown') handlers = registered;
    }),
  } as unknown as express.Express;
  const shutdown = vi.fn();
  registerShutdownRoute(app, {
    ownerId,
    shutdown,
    dnsRebindingGuard: (req, res, next) => {
      if (req.headers.host !== 'localhost') {
        res.status(403).end();
        return;
      }
      next();
    },
  });
  expect(handlers).toHaveLength(2);
  const send = (headers: Record<string, string>) => {
    let status = 200;
    const res = {
      status: vi.fn((code: number) => {
        status = code;
        return res;
      }),
      end: vi.fn(),
    } as unknown as express.Response;
    const req = { headers } as express.Request;
    let passed = false;
    handlers[0](req, res, () => {
      passed = true;
    });
    if (passed) handlers[1](req, res, vi.fn());
    return status;
  };
  return { send, shutdown };
}

describe('POST /api/shutdown', () => {
  it('starts the clean shutdown for the owning host', () => {
    const { send, shutdown } = register('owner-1');
    expect(send({ host: 'localhost', 'x-super-mcp-owner-id': 'owner-1' })).toBe(202);
    expect(shutdown).toHaveBeenCalledWith('host_request');
  });

  it('refuses a request with a browser Origin', () => {
    const { send, shutdown } = register('owner-1');
    expect(send({ host: 'localhost', origin: 'https://example.com', 'x-super-mcp-owner-id': 'owner-1' })).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('refuses a different or missing owner id', () => {
    const { send, shutdown } = register('owner-1');
    expect(send({ host: 'localhost', 'x-super-mcp-owner-id': 'owner-2' })).toBe(403);
    expect(send({ host: 'localhost' })).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('refuses a non-local Host', () => {
    const { send, shutdown } = register('owner-1');
    expect(send({ host: 'evil.example', 'x-super-mcp-owner-id': 'owner-1' })).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('needs no owner id when the router was started without an owner', () => {
    const { send, shutdown } = register(undefined);
    expect(send({ host: 'localhost' })).toBe(202);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
