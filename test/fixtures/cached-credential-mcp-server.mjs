import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { value } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const server = new McpServer({ name: 'cached-credential-fixture', version: '1' });
server.registerTool('read', { inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ value, pid: process.pid }) }],
}));
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
