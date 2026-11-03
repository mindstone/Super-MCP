import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const server = new Server({ name: 'fictional-notebook', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
const tool = {
  name: 'write_note', description: 'Write a fictional note',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { title: 'Write note', readOnlyHint: false, destructiveHint: false },
  _meta: { ui: { resourceUri: 'ui://notebook/view' }, fictional: { value: 7 } },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool, {
  name: 'read_file', description: 'Read a fictional workspace file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === 'read_file') {
    const root = await realpath(process.env.MCP_WORKSPACE_PATH);
    const file = await realpath(params.arguments.file_path);
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('File is outside the workspace');
    return { content: [{ type: 'text', text: createHash('sha256').update(await readFile(file)).digest('hex') }] };
  }
  return { content: [{ type: 'text', text: params.arguments.text }], _meta: { fictional: 'call-meta' } };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'ui://notebook/view', name: 'view', mimeType: 'text/html' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [{ uri: params.uri, mimeType: 'text/html', text: '<p>Fictional notebook</p>', _meta: { ui: { prefersBorder: true } } }],
  _meta: { fictional: 'resource-meta' },
}));
await server.connect(new StdioServerTransport());
