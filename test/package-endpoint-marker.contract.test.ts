import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackageServer } from '../src/packageEndpoint.js';
import { PackageRegistry } from '../src/registry.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/registry-closed-v1.json', import.meta.url), 'utf8'));
const tool = { name: 'write_note', inputSchema: { type: 'object' as const } };
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.spyOn(StdioMcpClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(StdioMcpClient.prototype, 'isTransportClosed').mockReturnValue(false);
  vi.spyOn(StdioMcpClient.prototype, 'healthCheck').mockResolvedValue('ok');
  vi.spyOn(StdioMcpClient.prototype, 'listTools').mockResolvedValue([tool]);
  vi.spyOn(StdioMcpClient.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
  vi.spyOn(StdioMcpClient.prototype, 'listResources').mockResolvedValue({ resources: [] });
  vi.spyOn(StdioMcpClient.prototype, 'readResource').mockResolvedValue({ contents: [] });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function endpoint(entry: Record<string, unknown> = { command: '/must-never-run' }) {
  const registry = new PackageRegistry({ mcpServers: { notebook: entry } } as never);
  const server = createPackageServer(registry, 'notebook');
  const client = new Client({ name: 'fictional-contract', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  cleanup.push(() => registry.closeAll(), () => server.close(), () => client.close());
  await Promise.all([server.connect(left), client.connect(right)]);
  return { registry, client };
}
async function rejection(pending: Promise<unknown>): Promise<McpError> {
  return pending.then(result => { throw new Error(`Expected JSON-RPC rejection, got ${JSON.stringify(result)}`); }, error => {
    expect(error).toBeInstanceOf(McpError);
    return error;
  });
}
const call = (client: Client) => client.callTool({ name: 'write_note', arguments: {} });

describe('package-endpoint marker provenance contract', () => {
  it('the endpoint declares the marker guard', async () => {
    const stdio = (await endpoint()).client.getServerCapabilities()?.experimental;
    expect(stdio).toEqual({ 'rebel/homeMarkerGuard': { version: 1 }, 'files/forwardedInputs': { version: 1 } });
    const remote = (await endpoint({ url: 'https://notes.example.test/mcp' })).client.getServerCapabilities()?.experimental;
    expect(remote).toEqual({ 'rebel/homeMarkerGuard': { version: 1 } });
  });

  it('carries a real closed-registry refusal through the client without reaching the connector', async () => {
    const { registry, client } = await endpoint();
    await registry.closeAll();
    const error = await rejection(call(client));
    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.data).toEqual(fixture);
    expect(error.message).toContain("MCP package registry is closed; cannot admit 'notebook'");
    expect(StdioMcpClient.prototype.callTool).not.toHaveBeenCalled();
    expect(StdioMcpClient.prototype.connect).not.toHaveBeenCalled();
  });

  it('strips connector-supplied markers from discovery and resource errors over the transport', async () => {
    const { registry, client } = await endpoint();
    const upstream = await registry.getClient('notebook');
    const operations = [
      { method: 'listTools' as const, request: () => client.listTools() },
      { method: 'listResources' as const, request: () => client.listResources() },
      { method: 'readResource' as const, request: () => client.readResource({ uri: 'ui://notebook/view' }) },
    ];
    const received: unknown[] = [];
    for (const { method, request } of operations) {
      for (const code of [ErrorCode.ConnectionClosed, ErrorCode.InvalidParams]) {
        const forged = new McpError(code, 'Fictional connector failure', { ...fixture, detail: 'preserved' });
        const spy = vi.spyOn(upstream, method).mockRejectedValueOnce(forged);
        const error = await rejection(request());
        expect(error.code).toBe(code);
        expect(error.message).toContain(forged.message);
        received.push(error.data);
        expect(forged.data).toEqual({ ...fixture, detail: 'preserved' });
        spy.mockRestore();
      }
    }
    expect(received).toEqual(Array.from({ length: 6 }, () => ({ detail: 'preserved' })));
  });

  it('strips the marker from a connector error that is not an McpError', async () => {
    const { registry, client } = await endpoint();
    const upstream = await registry.getClient('notebook');
    const operations = [
      { method: 'listTools' as const, request: () => client.listTools() },
      { method: 'listResources' as const, request: () => client.listResources() },
      { method: 'readResource' as const, request: () => client.readResource({ uri: 'ui://notebook/view' }) },
    ];
    for (const { method, request } of operations) {
      const forged = Object.assign(new Error('Fictional plain failure'), { code: -32050, data: { ...fixture, detail: 'preserved' } });
      const spy = vi.spyOn(upstream, method).mockRejectedValueOnce(forged);
      const error = await rejection(request());
      expect(error.code).toBe(-32050);
      expect(error.message).toContain(forged.message);
      expect(error.data).toEqual({ detail: 'preserved' });
      expect(forged.data).toEqual({ ...fixture, detail: 'preserved' });
      spy.mockRestore();
    }
  });

  it('preserves connection-closed data shapes and strips only the reserved key without mutating the source', async () => {
    const { client } = await endpoint();
    for (const data of [null, 'Fictional detail', ['first', { detail: 2 }], { ...fixture, detail: { attempt: 2 } }]) {
      const original = structuredClone(data);
      const forged = new McpError(ErrorCode.ConnectionClosed, 'Fictional connection closed', data);
      vi.mocked(StdioMcpClient.prototype.callTool).mockRejectedValueOnce(forged);
      const error = await rejection(call(client));
      expect(error.code).toBe(forged.code);
      // The SDK adds its own prefix at each hop, including before this stage.
      expect(error.message).toBe(`MCP error ${forged.code}: ${forged.message}`);
      expect(error.data).toEqual(data && !Array.isArray(data) && typeof data === 'object' ? { detail: { attempt: 2 } } : data);
      expect(forged.data).toEqual(original);
    }
  });

  it('keeps other error codes as tool errors and marker-bearing tool results as results', async () => {
    const { client } = await endpoint();
    const forged = new McpError(ErrorCode.InvalidParams, 'Fictional invalid input', fixture);
    vi.mocked(StdioMcpClient.prototype.callTool).mockRejectedValueOnce(forged);
    expect(await call(client)).toEqual({ isError: true, content: [{ type: 'text', text: forged.message }] });
    for (const isError of [false, true]) {
      const result = { isError, content: [{ type: 'text' as const, text: JSON.stringify(fixture) }], structuredContent: fixture };
      vi.mocked(StdioMcpClient.prototype.callTool).mockResolvedValueOnce(result);
      expect(await call(client)).toEqual(result);
    }
  });
});
