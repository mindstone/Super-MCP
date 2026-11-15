import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { PackageRegistry } from '../src/registry.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { Validator } from '../src/validator.js';
import { ERROR_CODES } from '../src/types.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const tool = { name: 'send', inputSchema: { type: 'object', properties: {} } };
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function run(error: Error) {
  const registry = new PackageRegistry({ mcpServers: { 'fictional-notes': { command: 'unused' } } });
  cleanup.push(() => registry.closeAll());
  const callTool = vi.fn().mockRejectedValue(error);
  vi.spyOn(registry, 'getClient').mockResolvedValue({
    connect: vi.fn(), close: vi.fn(), listTools: async () => [tool], callTool,
  });
  const catalog = new Catalog(registry);
  catalog.commitReady('fictional-notes', [tool], catalog.getConfigurationGeneration());
  vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
  return { callTool, result: handleUseTool({ package_id: 'fictional-notes', tool_id: 'send', args: {} }, registry, catalog, new Validator()) };
}

describe('use_tool downstream MCP error codes', () => {
  it('preserves the SDK closed-connection code in the downstream wrapper', async () => {
    const { callTool, result } = run(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    await expect(result).rejects.toMatchObject({
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      data: { package_id: 'fictional-notes', tool_id: 'send', mcp_error_code: -32000 },
    });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('omits the MCP code for a plain Error', async () => {
    const { callTool, result } = run(new Error('Connection closed'));
    await expect(result).rejects.toMatchObject({ code: ERROR_CODES.DOWNSTREAM_ERROR });
    await expect(result).rejects.not.toHaveProperty('data.mcp_error_code');
    expect(callTool).toHaveBeenCalledOnce();
  });
});
