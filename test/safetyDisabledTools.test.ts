import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSecurityAnnotation } from '../src/handlers/annotateToolSecurity.js';
import { handleBulkExport } from '../src/handlers/bulkExport.js';
import { createPackageServer } from '../src/packageEndpoint.js';
import { PackageRegistry } from '../src/registry.js';
import { isSafetyDisabled, SAFETY_DISABLED_REASON } from '../src/safetyDisabledTools.js';
import { SecurityPolicy, setSecurityPolicy } from '../src/security.js';
import { assertToolAccess } from '../src/toolAccess.js';
import { ERROR_CODES } from '../src/types.js';
import type { Catalog } from '../src/catalog.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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
    'installed-path-browser':{ command: 'node', args: ['/opt/tools/node_modules/@playwright/mcp/cli.js'] },
    'lookalike': { command: 'npx', args: ['-y', '@playwright/mcp-extra@1.0.0'] },
  },
} as any);

const blockedRefusal = (packageId: string, toolId: string) => ({
  code: ERROR_CODES.TOOL_BLOCKED,
  message: `Tool '${packageId}__${toolId}' is turned off for safety: it can read files or run code on this computer.`,
  data: { package_id: packageId, tool_id: toolId, blocked_reason: SAFETY_DISABLED_REASON, reason: 'security-policy' },
});

describe('safety-disabled catalog tools', () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    setSecurityPolicy(new SecurityPolicy({}));
    for (const step of cleanup.splice(0)) await step();
  });

  it('lists exactly Pipedrive\'s upload tools and Playwright\'s run-code tool', () => {
    const pipedrive = { catalogId: 'pipedrive' };
    const playwright = { catalogId: 'playwright' };
    expect(isSafetyDisabled(pipedrive, 'files_upload')).toBe(true);
    expect(isSafetyDisabled(pipedrive, 'deals_attach_file')).toBe(true);
    expect(isSafetyDisabled(playwright, 'browser_run_code')).toBe(true);
    expect(isSafetyDisabled(playwright, 'browser_run_code_unsafe')).toBe(true);
    expect(isSafetyDisabled(pipedrive, 'deals_list')).toBe(false);
    expect(isSafetyDisabled(playwright, 'browser_navigate')).toBe(false);
    expect(isSafetyDisabled(undefined, 'files_upload')).toBe(false);
  });

  it('refuses a direct call with a plain message, whatever the instance is called', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'work-pipedrive', 'files_upload')).toThrow(expect.objectContaining(blockedRefusal('work-pipedrive', 'files_upload')));
    expect(() => assertToolAccess(reg, 'browser-2', 'browser_run_code')).toThrow(expect.objectContaining(blockedRefusal('browser-2', 'browser_run_code')));
    expect(() => assertToolAccess(reg, 'work-pipedrive', 'deals_list')).not.toThrow();
    expect(() => assertToolAccess(reg, 'custom-pipedrive', 'files_upload')).not.toThrow();
  });

  it('recognises the same npm packages when a connection has no catalog id, and nothing that merely looks alike', () => {
    const reg = registry();
    expect(() => assertToolAccess(reg, 'imported-pipedrive', 'deals_attach_file')).toThrow(expect.objectContaining(blockedRefusal('imported-pipedrive', 'deals_attach_file')));
    expect(() => assertToolAccess(reg, 'imported-browser', 'browser_run_code')).toThrow(expect.objectContaining(blockedRefusal('imported-browser', 'browser_run_code')));
    expect(() => assertToolAccess(reg, 'imported-browser', 'browser_navigate')).not.toThrow();
    expect(() => assertToolAccess(reg, 'package-flag-browser', 'browser_run_code')).toThrow(expect.objectContaining(blockedRefusal('package-flag-browser', 'browser_run_code')));
    expect(() => assertToolAccess(reg, 'package-flag-pipedrive', 'files_upload')).toThrow(expect.objectContaining(blockedRefusal('package-flag-pipedrive', 'files_upload')));
    expect(() => assertToolAccess(reg, 'short-flag-browser', 'browser_run_code')).toThrow(expect.objectContaining(blockedRefusal('short-flag-browser', 'browser_run_code')));
    expect(() => assertToolAccess(reg, 'single-dash-flag-pipedrive', 'deals_attach_file')).toThrow(expect.objectContaining(blockedRefusal('single-dash-flag-pipedrive', 'deals_attach_file')));
    expect(() => assertToolAccess(reg, 'alias-browser', 'browser_run_code')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'two-packages', 'browser_run_code')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'two-packages', 'files_upload')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'spaced-browser', 'browser_run_code')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'spaced-pipedrive', 'files_upload')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'installed-path-browser', 'browser_run_code')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    expect(() => assertToolAccess(reg, 'lookalike', 'browser_run_code')).not.toThrow();
    expect(() => assertToolAccess(reg, 'lookalike-flag', 'browser_run_code')).not.toThrow();
    expect(computeSecurityAnnotation('imported-pipedrive', reg.getPackage('imported-pipedrive'), 'files_upload')).toEqual({ blocked: true, blocked_reason: SAFETY_DISABLED_REASON });
  });

  it('stays off even when configuration explicitly allows it', () => {
    setSecurityPolicy(new SecurityPolicy({ allowedTools: ['files_upload', 'deals_attach_file', 'deals_list'], allowedPackages: ['work-pipedrive'] }));
    expect(computeSecurityAnnotation('work-pipedrive', { catalogId: 'pipedrive' }, 'deals_attach_file')).toEqual({ blocked: true, blocked_reason: SAFETY_DISABLED_REASON });
    expect(computeSecurityAnnotation('work-pipedrive', { catalogId: 'pipedrive' }, 'deals_list')).toEqual({});
    expect(() => assertToolAccess(registry(), 'work-pipedrive', 'files_upload')).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
  });

  it('backstops every route at dispatch, before any connector is started', async () => {
    const reg = registry();
    const lease = vi.spyOn(reg as any, 'acquireLease');
    await expect(reg.callTool('browser-2', 'browser_run_code', {}, { kind: 'standalone' })).rejects.toMatchObject(blockedRefusal('browser-2', 'browser_run_code'));
    await expect(reg.callTool('imported-pipedrive', 'files_upload', {}, { kind: 'standalone' })).rejects.toMatchObject(blockedRefusal('imported-pipedrive', 'files_upload'));
    expect(lease).not.toHaveBeenCalled();
  });

  it('refuses bulk export of a blocked tool', async () => {
    const result = await handleBulkExport(
      { package_id: 'work-pipedrive', tool_id: 'files_upload', args: {}, output_file: 'out.ndjson' },
      registry(),
      {} as Catalog,
    );
    expect(result).toMatchObject({ isError: true, content: [{ text: `Error: ${blockedRefusal('work-pipedrive', 'files_upload').message}` }] });
  });

  it('hides the tool from the package endpoint\'s list and refuses calls to it', async () => {
    const reg = registry();
    vi.spyOn(reg, 'getClient').mockResolvedValue({ listTools: async () => [{ name: 'files_upload', inputSchema: { type: 'object' } }, { name: 'deals_list', inputSchema: { type: 'object' } }] } as any);
    const dispatch = vi.spyOn(reg, 'callTool');
    const server = createPackageServer(reg, 'work-pipedrive');
    const client = new Client({ name: 'fictional-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    cleanup.push(() => reg.closeAll(), () => server.close(), () => client.close());
    await Promise.all([server.connect(left), client.connect(right)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['deals_list']);
    expect(await client.callTool({ name: 'files_upload', arguments: {} })).toMatchObject({ isError: true, content: [{ text: blockedRefusal('work-pipedrive', 'files_upload').message }] });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
