// Fixture for test/stdio-client-clean-stop.test.ts.
// argv: <mode> <marker-file>
//   mode "tidy":      on stdin end, write the marker file and exit (a connector
//                     that tidies up when stopped); declares keep-alive.
//   mode "stubborn":  ignores stdin end and keeps running; spawns a child that
//                     also keeps running and writes the child's pid to the marker.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const [mode, marker] = process.argv.slice(2);

const server = new McpServer(
  { name: 'clean-stop-fixture', version: '1.0.0' },
  mode === 'tidy' ? { capabilities: { experimental: { 'super-mcp/keep-alive': {} } } } : {},
);

server.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

if (mode === 'tidy') {
  process.stdin.on('end', () => {
    writeFileSync(marker, 'tidied');
    process.exit(0);
  });
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(marker, String(child.pid));
  setInterval(() => {}, 1000);
}

await server.connect(new StdioServerTransport());
