import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import type { PackageConfig } from '../src/types.js';
import { PackageRegistry } from '../src/registry.js';
import { preflightLocalTool } from '../src/fileReadPreflight.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../src/logging.js', () => ({ getLogger: () => logger }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('per-call tool timeout', () => {
  it.each([
    { env: undefined, configured: undefined, expected: 90 * 60 * 1000, label: 'defaults to 90 minutes without an env override' },
    { env: '', configured: undefined, expected: 90 * 60 * 1000, label: 'defaults to 90 minutes with an empty env override' },
    { env: '123456', configured: undefined, expected: 123456, label: 'uses the env override when present' },
    { env: '123456', configured: 654321, expected: 654321, label: 'prefers config.timeout over the env override' },
    { env: '123456', configured: 0, expected: 123456, label: 'retains the default semantics for a zero configured timeout' },
  ])('$label', async ({ env, configured, expected }) => {
    vi.stubEnv('SUPER_MCP_TOOL_TIMEOUT', env);
    const callTool = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
    const config: PackageConfig = {
      id: 'fictional-notes',
      name: 'Fictional Notes',
      transport: 'stdio',
      visibility: 'default',
      timeout: configured,
    };
    const client = new StdioMcpClient(config.id, config);

    await client.callTool('write_note', { text: 'hello' });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      { name: 'write_note', arguments: { text: 'hello' }, _meta: { 'files/readMode': { version: 1, mode: 'standalone' } } },
      undefined,
      { timeout: expected, resetTimeoutOnProgress: true },
    );

    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads: [{ location: ['file'], rawPath: '/source', canonicalPath: '/physical' }] });
    vi.spyOn(client, 'getToolMetadata').mockResolvedValue({ 'files/readInputs': { version: 1, inputs: [{ selector: ['file'], base: 'connectorCwd', expandTilde: false }] } });
    await preflightLocalTool(client, config, 'upload', { file: '/source' }, {
      kind: 'origin', authority: { version: 1 }, metadata: { 'files/invocation': { version: 1, invocationId: 'active' } },
      signal: new AbortController().signal, sendRequest,
    });
    expect(sendRequest).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.objectContaining({ timeout: expected }));
  });

  it('retains the configured timeout through initial normalization and restart', async () => {
    const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused', timeout: 25 } } });
    try {
      expect(registry.getPackage('fixture')?.timeout).toBe(25);
      await registry.restartPackage('fixture');
      expect(registry.getPackage('fixture')?.timeout).toBe(25);
    } finally { await registry.closeAll(); }
  });
});
