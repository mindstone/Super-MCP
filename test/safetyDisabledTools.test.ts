import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_BY_CATALOG_ID } from '../src/communityToolCapabilities.generated.js';
import { computeSecurityAnnotation } from '../src/handlers/annotateToolSecurity.js';
import { handleBulkExport } from '../src/handlers/bulkExport.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { PackageRegistry } from '../src/registry.js';
import { safetyBlock } from '../src/safetyDisabledTools.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';
import { assertToolAccess } from '../src/toolAccess.js';
import { ERROR_CODES } from '../src/types.js';
import type { Catalog } from '../src/catalog.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The four reasons, word for word (PLAN § Technical Design, "Refusal reasons").
const LOCAL_FS = 'Turned off for safety: this tool can read or write files on this computer.';
const EXEC = 'Turned off for safety: this tool can run code on this computer.';
const UNREVIEWED = "Turned off for safety: Rebel hasn't reviewed what this tool can do yet.";
const localFsArgument = (arg: string) => `Turned off for safety: saving to a file on this computer isn't allowed. Leave out \`${arg}\` and try again.`;

const TOOLBOX = '@toolbox-sdk/server@1.7.0';

// Instance names differ from catalog ids on purpose: the block follows the catalog id.
const registry = () => new PackageRegistry({
  mcpServers: {
    'work-pipedrive': { command: 'unused', catalogId: 'pipedrive' },
    'browser-2': { command: 'unused', catalogId: 'playwright' },
    'custom-pipedrive': { command: 'unused' },
    'imported-pipedrive': { command: 'npx', args: ['-y', '@iamsamuelfraga/mcp-pipedrive@2.0.0'] },
    'imported-browser': { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
    'package-flag-browser': { command: 'npx', args: ['--package=@playwright/mcp@0.0.68', 'playwright-mcp'] },
    'package-flag-pipedrive': { command: 'npx', args: ['-y', '--package', '@iamsamuelfraga/mcp-pipedrive', 'mcp-pipedrive'] },
    'short-flag-browser': { command: 'npx', args: ['-p=@playwright/mcp@0.0.68', 'playwright-mcp'] },
    'single-dash-flag-pipedrive': { command: 'npx', args: ['-package=@iamsamuelfraga/mcp-pipedrive@2.0.0', 'mcp-pipedrive'] },
    'lookalike-flag': { command: 'npx', args: ['-p=@playwright/mcp-extra@1.0.0', 'mcp-extra'] },
    'alias-browser': { command: 'npx', args: ['--package=connector@npm:@playwright/mcp@0.0.68', 'playwright-mcp'] },
    'two-packages': { command: 'npx', args: ['--package=@playwright/mcp@0.0.68', '--package=@iamsamuelfraga/mcp-pipedrive@2.0.0', 'mcp-pipedrive'] },
    'spaced-browser': { command: 'npx', args: ['--package= @playwright/mcp ', 'playwright-mcp'] },
    'spaced-pipedrive': { command: 'npx', args: ['--package', ' @iamsamuelfraga/mcp-pipedrive\t', 'mcp-pipedrive'] },
    'installed-path-browser': { command: 'node', args: ['/opt/tools/node_modules/@playwright/mcp/cli.js'] },
    'lookalike': { command: 'npx', args: ['-y', '@playwright/mcp-extra@1.0.0'] },
    'hand-looker': { command: 'npx', args: ['-y', TOOLBOX, '--prebuilt', 'looker', '--stdio'] },
    'hand-bigquery': { command: 'npx', args: ['-y', TOOLBOX, '--prebuilt', 'bigquery', '--stdio'] },
    'hand-toolbox-unknown': { command: 'npx', args: ['-y', TOOLBOX, '--prebuilt=looker', '--stdio'] },
    'uvx-braze': { command: 'uvx', args: ['--native-tls', 'braze-mcp-server==1.2.0'] },
    'bundled-browser': { command: 'npx', args: ['-y', '@playwright/mcp@0.0.68'], catalogId: 'bundled-browser' },
  },
} as any);

const refusal = (packageId: string, toolId: string, reason: string) => ({
  code: ERROR_CODES.TOOL_BLOCKED,
  message: `Tool '${packageId}__${toolId}': ${reason}`,
  data: { package_id: packageId, tool_id: toolId, blocked_reason: reason, reason: 'security-policy' },
});

describe('community tool safety block, derived from the generated capability module', () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    setSecurityPolicy(new SecurityPolicy({}));
    for (const step of cleanup.splice(0)) await step();
  });

  it('blocks exactly the 4 tools off before S3a, the 8 S2 turned off, and restricts the 4 it scoped to an argument', () => {
    const blocked: string[] = [];
    const restricted: string[] = [];
    const unreviewed: string[] = [];
    for (const [catalogId, tools] of Object.entries(CAPABILITY_BY_CATALOG_ID)) {
      for (const [tool, entry] of Object.entries(tools)) {
        const block = safetyBlock({ catalogId }, tool);
        if (block?.reason === UNREVIEWED) unreviewed.push(`${catalogId} · ${tool}`);
        else if (block !== undefined) blocked.push(`${catalogId} · ${tool}`);
        else if (entry.localFsArguments?.some(arg => safetyBlock({ catalogId }, tool, { [arg]: 'out.txt' }) !== undefined)) restricted.push(`${catalogId} · ${tool}`);
      }
    }
    const offBeforeS3a = ['pipedrive · files_upload', 'pipedrive · deals_attach_file', 'playwright · browser_run_code'];
    // docs/plans/261116_rebel-connector-capability-261116/newly-off-tools.md, the reviewed list.
    const newlyOff = [
      'basecamp · sdk_attachments_download', 'beeper · send_media', 'gitlab · download_job_artifacts', 'gitlab · download_attachment',
      'mongodb · connect', 'mongodb · switch-connection', 'simple-browser · execute_javascript', 'playwright · browser_file_upload',
    ];
    expect(blocked.sort()).toEqual([...offBeforeS3a, ...newlyOff].sort());
    expect(restricted.sort()).toEqual([
      'playwright · browser_console_messages', 'playwright · browser_network_requests', 'playwright · browser_snapshot', 'playwright · browser_take_screenshot',
    ]);
    // Precision: no catalogued tool is blocked as unreviewed on today's catalog.
    expect(unreviewed).toEqual([]);
    // The fourth tool off before S3a is not catalogued at the pinned version, so it stays off as unreviewed.
    expect(CAPABILITY_BY_CATALOG_ID.playwright).not.toHaveProperty('browser_run_code_unsafe');
    expect(safetyBlock({ catalogId: 'playwright' }, 'browser_run_code_unsafe')).toEqual({ reason: UNREVIEWED });
  });

  it('keeps the 4 tools that were off before S3a off, by catalog id and by package', () => {
    for (const pkg of [{ catalogId: 'pipedrive' }, { args: ['-y', '@iamsamuelfraga/mcp-pipedrive@2.0.0'] }]) {
      expect(safetyBlock(pkg, 'files_upload')).toEqual({ reason: LOCAL_FS });
      expect(safetyBlock(pkg, 'deals_attach_file')).toEqual({ reason: LOCAL_FS });
    }
    for (const pkg of [{ catalogId: 'playwright' }, { args: ['@playwright/mcp@0.0.84'] }]) {
      expect(safetyBlock(pkg, 'browser_run_code')).toEqual({ reason: EXEC });
      expect(safetyBlock(pkg, 'browser_run_code_unsafe')).toEqual({ reason: UNREVIEWED });
    }
  });

  it('gives each of the four reasons word for word', () => {
    expect(safetyBlock({ catalogId: 'gitlab' }, 'download_attachment')).toEqual({ reason: LOCAL_FS });
    expect(safetyBlock({ catalogId: 'playwright' }, 'browser_take_screenshot', { filename: 'shot.png' })).toEqual({ reason: localFsArgument('filename') });
    expect(safetyBlock({ catalogId: 'simple-browser' }, 'execute_javascript')).toEqual({ reason: EXEC });
    expect(safetyBlock({ catalogId: 'mongodb' }, 'export')).toEqual({ reason: UNREVIEWED });
  });

  it('allows a permitted tool and leaves a connection that is no community connector untouched', () => {
    expect(safetyBlock({ catalogId: 'pipedrive' }, 'deals_list')).toBeUndefined();
    expect(safetyBlock({ catalogId: 'playwright' }, 'browser_navigate')).toBeUndefined();
    expect(safetyBlock(undefined, 'files_upload')).toBeUndefined();
    expect(safetyBlock({ catalogId: 'bundled-google' }, 'anything_at_all')).toBeUndefined();
    expect(safetyBlock({ args: ['-y', '@acme/unrelated-mcp@1.0.0'] }, 'files_upload')).toBeUndefined();
  });

  it('matches exact case and raw names: a differently cased or prototype name is not a classified tool', () => {
    expect(safetyBlock({ catalogId: 'pipedrive' }, 'Deals_List')).toEqual({ reason: UNREVIEWED });
    expect(safetyBlock({ catalogId: 'pipedrive' }, 'constructor')).toEqual({ reason: UNREVIEWED });
    expect(safetyBlock({ catalogId: 'Pipedrive' }, 'files_upload')).toBeUndefined();
  });

  it('a non-community catalog id no longer stops the package match (changed in S3a)', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'bundled-browser', 'browser_run_code')).toThrow(expect.objectContaining(refusal('bundled-browser', 'browser_run_code', EXEC)));
    expect(() => assertToolAccess(reg, 'bundled-browser', 'browser_navigate')).not.toThrow();
  });

  it('restricts an argument-scoped local-fs tool only when a named argument is supplied', () => {
    const playwright = { catalogId: 'playwright' };
    expect(safetyBlock(playwright, 'browser_take_screenshot')).toBeUndefined();
    expect(safetyBlock(playwright, 'browser_take_screenshot', {})).toBeUndefined();
    expect(safetyBlock(playwright, 'browser_take_screenshot', { filename: null })).toBeUndefined();
    expect(safetyBlock(playwright, 'browser_take_screenshot', { filename: undefined })).toBeUndefined();
    expect(safetyBlock(playwright, 'browser_take_screenshot', { filename: '' })).toEqual({ reason: localFsArgument('filename') });
    expect(safetyBlock(playwright, 'browser_take_screenshot', { filename: [] })).toEqual({ reason: localFsArgument('filename') });
    const reg = registry();
    expect(() => assertToolAccess(reg, 'browser-2', 'browser_snapshot', { filename: '/tmp/x' })).toThrow(expect.objectContaining(refusal('browser-2', 'browser_snapshot', localFsArgument('filename'))));
    expect(() => assertToolAccess(reg, 'browser-2', 'browser_snapshot', {})).not.toThrow();
    // Listing has no arguments, so the tool is shown as usable.
    expect(computeSecurityAnnotation('browser-2', { catalogId: 'playwright' }, 'browser_snapshot')).toEqual({});
  });

  it('keeps the shared Toolbox package\'s permitted tools on hand-added connections, telling the entries apart by --prebuilt', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'hand-looker', 'get_models')).not.toThrow();
    expect(() => assertToolAccess(reg, 'hand-bigquery', 'get_dataset_info')).not.toThrow();
    // Each variant answers to its own table: BigQuery's tool is not Looker's.
    expect(() => assertToolAccess(reg, 'hand-looker', 'get_dataset_info')).toThrow(expect.objectContaining(refusal('hand-looker', 'get_dataset_info', UNREVIEWED)));
    // Arguments that pick out no single entry keep them all: any one's permitted tool is allowed, an unclassified name is not.
    expect(() => assertToolAccess(reg, 'hand-toolbox-unknown', 'get_models')).not.toThrow();
    expect(() => assertToolAccess(reg, 'hand-toolbox-unknown', 'get_dataset_info')).not.toThrow();
    expect(() => assertToolAccess(reg, 'hand-toolbox-unknown', 'drop_everything')).toThrow(expect.objectContaining(refusal('hand-toolbox-unknown', 'drop_everything', UNREVIEWED)));
  });

  it('recognises a PyPI package launched with uvx', () => {
    expect(safetyBlock({ args: ['--native-tls', 'braze-mcp-server==1.2.0'] }, 'not_a_braze_tool')).toEqual({ reason: UNREVIEWED });
    expect(() => assertToolAccess(registry(), 'uvx-braze', 'call_function')).not.toThrow();
  });

  it('refuses a direct call, whatever the instance is called', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'work-pipedrive', 'files_upload')).toThrow(expect.objectContaining(refusal('work-pipedrive', 'files_upload', LOCAL_FS)));
    expect(() => assertToolAccess(reg, 'browser-2', 'browser_run_code')).toThrow(expect.objectContaining(refusal('browser-2', 'browser_run_code', EXEC)));
    expect(() => assertToolAccess(reg, 'work-pipedrive', 'deals_list')).not.toThrow();
    expect(() => assertToolAccess(reg, 'custom-pipedrive', 'files_upload')).not.toThrow();
  });

  it('recognises the same npm packages when a connection has no catalog id, and nothing that merely looks alike', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'imported-pipedrive', 'deals_attach_file')).toThrow(expect.objectContaining(refusal('imported-pipedrive', 'deals_attach_file', LOCAL_FS)));
    expect(() => assertToolAccess(reg, 'imported-browser', 'browser_run_code')).toThrow(expect.objectContaining(refusal('imported-browser', 'browser_run_code', EXEC)));
    expect(() => assertToolAccess(reg, 'imported-browser', 'browser_navigate')).not.toThrow();
    for (const id of ['package-flag-browser', 'short-flag-browser', 'alias-browser', 'two-packages', 'spaced-browser', 'installed-path-browser']) {
      expect(() => assertToolAccess(reg, id, 'browser_run_code')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    }
    for (const id of ['package-flag-pipedrive', 'single-dash-flag-pipedrive', 'two-packages', 'spaced-pipedrive']) {
      expect(() => assertToolAccess(reg, id, 'files_upload')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    }
    expect(() => assertToolAccess(reg, 'lookalike', 'browser_run_code')).not.toThrow();
    expect(() => assertToolAccess(reg, 'lookalike-flag', 'browser_run_code')).not.toThrow();
    expect(computeSecurityAnnotation('imported-pipedrive', reg.getPackage('imported-pipedrive'), 'files_upload')).toEqual({ blocked: true, blocked_reason: LOCAL_FS });
  });

  it('keeps the catalog id of a connection written in the legacy packages format', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safety-legacy-'));
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      packages: [{ id: 'legacy-crm', name: 'Legacy CRM', transport: 'stdio', command: 'unused', visibility: 'default', catalogId: 'pipedrive' }],
    }));
    const reg = await PackageRegistry.fromConfigFile(configPath);
    expect(reg.getPackage('legacy-crm')?.catalogId).toBe('pipedrive');
    expect(() => assertToolAccess(reg, 'legacy-crm', 'files_upload')).toThrow(expect.objectContaining(refusal('legacy-crm', 'files_upload', LOCAL_FS)));
  });

  it('stays off even when configuration explicitly allows it', () => {
    setSecurityPolicy(new SecurityPolicy({ allowedTools: ['files_upload', 'deals_attach_file', 'deals_list'], allowedPackages: ['work-pipedrive'] }));
    expect(computeSecurityAnnotation('work-pipedrive', { catalogId: 'pipedrive' }, 'deals_attach_file')).toEqual({ blocked: true, blocked_reason: LOCAL_FS });
    expect(computeSecurityAnnotation('work-pipedrive', { catalogId: 'pipedrive' }, 'deals_list')).toEqual({});
    expect(() => assertToolAccess(registry(), 'work-pipedrive', 'files_upload')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
  });

  it('backstops every route at dispatch, before any connector is started', async () => {
    const reg = registry();
    const lease = vi.spyOn(reg as any, 'acquireLease');
    await expect(reg.callTool('browser-2', 'browser_run_code', {}, { kind: 'standalone' })).rejects.toMatchObject(refusal('browser-2', 'browser_run_code', EXEC));
    await expect(reg.callTool('imported-pipedrive', 'files_upload', {}, { kind: 'standalone' })).rejects.toMatchObject(refusal('imported-pipedrive', 'files_upload', LOCAL_FS));
    await expect(reg.callTool('browser-2', 'browser_take_screenshot', { filename: 'x.png' }, { kind: 'standalone' })).rejects.toMatchObject(refusal('browser-2', 'browser_take_screenshot', localFsArgument('filename')));
    expect(lease).not.toHaveBeenCalled();
  });

  it('refuses bulk export of a blocked tool, and of an argument-scoped one given its argument', async () => {
    const result = await handleBulkExport(
      { package_id: 'work-pipedrive', tool_id: 'files_upload', args: {}, output_file: 'out.ndjson' },
      registry(),
      {} as Catalog,
    );
    expect(result).toMatchObject({ isError: true, content: [{ text: `Error: ${refusal('work-pipedrive', 'files_upload', LOCAL_FS).message}` }] });
    const scoped = await handleBulkExport(
      { package_id: 'browser-2', tool_id: 'browser_network_requests', args: { filename: 'n.txt' }, output_file: 'out.ndjson' },
      registry(),
      {} as Catalog,
    );
    expect(scoped).toMatchObject({ isError: true, content: [{ text: `Error: ${refusal('browser-2', 'browser_network_requests', localFsArgument('filename')).message}` }] });
  });

  it('hides the tool from the package endpoint\'s list and refuses calls to it', async () => {
    const reg = registry();
    vi.spyOn(reg, 'getClient').mockResolvedValue({ listTools: async () => [
      { name: 'files_upload', inputSchema: { type: 'object' } },
      { name: 'deals_list', inputSchema: { type: 'object' } },
      { name: 'files_unreviewed', inputSchema: { type: 'object' } },
    ] } as any);
    const dispatch = vi.spyOn(reg, 'callTool');
    const server = createPackageServer(reg, 'work-pipedrive');
    const client = new Client({ name: 'fictional-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    cleanup.push(() => reg.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['deals_list']);
    expect(await client.callTool({ name: 'files_upload', arguments: {} })).toMatchObject({ isError: true, content: [{ text: refusal('work-pipedrive', 'files_upload', LOCAL_FS).message }] });
    expect(await client.callTool({ name: 'files_unreviewed', arguments: {} })).toMatchObject({ isError: true, content: [{ text: refusal('work-pipedrive', 'files_unreviewed', UNREVIEWED).message }] });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('the rule across several candidate entries (a test-local capability table)', () => {
  const load = async () => {
    vi.resetModules();
    vi.doMock('../src/communityToolCapabilities.generated.js', () => ({
      CAPABILITY_BY_CATALOG_ID: {
        'acme-a': { shared_read: { capability: 'read' }, risky: { capability: 'read' }, save: { capability: 'local-fs', localFsArguments: ['path'] } },
        'acme-b': { shared_read: { capability: 'read' }, risky: { capability: 'exec' }, save: { capability: 'read' } },
        'acme-c': { risky: { capability: 'local-fs' } },
      },
      LAUNCH_VARIANTS: {
        '@acme/shared-mcp': [
          { catalogId: 'acme-a', distinguishingArgs: ['--flavour', 'a'] },
          { catalogId: 'acme-b', distinguishingArgs: ['--flavour', 'b'] },
        ],
        '@acme/other-mcp': [{ catalogId: 'acme-c', distinguishingArgs: [] }],
      },
      RETIRED_COMMUNITY_IDENTITIES: { catalogIds: [], launchVariants: {} },
    }));
    return import('../src/safetyDisabledTools.js');
  };
  afterEach(() => { vi.doUnmock('../src/communityToolCapabilities.generated.js'); });

  it('uses only the entry the arguments pick out', async () => {
    const { safetyBlock: block } = await load();
    expect(block({ args: ['@acme/shared-mcp@1.0.0', '--flavour', 'a'] }, 'risky')).toBeUndefined();
    expect(block({ args: ['@acme/shared-mcp@1.0.0', '--flavour', 'b'] }, 'risky')).toEqual({ reason: EXEC });
  });

  it('when the arguments pick out none, blocks a tool any entry classes exec, allows one some entry permits, and denies an unclassified one', async () => {
    const { safetyBlock: block } = await load();
    const ambiguous = { args: ['@acme/shared-mcp@1.0.0'] };
    expect(block(ambiguous, 'risky')).toEqual({ reason: EXEC });
    expect(block(ambiguous, 'shared_read')).toBeUndefined();
    expect(block(ambiguous, 'save')).toBeUndefined();
    expect(block(ambiguous, 'save', { path: '/tmp/x' })).toEqual({ reason: localFsArgument('path') });
    expect(block(ambiguous, 'nobody_classified_this')).toEqual({ reason: UNREVIEWED });
  });

  it('takes the union across two packages in one launch, whole-tool local-fs included', async () => {
    const { safetyBlock: block } = await load();
    expect(block({ args: ['--package=@acme/shared-mcp@1', '--flavour', 'a', '--package=@acme/other-mcp@1'] }, 'risky')).toEqual({ reason: LOCAL_FS });
  });
});

describe('connectors that left the catalog (a test-local retired list)', () => {
  const RETIRED = "Turned off for safety: this connector was removed from Rebel's catalog.";
  // As the generator would write it after `acme-gone`, `acme-c` (a shared-package variant) and the
  // whole `@acme/gone-mcp` package left; `acme-back` also stands in for an id that came back.
  const load = async () => {
    vi.resetModules();
    vi.doMock('../src/communityToolCapabilities.generated.js', () => ({
      CAPABILITY_BY_CATALOG_ID: {
        'acme-a': { shared_read: { capability: 'read' } },
        'acme-b': { shared_read: { capability: 'read' } },
        'acme-back': { back_read: { capability: 'read' } },
      },
      LAUNCH_VARIANTS: {
        '@acme/shared-mcp': [
          { catalogId: 'acme-a', distinguishingArgs: ['--flavour', 'a'] },
          { catalogId: 'acme-b', distinguishingArgs: ['--flavour', 'b'] },
        ],
        '@acme/back-mcp': [{ catalogId: 'acme-back', distinguishingArgs: [] }],
      },
      RETIRED_COMMUNITY_IDENTITIES: {
        catalogIds: ['acme-gone', 'acme-c', 'acme-back'],
        launchVariants: {
          '@acme/gone-mcp': [{ catalogId: 'acme-gone', distinguishingArgs: [] }],
          '@acme/shared-mcp': [{ catalogId: 'acme-c', distinguishingArgs: ['--flavour', 'c'] }],
          '@acme/back-mcp': [{ catalogId: 'acme-old-back', distinguishingArgs: [] }],
        },
      },
    }));
    return import('../src/safetyDisabledTools.js');
  };
  afterEach(() => { vi.doUnmock('../src/communityToolCapabilities.generated.js'); });

  it('refuses every tool of a retired catalog id, listing included', async () => {
    const { safetyBlock: block } = await load();
    expect(block({ catalogId: 'acme-gone' }, 'anything')).toEqual({ reason: RETIRED });
    expect(block({ catalogId: 'acme-gone' }, 'shared_read', {})).toEqual({ reason: RETIRED });
  });

  it('refuses a retired package, or a retired variant of a shared one, on a connection with no catalog id', async () => {
    const { safetyBlock: block } = await load();
    expect(block({ args: ['-y', '@acme/gone-mcp@1.0.0'] }, 'anything')).toEqual({ reason: RETIRED });
    expect(block({ args: ['-y', '@acme/shared-mcp@1.0.0', '--flavour', 'c'] }, 'shared_read')).toEqual({ reason: RETIRED });
    // A current variant the arguments pick out is not retired.
    expect(block({ args: ['-y', '@acme/shared-mcp@1.0.0', '--flavour', 'a'] }, 'shared_read')).toBeUndefined();
    // Arguments that pick out no variant at all keep today's rule.
    expect(block({ args: ['-y', '@acme/shared-mcp@1.0.0'] }, 'shared_read')).toBeUndefined();
  });

  it('refuses a retired variant its arguments pick out even when the only current variant left matches anything', async () => {
    // As the generator writes it once a shared package is down to one entry: that entry's selector is
    // empty, so it matches every launch of the package, including an old launch of a retired variant.
    vi.resetModules();
    vi.doMock('../src/communityToolCapabilities.generated.js', () => ({
      CAPABILITY_BY_CATALOG_ID: { 'acme-a': { shared_read: { capability: 'read' } } },
      LAUNCH_VARIANTS: { '@acme/shared-mcp': [{ catalogId: 'acme-a', distinguishingArgs: [] }] },
      RETIRED_COMMUNITY_IDENTITIES: {
        catalogIds: ['acme-b'],
        launchVariants: { '@acme/shared-mcp': [{ catalogId: 'acme-b', distinguishingArgs: ['--flavour', 'b'] }] },
      },
    }));
    const { safetyBlock: block } = await import('../src/safetyDisabledTools.js');
    expect(block({ args: ['-y', '@acme/shared-mcp@1.0.0', '--flavour', 'b'] }, 'shared_read')).toEqual({ reason: RETIRED });
    // The entry still in the catalog keeps working.
    expect(block({ args: ['-y', '@acme/shared-mcp@1.0.0', '--flavour', 'a'] }, 'shared_read')).toBeUndefined();
  });

  it('lets a current entry win: an id that came back answers to its table, by id and by package', async () => {
    const { safetyBlock: block } = await load();
    expect(block({ catalogId: 'acme-back' }, 'back_read')).toBeUndefined();
    expect(block({ catalogId: 'acme-back' }, 'not_classified')).toEqual({ reason: UNREVIEWED });
    expect(block({ args: ['@acme/back-mcp@2.0.0'] }, 'back_read')).toBeUndefined();
  });
});

describe('retirement on the real module', () => {
  it("leaves today's entries current: Looker's get_models is allowed by id and by package", () => {
    expect(safetyBlock({ catalogId: 'looker' }, 'get_models')).toBeUndefined();
    expect(safetyBlock({ args: ['-y', TOOLBOX, '--prebuilt', 'looker', '--stdio'] }, 'get_models')).toBeUndefined();
  });
});
