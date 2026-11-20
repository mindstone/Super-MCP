/**
 * Stdio: node streamed-result-mcp-server.mjs. Or import createStreamedResultFixtureServer()
 * and connect it to another SDK transport. No network or provider calls are made here.
 * One tool, stream-files: { workspace, releaseFile, outcome?: 'complete' | 'incomplete' }.
 * Supply a fresh absolute temp workspace and an absent absolute releaseFile per call.
 * Writes outputs/{first,second}.txt, emitting plain + running progress for each.
 * Creating releaseFile releases the latch: success appends bytes and emits complete;
 * incomplete retains the prefixes, emits incomplete, and returns isError: true.
 * No token means no notifications; 0 and strings are echoed unchanged. Progress is
 * an ordinal across both files; unknown total is omitted. The caller owns cleanup.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { buildStreamedResultMeta } from '../../dist/streamedResultProtocol.js';

async function waitForRelease(releaseFile, signal) {
  for (;;) {
    signal.throwIfAborted();
    try { await stat(releaseFile); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await setTimeout(10, undefined, { signal, ref: false });
  }
}

export function createStreamedResultFixtureServer({ heartbeatMs = 0 } = {}) {
  const server = new McpServer({ name: 'streamed-result-fixture', version: '1.0.0' });
  const absolutePath = z.string().refine(path.isAbsolute);
  server.registerTool('stream-files', {
    inputSchema: {
      workspace: absolutePath, releaseFile: absolutePath, cancelledFile: absolutePath.optional(),
      outcome: z.enum(['complete', 'incomplete']).default('complete'),
    },
  }, async ({ workspace, releaseFile, cancelledFile, outcome }, extra) => {
    const token = extra._meta?.progressToken;
    let ordinal = 0;
    const notify = async (message, stream) => {
      if (token === undefined) return;
      await extra.sendNotification({ method: 'notifications/progress', params: {
        progressToken: token, progress: ++ordinal, message,
        ...(stream ? { _meta: buildStreamedResultMeta(stream) } : {}),
      } });
    };
    const files = [
      { ref: 'outputs/first.txt', prefix: 'first\n' },
      { ref: 'outputs/second.txt', prefix: 'second\n' },
    ];
    await mkdir(path.join(workspace, 'outputs'), { recursive: true });
    for (const file of files) {
      await writeFile(path.join(workspace, file.ref), file.prefix, { flag: 'wx', mode: 0o600 });
      file.bytes = Buffer.byteLength(file.prefix);
      await notify('Writing a file');
      await notify('File started', { ref: file.ref, bytes: file.bytes, mime: 'text/plain', state: 'running' });
    }
    const heartbeat = heartbeatMs ? setInterval(() => {
      void notify('Still working').catch(() => clearInterval(heartbeat));
    }, heartbeatMs) : undefined;
    let cancellation = Promise.resolve();
    const cancelled = () => { if (cancelledFile) cancellation = writeFile(cancelledFile, 'cancelled'); };
    if (extra.signal.aborted) cancelled();
    else extra.signal.addEventListener('abort', cancelled, { once: true });
    try { await waitForRelease(releaseFile, extra.signal); }
    finally { clearInterval(heartbeat); extra.signal.removeEventListener('abort', cancelled); await cancellation; }
    for (const file of files) {
      if (outcome === 'complete') {
        await appendFile(path.join(workspace, file.ref), 'done\n');
        file.bytes += Buffer.byteLength('done\n');
      }
      await notify(outcome === 'complete' ? 'File complete' : 'File incomplete', {
        ref: file.ref, bytes: file.bytes, mime: 'text/plain', state: outcome,
      });
    }
    return {
      content: [{ type: 'text', text: outcome === 'complete' ? 'Files written' : 'Simulated stream failure' }],
      structuredContent: { files: files.map(({ ref, bytes }) => ({ ref, bytes, mime: 'text/plain', state: outcome })) },
      ...(outcome === 'incomplete' ? { isError: true } : {}),
    };
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await createStreamedResultFixtureServer({ heartbeatMs: Number(process.env.FIXTURE_HEARTBEAT_MS) || 0 }).connect(new StdioServerTransport());
}
