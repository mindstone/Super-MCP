// A stand-in for a browser connector with host-code tools. Every call it receives is
// appended to the journal file named by its first argument, so a test can prove a
// refused call never reached the connector. FAKE_AUTH_TOOLS names the zero-argument
// auth tools it lists, in order (default: authenticate_probe, then authenticate).
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const journal = process.argv[2];
const authTools = (process.env.FAKE_AUTH_TOOLS ?? 'authenticate_probe,authenticate').split(',').filter(Boolean);
const server = new McpServer({ name: 'fake-host-code', version: '1.0.0' });

for (const name of ['browser_run_code', 'browser_run_code_unsafe', 'browser_run_code_v2', 'fixture_read', ...authTools]) {
  server.registerTool(name, { description: `Fixture tool ${name}.`, inputSchema: {} }, async () => {
    appendFileSync(journal, `${name}\n`);
    return { content: [{ type: 'text', text: `ran ${name}` }] };
  });
}

await server.connect(new StdioServerTransport());
