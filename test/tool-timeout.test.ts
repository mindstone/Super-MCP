import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import type { PackageConfig } from '../src/types.js';

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
      { name: 'write_note', arguments: { text: 'hello' } },
      undefined,
      { timeout: expected, resetTimeoutOnProgress: true },
    );
  });
});
