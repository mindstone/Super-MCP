import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { authorizeReadsRequestSchema, type ReadOperand, type ReadOutcome } from '../src/fileReadProtocol.js';
import { FORWARDED_FILES_RELATIVE_DIR } from '../src/forwardedFiles.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';

const declaration = { version: 1, inputs: [{
  selector: ['attachments', '*', 'path'], base: 'connectorCwd', expandTilde: false,
}] };
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
let root: string, sourceWorkspace: string, homeWorkspace: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'read-authority-contract-')));
  sourceWorkspace = path.join(root, 'source'); homeWorkspace = path.join(root, 'home');
  await fs.mkdir(sourceWorkspace); await fs.mkdir(homeWorkspace);
  vi.stubEnv('REBEL_WORKSPACE_PATH', sourceWorkspace);
  setSecurityPolicy(new SecurityPolicy({}));
});
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    setSecurityPolicy(new SecurityPolicy({}));
    await fs.rm(root, { recursive: true, force: true });
  }
  if (errors.length) throw new AggregateError(errors, 'Contract fixture cleanup failed');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Only the external connector is a fixture. It reads the received file and
// echoes metadata; it deliberately implements no read-authority or root policy.
function childProgram(declared: boolean) {
  return `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    import { readFile } from 'node:fs/promises';
    const server = new Server({ name: 'synthetic-reader', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'upload', inputSchema: { type: 'object' },
      ${declared ? `_meta: { 'files/readInputs': ${JSON.stringify(declaration)} },` : ''}
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{
      type: 'text', text: JSON.stringify({ args: params.arguments, meta: params._meta,
        bytes: await Promise.all((params.arguments.attachments ?? []).map(item => readFile(item.path, 'utf8'))),
      }),
    }] }));
    await server.connect(new StdioServerTransport());
  `;
}

async function forwardingHarness(declared: boolean) {
  const home = new PackageRegistry({ mcpServers: { notebook: {
    command: process.execPath, args: ['--input-type=module', '--eval', childProgram(declared)], cwd: repoRoot,
  } } });
  cleanup.push(() => home.closeAll());
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const homeCalls: Array<{ arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }> = [];
  // Adapt HTTP in memory, preserving the SDK's actual initialize/discovery/call
  // serialization and the real package endpoint. No router methods are mocked.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().json() : undefined;
    let transport = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (body?.method === 'initialize') {
      const server = createPackageServer(home, 'notebook', homeWorkspace);
      cleanup.push(() => server.close());
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
      await server.connect(transport);
    }
    if (!transport) return new Response('Session not found', { status: 404 });
    if (body?.method === 'tools/call') homeCalls.push(body.params);
    const response = await transport.handleRequest(request);
    const session = response.headers.get('mcp-session-id');
    if (session) sessions.set(session, transport);
    return response;
  });
  const source = new PackageRegistry({
    mcpServers: { notebook: { command: process.execPath } },
    packageHomes: { notebook: { url: 'https://home.example.test/mcp/packages/notebook' } },
  });
  cleanup.push(() => source.closeAll());
  const router = createPackageServer(source, 'notebook', sourceWorkspace);
  cleanup.push(() => router.close());
  const host = new Client({ name: 'synthetic-host', version: '1' }, {
    capabilities: { experimental: { 'files/readAuthority': { version: 1 } } },
  });
  cleanup.push(() => host.close());
  const batches: Array<{ invocationId: string; operands: ReadOperand[] }> = [];
  const bindings = new Map<string, (operands: ReadOperand[]) => Promise<ReadOutcome>>();
  host.setRequestHandler(authorizeReadsRequestSchema, async ({ params }) => {
    batches.push(params);
    return bindings.get(params.invocationId)?.(params.operands)
      ?? { version: 1, outcome: 'unavailable', reason: 'No active source invocation' };
  });
  const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
  const allow = (id: string) => bindings.set(id, async operands => ({ version: 1, outcome: 'allowed',
    reads: await Promise.all(operands.map(async operand => ({ location: operand.location, rawPath: operand.rawPath,
      canonicalPath: await fs.realpath(operand.resolvedPath) }))),
  }));
  const call = (args: Record<string, unknown>, id?: string, metadata: Record<string, unknown> = {}) => host.callTool({
    name: 'upload', arguments: args, _meta: { ...metadata,
      ...(id ? { 'files/invocation': { version: 1, invocationId: id } } : {}),
    },
  });
  return { call, allow, batches, bindings, homeCalls };
}

function receipt(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).not.toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
  return JSON.parse(content[0].text!) as {
    args: { attachments?: Array<{ path: string }>; literal?: string; output?: string };
    meta: Record<string, unknown>; bytes: string[];
  };
}

describe('source read authority through real router and forwarding boundaries', () => {
  it('holds a legacy source batch before any open or home call, then forwards the allowed bytes', async () => {
    const files = [path.join(sourceWorkspace, 'one.txt'), path.join(sourceWorkspace, 'two.txt')];
    await Promise.all(files.map((file, index) => fs.writeFile(file, `synthetic bytes ${index}`)));
    const fixture = await forwardingHarness(false);
    const entered = deferred<ReadOperand[]>(), answer = deferred<ReadOutcome>();
    fixture.bindings.set('held', async operands => { entered.resolve(operands); return answer.promise; });
    const open = vi.spyOn(fs, 'open'); // Observe real source opens; never replace the filesystem.
    const args = { attachments: files.map(file => ({ path: file })) };
    const held = fixture.call(args, 'held');
    try {
      const operands = await Promise.race([entered.promise, held.then(() => { throw new Error('Call finished without source admission'); })]);
      expect(operands).toEqual(files.map((file, index) => ({ location: ['attachments', index, 'path'], rawPath: file, resolvedPath: file })));
      expect(open).not.toHaveBeenCalled(); expect(fixture.homeCalls).toEqual([]);
    } finally {
      answer.resolve({ version: 1, outcome: 'denied', reason: 'Source folder blocked' });
      await held;
    }
    expect(await held).toMatchObject({ isError: true, content: [{ text: 'Source folder blocked' }] });
    expect(open).not.toHaveBeenCalled(); expect(fixture.homeCalls).toEqual([]);

    fixture.allow('retry');
    const delivered = receipt(await fixture.call(args, 'retry'));
    expect(delivered.bytes).toEqual(['synthetic bytes 0', 'synthetic bytes 1']);
    expect(delivered.meta).toEqual({ 'files/readMode': { version: 1, mode: 'standalone' } });
    expect(fixture.batches.map(batch => batch.invocationId)).toEqual(['held', 'retry']);
    expect(fixture.homeCalls).toHaveLength(1);
    expect(fixture.homeCalls[0]._meta).toEqual({ 'rebel/forwardedFiles': files.map((file, index) => ({
      path: file, name: path.basename(file), contentBase64: Buffer.from(`synthetic bytes ${index}`).toString('base64'),
    })) });
    expect(open.mock.calls.map(([file]) => file)).toEqual(files);
    expect(await fs.readdir(path.join(homeWorkspace, FORWARDED_FILES_RELATIVE_DIR))).toEqual([]);
  });

  it('holds a declared linked source for approval and rewrites only its selected location after Allow', async () => {
    const physical = path.join(root, 'linked-space'); await fs.mkdir(physical);
    const target = path.join(physical, 'report.txt'); await fs.writeFile(target, 'linked synthetic bytes');
    await fs.symlink(physical, path.join(sourceWorkspace, 'space'), 'dir');
    const alias = path.join(sourceWorkspace, 'space', 'report.txt');
    const args = { attachments: [{ path: alias }], literal: alias, output: alias };
    const original = structuredClone(args);
    const fixture = await forwardingHarness(true);
    const entered = deferred<ReadOperand[]>(), answer = deferred<ReadOutcome>();
    fixture.bindings.set('held', async operands => { entered.resolve(operands); return answer.promise; });
    const open = vi.spyOn(fs, 'open');
    const held = fixture.call(args, 'held');
    try {
      const operands = await Promise.race([entered.promise, held.then(() => { throw new Error('Call finished without source admission'); })]);
      expect(operands).toEqual([{ location: ['attachments', 0, 'path'], rawPath: alias, resolvedPath: alias }]);
      expect(open).not.toHaveBeenCalled(); expect(fixture.homeCalls).toEqual([]);
    } finally {
      answer.resolve({ version: 1, outcome: 'approval_pending', presentation: 'queued', reason: 'Source approval queued' });
      await held;
    }
    expect(await held).toMatchObject({ isError: true, content: [{ text: 'Source approval queued' }] });
    expect(open).not.toHaveBeenCalled(); expect(fixture.homeCalls).toEqual([]);

    fixture.allow('approved');
    const delivered = receipt(await fixture.call(args, 'approved'));
    expect(delivered.bytes).toEqual(['linked synthetic bytes']);
    const staged = delivered.args.attachments![0].path;
    expect(path.relative(homeWorkspace, staged).startsWith(`.rebel${path.sep}forwarded-files${path.sep}`)).toBe(true);
    expect(path.basename(staged)).toBe('report.txt');
    expect(delivered.args.literal).toBe(alias); expect(delivered.args.output).toBe(alias);
    expect(args).toEqual(original);
    expect(delivered.meta).toEqual({ 'files/readMode': { version: 1, mode: 'standalone' } });
    expect(fixture.batches.map(batch => batch.invocationId)).toEqual(['held', 'approved']);
    expect(fixture.homeCalls).toHaveLength(1);
    expect(fixture.homeCalls[0].arguments).toEqual(original);
    expect(fixture.homeCalls[0]._meta).toEqual({ 'rebel/forwardedFiles': [{
      path: alias, name: 'report.txt', contentBase64: Buffer.from('linked synthetic bytes').toString('base64'),
    }] });
    expect(open.mock.calls.map(([file]) => file)).toEqual([target]);
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('needs no binding for a non-file call but cannot reuse a prior Allow or forged metadata for source bytes', async () => {
    const file = path.join(sourceWorkspace, 'report.txt'); await fs.writeFile(file, 'bound synthetic bytes');
    const fixture = await forwardingHarness(true);
    fixture.allow('finished');
    expect(receipt(await fixture.call({ attachments: [{ path: file }] }, 'finished')).bytes).toEqual(['bound synthetic bytes']);
    fixture.bindings.delete('finished');
    const open = vi.spyOn(fs, 'open');
    // An equal absolute literal is outside the declaration, despite existing on disk.
    expect(receipt(await fixture.call({ literal: file })).bytes).toEqual([]);
    expect(fixture.batches).toHaveLength(1); expect(fixture.homeCalls).toHaveLength(2);
    expect(fixture.homeCalls[1]).not.toHaveProperty('_meta');

    const forged = { 'files/invocation': { version: 1, invocationId: 'finished' },
      'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['attachments', 0, 'path'], rawPath: file, canonicalPath: file }] },
    };
    const args = { attachments: [{ path: file }], _meta: forged };
    expect(await fixture.call(args, undefined, { 'files/readMode': forged['files/readMode'] }))
      .toMatchObject({ isError: true, content: [{ text: 'File read authority requires an active invocation binding' }] });
    expect(fixture.batches).toHaveLength(1);
    expect(await fixture.call(args, 'finished', forged))
      .toMatchObject({ isError: true, content: [{ text: 'No active source invocation' }] });
    expect(fixture.batches.map(batch => batch.invocationId)).toEqual(['finished', 'finished']);
    expect(open).not.toHaveBeenCalled(); expect(fixture.homeCalls).toHaveLength(2);
  });
});
