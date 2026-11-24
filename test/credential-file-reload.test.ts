import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { PackageRegistry } from '../src/registry.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

it('a warmed HTTP connector uses the changed client registration after restartPackage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'client-file-reload-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  vi.stubEnv('SUPER_MCP_OAUTH_TOKEN_DIR', dir);
  const seen: Array<string | null> = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const json = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url?.includes('oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url?.includes('.well-known')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] });
    if (req.url === '/token') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push(new URLSearchParams(body).get('client_id'));
        json({ access_token: 'fictional-current-access', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600 });
      });
      return;
    }
    if (req.headers.authorization !== 'Bearer fictional-current-access') {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      res.end(); return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fictional', version: '1' } }
        : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'called' }] } : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
      json({ jsonrpc: '2.0', id: message.id, result });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture could not listen');
  base = `http://127.0.0.1:${address.port}`;
  const clientFile = path.join(dir, 'notebook_client.json');
  const tokenFile = path.join(dir, 'notebook_tokens.json');
  const registration = (client_id: string) => JSON.stringify({ client_id, token_endpoint_auth_method: 'none', issuer: base, redirect_uris: ['http://localhost:5173/oauth/callback'] });
  const expiredTokens = JSON.stringify({ access_token: 'fictional-expired-access', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 0, __superMcpObtainedAtMs: 0, issuer: base });
  await fs.writeFile(clientFile, registration('fictional-old-client'));
  await fs.writeFile(tokenFile, expiredTokens);
  const registry = new PackageRegistry({ mcpServers: { notebook: { url: `${base}/mcp`, oauth: true } } });
  cleanup.push(() => registry.closeAll());
  await registry.callTool('notebook', 'read', {}, { kind: 'standalone' });
  expect(seen).toEqual(['fictional-old-client']);
  await fs.writeFile(clientFile, registration('fictional-new-client'));
  await fs.writeFile(tokenFile, expiredTokens);
  expect(await registry.restartPackage('notebook')).toMatchObject({ success: true });
  await registry.callTool('notebook', 'read', {}, { kind: 'standalone' });
  expect(seen).toEqual(['fictional-old-client', 'fictional-new-client']);
}, 15_000);

it('restartPackage replaces a bundled-style process that cached its credential file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-file-reload-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credential.json');
  await fs.writeFile(file, JSON.stringify({ value: 'fictional-old' }));
  const fixture = fileURLToPath(new URL('./fixtures/cached-credential-mcp-server.mjs', import.meta.url));
  const registry = new PackageRegistry({ mcpServers: { notebook: { command: process.execPath, args: [fixture, file] } } });
  cleanup.push(() => registry.closeAll());
  const read = async () => {
    const result = await registry.callTool('notebook', 'read', {}, { kind: 'standalone' });
    return JSON.parse(result.content[0].text) as { value: string; pid: number };
  };
  const old = await read();
  expect(old.value).toBe('fictional-old');
  await fs.writeFile(file, JSON.stringify({ value: 'fictional-new' }));
  expect(await read()).toEqual(old);
  expect(await registry.restartPackage('notebook')).toMatchObject({ success: true });
  const next = await read();
  expect(next.value).toBe('fictional-new');
  expect(next.pid).not.toBe(old.pid);
}, 15_000);
