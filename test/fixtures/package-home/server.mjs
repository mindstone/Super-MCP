import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'fictional-notebook', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
const tool = {
  name: 'write_note', description: 'Write a fictional note',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { title: 'Write note', readOnlyHint: false, destructiveHint: false },
  _meta: { ui: { resourceUri: 'ui://notebook/view' }, fictional: { value: 7 } },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: 'text', text: params.arguments.text }], _meta: { fictional: 'call-meta' },
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'ui://notebook/view', name: 'view', mimeType: 'text/html' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [{ uri: params.uri, mimeType: 'text/html', text: '<p>Fictional notebook</p>', _meta: { ui: { prefersBorder: true } } }],
  _meta: { fictional: 'resource-meta' },
}));
await server.connect(new StdioServerTransport());
