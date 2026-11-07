import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { preflightLocalTool } from '../src/fileReadPreflight.js';
import type { McpClient, PackageConfig } from '../src/types.js';
import type { ToolDispatchContext } from '../src/fileReadProtocol.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

// README: "A relative workspace resolves from the actual child cwd." The child cwd here differs
// from the router's own process.cwd(), so resolving from the router would give another path.
describe('relative MCP_WORKSPACE_PATH as the connector-cwd input default', () => {
  const childCwd = path.resolve('/synthetic-child-install');
  const bases = { connectorCwd: childCwd, workspace: 'relative-ws', home: path.resolve('/synthetic-home') };
  const config = { id: 'fixture', name: 'Fixture', transport: 'stdio', visibility: 'default', command: 'unused' } as PackageConfig;
  const meta = { 'files/readInputs': { version: 1, inputs: [{ selector: ['file'], base: 'connectorCwd', expandTilde: false }] } };
  const client = { connect: vi.fn(), close: vi.fn(), listTools: async () => [], callTool: vi.fn(),
    getToolMetadata: async () => meta, getFileInputBases: () => bases } as McpClient;
  const rawPath = 'General/report.txt';
  const expected = path.join(childCwd, 'relative-ws', rawPath);

  it('is non-vacuous: the child-cwd answer differs from the old and router-cwd answers', () => {
    expect(expected).not.toBe(path.join(childCwd, rawPath));
    expect(expected).not.toBe(path.resolve('relative-ws', rawPath));
  });

  it('standalone execution receives the child-cwd-anchored workspace path; original args stay', async () => {
    const args = Object.freeze({ file: rawPath });
    const prepared = await preflightLocalTool(client, config, 'read', args, { kind: 'standalone' });
    expect(prepared.args).toEqual({ file: expected });
    expect(args).toEqual({ file: rawPath });
    expect(prepared.context.readMode).toEqual({ version: 1, mode: 'standalone' });
  });

  it('central nomination uses the same anchored path and keeps the raw binding', async () => {
    const reads = [{ location: ['file'], rawPath, canonicalPath: expected }];
    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads });
    const context: ToolDispatchContext = { kind: 'origin', authority: { version: 1 }, sendRequest,
      metadata: { 'files/invocation': { version: 1, invocationId: 'contract' } }, signal: new AbortController().signal };
    const args = { file: rawPath };
    const prepared = await preflightLocalTool(client, config, 'read', args, context);
    expect(sendRequest.mock.calls[0][0].params.operands).toEqual([{ location: ['file'], rawPath, resolvedPath: expected }]);
    expect(prepared.args).toBe(args);
    expect(prepared.context.readMode).toEqual({ version: 1, mode: 'central', reads });
  });
});
