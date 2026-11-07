import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { StdioMcpClient } from '../src/clients/stdioClient.js';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { authorizeReadsRequestSchema, authorizeReads, captureToolDispatch, childCallContext, type ToolDispatchContext, type OriginExtra } from '../src/fileReadProtocol.js';
import { calculateInputBases, effectiveInputBases, preflightLocalTool } from '../src/fileReadPreflight.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { Catalog } from '../src/catalog.js';
import { Validator } from '../src/validator.js';
import type { McpClient } from '../src/types.js';
import type { InputBases } from '../src/fileReadInputs.js';

vi.mock('../src/logging.js', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const declaration = { version: 1, inputs: [{ selector: ['file'], base: 'connectorCwd', expandTilde: false,
  nonLocalPrefixes: ['https://'], when: [{ relativeTo: 'root', selector: ['content'], test: 'undefined' }],
}] };

describe('originating file-read preflight at registry dispatch', () => {
  it.each(['approval_pending', 'denied', 'unavailable'])('does not dispatch after host %s', async outcome => {
    const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused' } } });
    const dispatch = vi.fn().mockResolvedValue({ content: [] });
    vi.spyOn(registry, 'getClient').mockResolvedValue({
      connect: vi.fn(), close: vi.fn(), listTools: async () => [{ name: 'upload', _meta: { 'files/readInputs': declaration } }],
      callTool: dispatch, getToolMetadata: async () => ({ 'files/readInputs': declaration }),
    });
    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome, reason: 'Source read held', ...(outcome === 'approval_pending' ? { presentation: 'queued' } : {}) });
    try {
      await expect(registry.callTool('fixture', 'upload', { file: '/synthetic/report.txt' }, {
        kind: 'origin', authority: { version: 1 }, metadata: { 'files/invocation': { version: 1, invocationId: 'active' } },
        signal: new AbortController().signal, sendRequest,
      })).rejects.toThrow('Source read held');
      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await registry.closeAll(); }
  });
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const config = { id: 'fixture', name: 'Fixture', transport: 'stdio' as const, visibility: 'default' as const, command: 'unused', cwd: '/connector' };

async function sdkHarness(authority = true, timeout?: number, presentation: 'queued' | 'staged' = 'queued') {
  const child = new Server({ name: 'fixture-child', version: '1' }, { capabilities: { tools: {} } });
  const calls: { args: unknown; meta: unknown }[] = [];
  child.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'upload', inputSchema: { type: 'object' as const }, _meta: { 'files/readInputs': declaration } },
    { name: 'plain', inputSchema: { type: 'object' as const } },
  ] }));
  child.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    calls.push({ args: params.arguments, meta: extra._meta });
    return { content: [{ type: 'text', text: 'uploaded' }] };
  });
  const local = new StdioMcpClient('fixture', config);
  const [left, right] = InMemoryTransport.createLinkedPair();
  const childClient = (local as unknown as { client: Client }).client;
  await Promise.all([child.connect(left), childClient.connect(right)]);
  vi.spyOn(local, 'isTransportClosed').mockReturnValue(false);
  const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused', cwd: '/connector', timeout } } });
  vi.spyOn(registry, 'getClient').mockResolvedValue(local);
  const router = createPackageServer(registry, 'fixture');
  const host = new Client({ name: 'fixture-host', version: '1' }, { capabilities: authority ? { experimental: { 'files/readAuthority': { version: 1 } } } : {} });
  const batches: unknown[] = [];
  const bindings = new Map<string, 'allowed' | 'denied' | 'approval_pending'>();
  host.setRequestHandler(authorizeReadsRequestSchema, async ({ params }, extra) => {
    batches.push(params);
    if (params.invocationId === 'slow') await new Promise<void>(resolve => extra.signal.addEventListener('abort', () => resolve(), { once: true }));
    const outcome = bindings.get(params.invocationId);
    if (!outcome) return { version: 1, outcome: 'unavailable', reason: 'Invocation has ended.' };
    if (outcome !== 'allowed') return { version: 1, outcome, reason: 'Source read held', ...(outcome === 'approval_pending' ? { presentation } : {}) };
    return { version: 1, outcome, reads: params.operands.map(({ location, rawPath }) => ({ location, rawPath, canonicalPath: `/physical/${params.invocationId}.txt` })) };
  });
  const [hostSide, routerSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.connect(hostSide), router.connect(routerSide)]);
  const routerSend = vi.spyOn(routerSide, 'send');
  cleanup.push(() => child.close(), () => childClient.close(), () => registry.closeAll(), () => router.close(), () => host.close());
  const call = (id?: string, args: Record<string, unknown> = { file: 'report.txt' }, name = 'upload') => host.callTool({ name, arguments: args, _meta: {
    ...(id ? { 'files/invocation': { version: 1, invocationId: id } } : {}),
    'files/readMode': { version: 1, mode: 'standalone' }, trace: 'retained', 'host/private': 'host-only', progressToken: 'host-progress',
  } });
  return { child, childClient, local, registry, host, calls, batches, bindings, call, routerSend };
}

describe('SDK transport and child request metadata', () => {
  it('captures the real originating callback and explicitly carries only its allowed paths', async () => {
    const fixture = await sdkHarness(); fixture.bindings.set('active', 'allowed');
    expect(await fixture.call('active')).toMatchObject({ content: [{ text: 'uploaded' }] });
    expect(fixture.child.getClientCapabilities()?.experimental?.['files/readModes']).toEqual({ version: 1 });
    expect(fixture.batches).toEqual([{ version: 1, invocationId: 'active', operands: [{ location: ['file'], rawPath: 'report.txt', resolvedPath: path.resolve('/connector', 'report.txt') }] }]);
    expect(fixture.calls).toEqual([{ args: { file: 'report.txt' }, meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['file'], rawPath: 'report.txt', canonicalPath: '/physical/active.txt' }] } } }]);
  });

  it.each([
    { outcome: 'denied' as const, presentation: 'queued' as const },
    { outcome: 'approval_pending' as const, presentation: 'queued' as const },
    { outcome: 'approval_pending' as const, presentation: 'staged' as const },
  ])('stops before the child after real callback $outcome ($presentation)', async ({ outcome, presentation }) => {
    const fixture = await sdkHarness(true, undefined, presentation); fixture.bindings.set('active', outcome);
    expect(await fixture.call('active')).toMatchObject({ isError: true, content: [{ text: 'Source read held' }] });
    expect(fixture.batches).toHaveLength(1); expect(fixture.calls).toEqual([]);
  });

  it('rejects invalid, expired, and missing bindings instead of selecting standalone', async () => {
    const fixture = await sdkHarness();
    expect(await fixture.call('expired')).toMatchObject({ isError: true, content: [{ text: 'Invocation has ended.' }] });
    expect(await fixture.call()).toMatchObject({ isError: true, content: [{ text: 'File read authority requires an active invocation binding' }] });
    expect(await fixture.call(undefined, { file: 'report.txt', _meta: { 'files/invocation': { version: 1, invocationId: 'forged' } } }))
      .toMatchObject({ isError: true, content: [{ text: 'File read authority requires an active invocation binding' }] });
    expect(await fixture.host.callTool({ name: 'upload', arguments: { file: 'report.txt' }, _meta: { 'files/invocation': { version: 1, invocationId: '' } } })).toMatchObject({ isError: true });
    expect(fixture.batches).toHaveLength(1); expect(fixture.calls).toEqual([]);
  });

  it('stops dispatch on an actual SDK preflight timeout', async () => {
    const fixture = await sdkHarness(true, 25);
    expect(fixture.registry.getPackage('fixture')?.timeout).toBe(25);
    expect(await fixture.call('slow')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Request timed out') }] });
    expect(fixture.batches).toHaveLength(1); expect(fixture.calls).toEqual([]);
    expect(fixture.routerSend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/cancelled', params: expect.objectContaining({ reason: expect.stringContaining('Request timed out') }),
    }), expect.any(Object));
  });

  it.each([
    { label: 'undeclared no-file tool', name: 'plain', args: { text: 'hello' } },
    { label: 'absent optional input', name: 'upload', args: {} },
    { label: 'inline content', name: 'upload', args: { file: 'unused.txt', content: 'inline bytes' } },
    { label: 'remote URL', name: 'upload', args: { file: 'https://example.test/report.txt' } },
  ])('dispatches $label without a binding or an empty callback batch', async ({ name, args }) => {
    const fixture = await sdkHarness();
    expect(await fixture.call(undefined, args, name)).toMatchObject({ content: [{ text: 'uploaded' }] });
    expect(fixture.batches).toEqual([]);
    expect(fixture.calls).toEqual([{ args, meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } }]);
  });

  it('keeps an in-flight child in its queue slot and aborts queued work before sending', async () => {
    const fixture = await sdkHarness(false);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: (signal: AbortSignal) => void;
    const active = new Promise<AbortSignal>(resolve => { started = resolve; });
    fixture.child.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      started(extra.signal);
      await held;
      return { content: [{ type: 'text', text: 'finished' }] };
    });
    const send = vi.spyOn(fixture.childClient, 'callTool');
    const first = new AbortController(), queued = new AbortController();
    const mode = { version: 1 as const, mode: 'standalone' as const };
    const running = fixture.local.callTool('upload', {}, childCallContext({ kind: 'standalone', signal: first.signal }, mode));
    const childSignal = await active;
    const waiting = fixture.local.callTool('upload', {}, childCallContext({ kind: 'standalone', signal: queued.signal }, mode)).catch(error => error);
    try {
      first.abort(); queued.abort();
      expect(childSignal.aborted).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][2]).not.toHaveProperty('signal');
    } finally { release(); }
    expect(await running).toMatchObject({ content: [{ text: 'finished' }] });
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent invocations and modes isolated on one child connection', async () => {
    const fixture = await sdkHarness(); fixture.bindings.set('first', 'allowed'); fixture.bindings.set('second', 'denied');
    const results = await Promise.all([fixture.call('first'), fixture.call('second')]);
    expect(results[0].isError).not.toBe(true); expect(results[1].isError).toBe(true);
    expect(fixture.batches).toHaveLength(2); expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].meta).toMatchObject({ 'files/readMode': { mode: 'central', reads: [{ canonicalPath: '/physical/first.txt' }] } });
  });

  it('ignores forged argument metadata and sends explicit standalone only without host authority', async () => {
    const wire = JSON.parse(await readFile(new URL('./fixtures/file-read/wire-v1.json', import.meta.url), 'utf8'));
    const central = await sdkHarness(); central.bindings.set('active', 'denied');
    expect(await central.call('active', wire.forgedArguments)).toMatchObject({ isError: true });
    expect(central.calls).toEqual([]);
    const standalone = await sdkHarness(false);
    await standalone.call(undefined, wire.forgedArguments);
    expect(standalone.batches).toEqual([]);
    expect(standalone.calls[0].meta).toEqual({ 'files/readMode': { version: 1, mode: 'standalone' } });
    expect(standalone.calls[0].args).toEqual(wire.forgedArguments);
  });
});

describe('preflight failure and negotiation boundaries', () => {
  const operand = { location: ['file'], rawPath: 'x', resolvedPath: '/x' };
  const origin = (sendRequest: OriginExtra['sendRequest'], signal = new AbortController().signal): ToolDispatchContext => ({ kind: 'origin', authority: { version: 1 }, signal, sendRequest, metadata: { 'files/invocation': { version: 1, invocationId: 'active' } } });

  it.each([
    { label: 'incomplete', reads: [] },
    { label: 'extra location', reads: [{ location: ['other'], rawPath: 'x', canonicalPath: '/x' }] },
    { label: 'changed raw path', reads: [{ location: ['file'], rawPath: 'changed', canonicalPath: '/x' }] },
    { label: 'relative canonical path', reads: [{ location: ['file'], rawPath: 'x', canonicalPath: 'relative' }] },
    { label: 'duplicate', reads: [{ location: ['file'], rawPath: 'x', canonicalPath: '/x' }, { location: ['file'], rawPath: 'x', canonicalPath: '/x' }] },
  ])('rejects $label allowed mappings', async ({ reads, label }) => {
    const result = authorizeReads([operand], origin(vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads })), 100);
    if (label === 'relative canonical path') await expect(result).rejects.toThrow();
    else await expect(result).rejects.toThrow('incomplete or mismatched batch');
  });

  it('accepts a complete allowed mapping and skips empty batches while still checking abort', async () => {
    const reads = [{ location: ['file'], rawPath: 'x', canonicalPath: '/physical' }];
    const send = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads });
    expect(await authorizeReads([operand], origin(send), 100)).toEqual(reads);
    const context = origin(send); context.metadata = undefined;
    expect(await authorizeReads([], context, 100)).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    const stopped = new AbortController(); stopped.abort();
    await expect(authorizeReads([], origin(send, stopped.signal), 100)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops on transport error, timeout, or abort including a reply after cancellation', async () => {
    await expect(authorizeReads([operand], origin(vi.fn().mockRejectedValue(new Error('Transport unavailable'))), 100)).rejects.toThrow('Transport unavailable');
    const controller = new AbortController(); const send = vi.fn(); controller.abort();
    await expect(authorizeReads([operand], origin(send, controller.signal), 100)).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
    const late = vi.fn();
    const during = new AbortController();
    late.mockImplementation(async () => { during.abort(); return { version: 1, outcome: 'allowed', reads: [{ location: ['file'], rawPath: 'x', canonicalPath: '/x' }] }; });
    await expect(authorizeReads([operand], origin(late, during.signal), 100)).rejects.toThrow();
  });

  it('never reads arbitrary HTTP tool declarations or sends local canonical paths to them', async () => {
    const metadata = vi.fn().mockResolvedValue({ 'files/readInputs': declaration });
    const context = origin(vi.fn()); context.metadata = { trace: 'private', progressToken: 'host-progress', 'host/private': 'host-only' };
    const result = await preflightLocalTool({ getToolMetadata: metadata } as any, { ...config, transport: 'http' }, 'upload', { file: '/x' }, context);
    expect(metadata).not.toHaveBeenCalled(); expect(result.context.metadata).toBeUndefined();
    expect(context.kind === 'origin' && context.sendRequest).not.toHaveBeenCalled();
  });

  it('dispatches HTTP without a binding, upstream metadata, or new child cancellation', async () => {
    const httpConfig = { ...config, transport: 'http' as const, base_url: 'https://example.test/mcp' };
    const client = new HttpMcpClient('fixture', httpConfig);
    // Isolate dispatch on an already-connected client; the SDK send is observed below.
    Reflect.set(client, 'isConnected', true);
    const send = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
    const metadata = vi.spyOn(Client.prototype, 'listTools');
    const context = origin(vi.fn()); context.metadata = { trace: 'private', progressToken: 'host-progress', 'host/private': 'host-only' };
    const registry = new PackageRegistry({ packages: [httpConfig] });
    vi.spyOn(registry, 'getClient').mockResolvedValue(client);
    cleanup.push(() => client.close(), () => registry.closeAll());
    await registry.callTool('fixture', 'upload', { file: '/source' }, context);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ name: 'upload', arguments: { file: '/source' } });
    expect(send.mock.calls[0][2]).not.toHaveProperty('signal');
    expect(metadata).not.toHaveBeenCalled();
    expect(context.kind === 'origin' && context.sendRequest).not.toHaveBeenCalled();
  });

  it('sends an empty central list for no-file tools and carries only router metadata', async () => {
    const context = origin(vi.fn()); context.metadata = { 'files/other': 'untrusted', trace: 'private', progressToken: 'host-progress' };
    const result = await preflightLocalTool({ getToolMetadata: async () => undefined } as any, config, 'plain', {}, context);
    expect(result.context.metadata).toEqual({ 'files/readMode': { version: 1, mode: 'central', reads: [] } });
    expect(childCallContext(context).metadata).toBeUndefined();
    expect(context.kind === 'origin' && context.sendRequest).not.toHaveBeenCalled();
  });
});

describe('workspace operand preparation at local dispatch', () => {
  const captured = { connectorCwd: '/installation', workspace: '/workspace', home: '/synthetic-home', temp: '/synthetic-temp' };
  function harness(meta: Record<string, unknown> | undefined = { 'files/readInputs': declaration }, bases: InputBases = captured, cwd?: string) {
    const dispatch = vi.fn().mockResolvedValue({ content: [] });
    const metadata = vi.fn().mockResolvedValue(meta);
    const client: McpClient = { connect: vi.fn(), close: vi.fn(), listTools: async () => [], callTool: dispatch,
      getToolMetadata: metadata, getFileInputBases: () => bases };
    const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused', cwd } } });
    vi.spyOn(registry, 'getClient').mockResolvedValue(client);
    cleanup.push(() => registry.closeAll());
    return { registry, client, dispatch, metadata };
  }
  const origin = (sendRequest: OriginExtra['sendRequest']): ToolDispatchContext => ({
    kind: 'origin', authority: { version: 1 }, signal: new AbortController().signal, sendRequest,
    metadata: { 'files/invocation': { version: 1, invocationId: 'approved' } },
  });

  it('prepares only active connector-cwd relative locations in a separate standalone execution view', async () => {
    const inputs = [
      { selector: ['data', 'attachments', '*', 'path'], base: 'connectorCwd', expandTilde: false,
        nonLocalPrefixes: ['https://'], when: [{ relativeTo: 'parent', selector: ['content'], test: 'falsy' }] },
      { selector: ['tilde'], base: 'connectorCwd', expandTilde: true },
      { selector: ['literalTilde'], base: 'connectorCwd', expandTilde: false },
      { selector: ['workspaceFile'], base: 'workspaceRealpathOrTmp', expandTilde: false },
    ];
    const fixture = harness({ 'files/readInputs': { version: 1, inputs } });
    const rawPath = 'General/report.txt';
    const args = { data: { attachments: [
      { path: rawPath }, { path: rawPath, content: 'inline' }, { path: 'https://example.test/report.txt' }, { path: '/absolute/../report.txt' },
    ] }, tilde: '~/report.txt', literalTilde: '~/report.txt', workspaceFile: rawPath, literal: rawPath, output: rawPath,
    _meta: { 'files/readMode': { mode: 'central', reads: [] } } };
    const original = structuredClone(args);
    await fixture.registry.callTool('fixture', 'upload', args, { kind: 'standalone' });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith('upload', {
      ...args, data: { attachments: [{ path: path.resolve('/workspace', rawPath) }, ...args.data.attachments.slice(1)] },
      tilde: path.resolve('/synthetic-home/report.txt'), literalTilde: path.resolve('/workspace/~/report.txt'),
    }, expect.objectContaining({ readMode: { version: 1, mode: 'standalone' } }));
    expect(args).toEqual(original);
    expect(fixture.dispatch.mock.calls[0][1]).not.toBe(args);
    expect(fixture.client.getFileInputBases?.()).toBe(captured);
  });

  it('leaves standalone native parents for the child filesystem to walk', async () => {
    const fixture = harness({ 'files/readInputs': { version: 1, inputs: [
      { selector: ['file'], base: 'connectorCwdNative', expandTilde: false },
    ] } });
    const args = Object.freeze({ file: 'link/../report.txt' });
    await fixture.registry.callTool('fixture', 'upload', args, { kind: 'standalone' });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith('upload', {
      file: path.resolve('/workspace') + path.sep + args.file,
    }, expect.objectContaining({ readMode: { version: 1, mode: 'standalone' } }));
    expect(args).toEqual({ file: 'link/../report.txt' });
  });

  it.each([undefined, { version: 2, invalid: true }])('leaves undeclared and future-version arguments intact: %s', async value => {
    const fixture = harness(value ? { 'files/readInputs': value } : {});
    const args = { file: 'General/report.txt' };
    await fixture.registry.callTool('fixture', 'plain', args, { kind: 'standalone' });
    expect(fixture.metadata).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls[0][1]).toBe(args);
  });

  it.each([
    { cwd: '/explicit', workspace: '/workspace' }, { cwd: 'relative-cwd', workspace: '/workspace' },
    { cwd: undefined, workspace: undefined }, { cwd: undefined, workspace: ' ' },
    { cwd: undefined, workspace: '/installation' },
  ])('retains the standalone fast path with cwd=$cwd workspace=$workspace', async ({ cwd, workspace }) => {
    const fixture = harness(undefined, { ...captured, workspace }, cwd);
    const args = { file: 'General/report.txt' };
    await fixture.registry.callTool('fixture', 'upload', args, { kind: 'standalone' });
    expect(fixture.metadata).not.toHaveBeenCalled();
    expect(fixture.dispatch.mock.calls[0][1]).toBe(args);
  });

  it.each(['malformed', 'discovery failure'])('stops affected standalone dispatch on %s', async kind => {
    const fixture = harness({ 'files/readInputs': { version: 1, inputs: 'invalid' } });
    if (kind === 'discovery failure') fixture.metadata.mockRejectedValue(new Error('Discovery failed'));
    await expect(fixture.registry.callTool('fixture', 'upload', { file: 'General/report.txt' }, { kind: 'standalone' })).rejects.toThrow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('nominates workspace bytes centrally while preserving exact original bindings and an outside grant', async () => {
    const fixture = harness();
    const args = Object.freeze({ file: 'General/report.txt', literal: 'General/report.txt' });
    const reads = [{ location: ['file'], rawPath: args.file, canonicalPath: '/granted-outside/report.txt' }];
    const send = vi.fn().mockResolvedValue({ version: 1, outcome: 'allowed', reads });
    await fixture.registry.callTool('fixture', 'upload', args, origin(send));
    expect(send.mock.calls[0][0]).toEqual({ method: 'files/authorizeReads', params: {
      version: 1, invocationId: 'approved', operands: [{ location: ['file'], rawPath: args.file, resolvedPath: path.resolve('/workspace', args.file) }],
    } });
    expect(fixture.dispatch.mock.calls[0][1]).toBe(args);
    expect(fixture.dispatch.mock.calls[0][2].metadata).toEqual({ 'files/readMode': { version: 1, mode: 'central', reads } });
  });

  it.each(['denied', 'approval_pending', 'unavailable', 'malformed batch'])('keeps central %s from dispatching workspace operands', async outcome => {
    const fixture = harness();
    const reply = outcome === 'malformed batch' ? { version: 1, outcome: 'allowed', reads: [] }
      : { version: 1, outcome, reason: 'Source read held', ...(outcome === 'approval_pending' ? { presentation: 'queued' } : {}) };
    const send = vi.fn().mockResolvedValue(reply);
    await expect(fixture.registry.callTool('fixture', 'upload', { file: 'General/report.txt' }, origin(send))).rejects.toThrow();
    expect(send.mock.calls[0][0].params.operands[0]).toEqual({ location: ['file'], rawPath: 'General/report.txt', resolvedPath: path.resolve('/workspace/General/report.txt') });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});

describe('use_tool validation and dry-run ordering', () => {
  it('does not authorize or dispatch an invalid input or a dry run', async () => {
    const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused' } } }); cleanup.push(() => registry.closeAll());
    const catalog = new Catalog(registry);
    const tool = { name: 'upload', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }, _meta: { 'files/readInputs': declaration } };
    catalog.commitReady('fixture', [tool], catalog.getConfigurationGeneration());
    // Execution loading is independent of the already available discovery snapshot.
    vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
    const dispatch = vi.spyOn(registry, 'callTool');
    const sendRequest = vi.fn();
    const context = { dispatch: captureToolDispatch({ version: 1 }, { 'files/invocation': { version: 1, invocationId: 'active' } }, { sendRequest, signal: new AbortController().signal }) };
    await expect(handleUseTool({ package_id: 'fixture', tool_id: 'upload', args: {} }, registry, catalog, new Validator(), context)).rejects.toMatchObject({ code: -33003 });
    const result = await handleUseTool({ package_id: 'fixture', tool_id: 'upload', args: { file: '/source' }, dry_run: true }, registry, catalog, new Validator(), context);
    expect(result.isError).not.toBe(true); expect(dispatch).not.toHaveBeenCalled(); expect(sendRequest).not.toHaveBeenCalled();
    expect(catalog.getTool('fixture', 'upload')?.tool._meta).toEqual(tool._meta);
  });
});

describe('use_tool file-read admission outcomes', () => {
  it.each(['denied', 'approval_pending'] as const)('returns the exact host reason and outer metadata after %s without dispatching', async outcome => {
    const registry = new PackageRegistry({ mcpServers: { fixture: { command: 'unused', cwd: '/connector' } } });
    cleanup.push(() => registry.closeAll());
    const tool = { name: 'upload', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }, _meta: { 'files/readInputs': declaration } };
    const dispatch = vi.fn().mockResolvedValue({ content: [] });
    vi.spyOn(registry, 'getClient').mockResolvedValue({
      connect: vi.fn(), close: vi.fn(), listTools: async () => [tool],
      callTool: dispatch, getToolMetadata: async () => tool._meta,
    });
    const catalog = new Catalog(registry);
    catalog.commitReady('fixture', [tool], catalog.getConfigurationGeneration());
    vi.spyOn(catalog, 'ensurePackageLoaded').mockResolvedValue(undefined);
    const reason = outcome === 'denied' ? 'The source folder is blocked.' : 'Source read is waiting for approval.';
    const sendRequest = vi.fn().mockResolvedValue({ version: 1, outcome, reason,
      ...(outcome === 'approval_pending' ? { presentation: 'queued' } : {}),
    });
    const context = { dispatch: captureToolDispatch({ version: 1 }, { 'files/invocation': { version: 1, invocationId: 'active' } }, { sendRequest, signal: new AbortController().signal }) };
    const result = await handleUseTool({ package_id: 'fixture', tool_id: 'upload', args: { file: '/synthetic/report.txt' } }, registry, catalog, new Validator(), context);
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: reason }],
      _meta: { superMcp: { packageId: 'fixture', toolId: 'upload', durationMs: expect.any(Number) } },
    });
    expect(result._meta.superMcp.durationMs).toBeGreaterThanOrEqual(0);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0][0]).toEqual({ method: 'files/authorizeReads', params: {
      version: 1, invocationId: 'active', operands: [{ location: ['file'], rawPath: '/synthetic/report.txt', resolvedPath: path.resolve('/synthetic/report.txt') }],
    } });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('effective child file-input bases', () => {
  it.each(['win32', 'linux'] as const)('uses the merged child environment on %s', platform => {
    const inherited = { HOME: '/inherited-home', USERPROFILE: 'C:/Users/inherited', TEMP: '/inherited-temp' };
    const overrides = { HOME: '/child-home', USERPROFILE: 'C:/Users/child', TEMP: 'C:/child-temp', TMPDIR: '/child-tmpdir', MCP_WORKSPACE_PATH: ' /child-workspace ' };
    expect(calculateInputBases('/connector', { ...inherited, ...overrides }, platform, '/fallback-home')).toEqual({
      connectorCwd: '/connector', workspace: '/child-workspace',
      home: platform === 'win32' ? 'C:/Users/child' : '/child-home',
      temp: platform === 'win32' ? 'C:/child-temp' : '/child-tmpdir',
    });
  });

  it.each(['win32', 'linux'] as const)('ignores the other platform home variable and retains missing workspace on %s', platform => {
    const env = platform === 'win32' ? { HOME: '/wrong-home', SYSTEMROOT: 'C:\\Windows', TEMP: '' } : { USERPROFILE: 'C:/Users/wrong' };
    expect(calculateInputBases('/connector', env, platform, '/fallback-home')).toEqual({
      connectorCwd: '/connector', workspace: undefined, home: '/fallback-home',
      temp: platform === 'win32' ? 'C:\\Windows\\temp' : '/tmp',
    });
  });

  it.each(['win32', 'linux'] as const)('uses TMP when the preferred temp variable is empty on %s', platform => {
    const env = { TEMP: '', TMPDIR: '', TMP: '/child-tmp', MCP_WORKSPACE_PATH: ' ' };
    expect(calculateInputBases('/connector', env, platform, '/fallback-home'))
      .toMatchObject({ workspace: '', temp: '/child-tmp' });
  });

  it('uses configured overrides in fallback bases and preserves captured bases when available', () => {
    const fallback = effectiveInputBases({ ...config, env: { HOME: '/child-home', USERPROFILE: 'C:/Users/child', TEMP: '/child-temp', TMPDIR: '/child-temp' } });
    expect(fallback).toMatchObject({ connectorCwd: path.resolve('/connector'), home: process.platform === 'win32' ? 'C:/Users/child' : '/child-home', temp: '/child-temp' });
    const captured = { connectorCwd: '/captured-cwd', workspace: '/captured-workspace', home: '/captured-home', temp: '/captured-temp' };
    expect(effectiveInputBases(config, { connect: vi.fn(), close: vi.fn(), listTools: async () => [], callTool: vi.fn(), getFileInputBases: () => captured })).toBe(captured);
  });
});
