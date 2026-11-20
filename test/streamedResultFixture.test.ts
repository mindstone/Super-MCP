import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressNotificationSchema, type ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { parseStreamedResult, STREAMED_RESULT_META, type StreamedResult } from '../src/streamedResultProtocol.js';

const fixture = fileURLToPath(new URL('./fixtures/streamed-result-mcp-server.mjs', import.meta.url));

describe('streamed result fake over real SDK stdio', () => {
  it.each([
    { progressToken: 0, outcome: 'complete' },
    { progressToken: 'string-token', outcome: 'complete' },
    { progressToken: 0, outcome: 'incomplete' },
    { progressToken: 'string-token', outcome: 'incomplete' },
  ])('publishes before release and settles afterward: %j', async ({ progressToken, outcome }) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'streamed-result-'));
    const releaseFile = path.join(workspace, 'release');
    const client = new Client({ name: 'streamed-result-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fixture], stderr: 'pipe' });
    const messages: ProgressNotification[] = [];
    const receivedBeforeRelease: boolean[] = [];
    const errors: Error[] = [];
    let released = false;
    let settled = false;
    let notifyReady!: () => void;
    const ready = new Promise<void>(resolve => { notifyReady = resolve; });
    client.onerror = error => { errors.push(error); };
    client.setNotificationHandler(ProgressNotificationSchema, notification => {
      messages.push(notification);
      receivedBeforeRelease.push(!released);
      if (messages.length === 4) notifyReady();
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['stream-files']);
      const resultPromise = client.callTool({
        name: 'stream-files', arguments: { workspace, releaseFile, outcome }, _meta: { progressToken },
      }).then(result => { settled = true; return result; });
      // Surface a premature final result (or request failure) instead of waiting for a timing assertion.
      await Promise.race([ready, resultPromise.then(() => { throw new Error('Final result arrived before latch'); })]);
      expect(settled).toBe(false);
      expect(receivedBeforeRelease).toEqual([true, true, true, true]);
      await expect(stat(releaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const [ref, bytes] of [['outputs/first.txt', 'first\n'], ['outputs/second.txt', 'second\n']]) {
        expect(await readFile(path.join(workspace, ref), 'utf8')).toBe(bytes);
      }
      released = true;
      await writeFile(releaseFile, 'release');
      const result = await resultPromise;
      expect(settled).toBe(true);
      expect(result.isError).toBe(outcome === 'incomplete' ? true : undefined);
      expect(result.content).toEqual([{ type: 'text', text: outcome === 'complete' ? 'Files written' : 'Simulated stream failure' }]);
      expect(messages).toHaveLength(6);
      expect(receivedBeforeRelease).toEqual([true, true, true, true, false, false]);

      const streams: StreamedResult[] = [];
      for (const [index, message] of messages.entries()) {
        // Check every actual fixture notification through both independent boundary parsers.
        const decoded = ProgressNotificationSchema.parse(message);
        expect(decoded).toEqual(message);
        expect(decoded.params.progressToken).toBe(progressToken);
        expect(decoded.params.progress).toBe(index + 1);
        expect(decoded.params).not.toHaveProperty('total');
        const parsed = parseStreamedResult(decoded.params._meta?.[STREAMED_RESULT_META]);
        if (index === 0 || index === 2) {
          expect(decoded.params).not.toHaveProperty('_meta');
          expect(parsed).toEqual({ ok: false, reason: 'absent' });
        } else {
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) throw new Error(`Fixture stream refused: ${parsed.reason}`);
          streams.push(parsed.value);
        }
      }
      const extraBytes = outcome === 'complete' ? 5 : 0;
      expect(streams).toEqual([
        { version: 1, ref: 'outputs/first.txt', bytes: 6, mime: 'text/plain', state: 'running' },
        { version: 1, ref: 'outputs/second.txt', bytes: 7, mime: 'text/plain', state: 'running' },
        { version: 1, ref: 'outputs/first.txt', bytes: 6 + extraBytes, mime: 'text/plain', state: outcome },
        { version: 1, ref: 'outputs/second.txt', bytes: 7 + extraBytes, mime: 'text/plain', state: outcome },
      ]);
      expect(result.structuredContent).toEqual({ files: streams.slice(2).map(({ version: _version, ...file }) => file) });
      for (const file of streams.slice(2)) {
        expect((await stat(path.join(workspace, file.ref))).size).toBe(file.bytes);
        expect(await readFile(path.join(workspace, file.ref), 'utf8')).toBe(
          (file.ref.endsWith('first.txt') ? 'first\n' : 'second\n') + (outcome === 'complete' ? 'done\n' : ''),
        );
      }
      expect(errors).toEqual([]);
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15000);
});
