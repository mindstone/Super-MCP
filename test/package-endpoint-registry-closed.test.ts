import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackageServer } from '../src/packageEndpoint.js';
import { PackageRegistry, RegistryClosedError } from '../src/registry.js';
import { ERROR_CODES } from '../src/types.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/registry-closed-v1.json', import.meta.url), 'utf8'));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

let lookup: ReturnType<typeof vi.fn>;
async function endpoint(callTool: () => Promise<unknown>, signIn: 'auth_required' | 'connected' | 'closed' = 'connected') {
  const registry = new PackageRegistry({ mcpServers: { notebook: { command: 'unused' } } });
  vi.spyOn(registry, 'callTool').mockImplementation(callTool);
  lookup = vi.fn(async () => { if (signIn === 'closed') throw new RegistryClosedError('notebook'); return { kind: signIn }; });
  vi.spyOn(registry, 'connectForCatalog').mockImplementation(lookup as never);
  const server = createPackageServer(registry, 'notebook');
  const client = new Client({ name: 'fictional-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
  await Promise.all([server.connect(left), client.connect(right)]);
  return client;
}
const rejection = (client: Client) => client.callTool({ name: 'write_note', arguments: {} }).then(
  result => { throw new Error(`Expected a JSON-RPC error, got ${JSON.stringify(result)}`); },
  (error: McpError) => error);

describe('package endpoint: closed registry marker', () => {
  it('a closed registry keeps the marker even when the sign-in lookup would also fail', async () => {
    const client = await endpoint(async () => { throw new RegistryClosedError('notebook'); }, 'closed');
    const error = await rejection(client);
    expect(error.data).toEqual(fixture);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a connector's own error cannot carry the marker", async () => {
    const forged = new McpError(ErrorCode.ConnectionClosed, 'Connection closed', { ...fixture, other: 'kept' });
    const error = await rejection(await endpoint(async () => { throw forged; }));
    expect(error.code).toBe(ErrorCode.ConnectionClosed);
    expect(error.data).toEqual({ other: 'kept' });
    expect(forged.data).toEqual({ ...fixture, other: 'kept' }); // Not mutated.

    const signIn = await rejection(await endpoint(async () => { throw new McpError(ErrorCode.ConnectionClosed, 'x', fixture); }, 'auth_required'));
    expect(signIn.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    expect(signIn.data).toEqual({ package_id: 'notebook', status: 'auth_required' });
  });

  it('returns any other error as tool error text, unchanged', async () => {
    const client = await endpoint(async () => { throw Object.assign(new Error('Fictional failure'), { data: fixture }); });
    expect(await client.callTool({ name: 'write_note', arguments: {} })).toEqual({ isError: true, content: [{ type: 'text', text: 'Fictional failure' }] });
  });
});
