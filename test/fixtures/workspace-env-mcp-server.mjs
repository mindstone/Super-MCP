import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const server = new McpServer({
  name: 'workspace-env-fixture',
  version: '1.0.0',
});

server.registerTool(
  'get-env-snapshot',
  {
    description: 'Returns selected environment variables for the workspace env integration test.',
    inputSchema: {},
  },
  async () => {
    const snapshot = {
      version: 'd17-fixture-v1',
      mcpWorkspacePath: process.env.MCP_WORKSPACE_PATH ?? null,
      rebelWorkspacePath: process.env.REBEL_WORKSPACE_PATH ?? null,
      customMarker: process.env.CUSTOM_MARKER ?? null,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(snapshot) }],
    };
  },
);

let reads = 0;
server.registerTool('read-file', {
  inputSchema: { file: z.string(), literal: z.string().optional() },
  _meta: { 'files/readInputs': { version: 1, inputs: [
    { selector: ['file'], base: 'connectorCwd', expandTilde: false },
  ] } },
}, async ({ file, literal }) => ({
  content: [{ type: 'text', text: JSON.stringify({
    bytes: await readFile(file, 'utf8'), cwd: process.cwd(), pid: process.pid,
    file, literal, reads: ++reads,
  }) }],
}));

await server.connect(new StdioServerTransport());
