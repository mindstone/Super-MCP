import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { SimpleOAuthProvider } from '../src/auth/providers/simple.js';
import type { PackageConfig } from '../src/types.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const origin = 'https://mcp.example.com';
const config: PackageConfig = {
  id: 'tarrowline-wiki', name: 'tarrowline-wiki', transport: 'http',
  base_url: `${origin}/mcp`, visibility: 'default',
};

class NoBrowserOAuthProvider extends SimpleOAuthProvider {
  redirect = vi.fn();
  async redirectToAuthorization(url: URL): Promise<void> {
    this.redirect(url);
    this.redirectStarted = true;
  }
}

describe('flagless HTTP OAuth', () => {
  let tokenDir: string;
  let previousTokenDir: string | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    previousTokenDir = process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flagless-oauth-'));
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (previousTokenDir === undefined) delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
    else process.env.SUPER_MCP_OAUTH_TOKEN_DIR = previousTokenDir;
    await fs.rm(tokenDir, { recursive: true, force: true });
  });

  it('reaches authorization redirect after a flagless 401 using the installed SDK', async () => {
    const provider = new NoBrowserOAuthProvider(config.id, 5199);
    await provider.initialize();
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${origin}/mcp`) {
        return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      }
      if (url === `${origin}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: origin, authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${origin}/register`) return Response.json({ client_id: 'fictional-client', redirect_uris: ['http://localhost:5199/oauth/callback'] }, { status: 201 });
      return new Response(null, { status: 404 });
    });
    const client = new HttpMcpClient(config.id, config, { oauthProvider: provider });
    try {
      await client.connectWithOAuth();
      expect(provider.redirect, 'flagless 401 must reach redirectToAuthorization').toHaveBeenCalledOnce();
      expect(provider.hasStartedRedirect()).toBe(true);
    } finally {
      await client.close();
    }
  });
  it('reuses saved tokens on ordinary flagless connections, including a fresh client', async () => {
    const provider = new SimpleOAuthProvider(config.id, 5199);
    await provider.initialize();
    await provider.saveTokens({ access_token: 'fictional-token', token_type: 'Bearer', expires_in: 3600 });
    const authorization: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (body?.method === 'initialize') {
        authorization.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fictional', version: '1' },
        } });
      }
      return new Response(null, { status: init?.method === 'POST' ? 202 : 405 });
    });
    for (let i = 0; i < 2; i++) {
      const client = new HttpMcpClient(config.id, config);
      try { await client.connect(); } finally { await client.close(); }
    }
    expect(authorization).toEqual(['Bearer fictional-token', 'Bearer fictional-token']);
  });

  it.each([undefined, false])('ordinary discovery never redirects with oauth=%s', async (oauth) => {
    const redirect = vi.spyOn(SimpleOAuthProvider.prototype, 'redirectToAuthorization');
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    const client = new HttpMcpClient(config.id, { ...config, oauth });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(redirect).not.toHaveBeenCalled();
    } finally { await client.close(); redirect.mockRestore(); }
  });

  it('runtime oauth=false prevents explicit provider initialization', async () => {
    const provider = new NoBrowserOAuthProvider(config.id, 5199);
    await provider.initialize();
    const tokens = vi.spyOn(provider, 'tokens');
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    const client = new HttpMcpClient(config.id, { ...config, oauth: false }, { oauthProvider: provider });
    try {
      await client.connectWithOAuth();
      expect(tokens).not.toHaveBeenCalled();
      expect(provider.redirect).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

});
