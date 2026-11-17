import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/catalog.js';
import { handleAuthenticate } from '../src/handlers/authenticate.js';
import { PackageRegistry } from '../src/registry.js';
import { assertToolAccess } from '../src/toolAccess.js';
import { ERROR_CODES } from '../src/types.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// A test-local table: fixture_read and the authenticate control are permitted, browser_run_code
// is exec, and the other names are unclassified, as a renamed or new host-code tool would be.
vi.mock('../src/communityToolCapabilities.generated.js', () => ({
  CAPABILITY_BY_CATALOG_ID: {
    playwright: { fixture_read: { capability: 'read' }, browser_run_code: { capability: 'exec' }, authenticate: { capability: 'read' } },
  },
  LAUNCH_VARIANTS: { '@playwright/mcp': [{ catalogId: 'playwright', distinguishingArgs: [] }] },
  RETIRED_COMMUNITY_IDENTITIES: { catalogIds: [], launchVariants: {} },
}));

const FIXTURE = path.resolve(__dirname, 'fixtures/fakeHostCodeServer.mjs');
const REFUSED = ['browser_run_code', 'browser_run_code_unsafe', 'browser_run_code_v2'];
const UNREVIEWED = "Turned off for safety: Rebel hasn't reviewed what this tool can do yet.";

const identities = [
  { label: 'by catalog id', entry: (journal: string) => ({ command: process.execPath, args: [FIXTURE, journal], catalogId: 'playwright' }) },
  { label: 'by package, with no catalog id', entry: (journal: string) => ({ command: process.execPath, args: [FIXTURE, journal, '@playwright/mcp@0.0.84'] }) },
];

// The registry's client, and the fresh local client a package with a home starts for itself.
const clients = [
  { label: 'the registry client', homes: undefined },
  { label: 'a homed local client', homes: { browser: { url: 'https://cloud.example.test/mcp/packages/browser' } } },
];

describe.each(identities)('a fake host-code connector identified $label', ({ entry }) => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

  const start = (options: { env?: Record<string, string>; packageHomes?: Record<string, { url: string }> } = {}) => {
    const journal = path.join(mkdtempSync(path.join(tmpdir(), 'fake-host-code-')), 'calls.log');
    const registry = new PackageRegistry({
      mcpServers: { browser: { ...entry(journal), ...(options.env ? { env: options.env } : {}) } },
      ...(options.packageHomes ? { packageHomes: options.packageHomes } : {}),
    } as any);
    cleanup.push(() => registry.closeAll());
    const calls = () => (existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean) : []);
    return { registry, calls };
  };

  it('refuses each host-code name at admission', () => {
    const { registry } = start();
    for (const tool of REFUSED) {
      expect(() => assertToolAccess(registry, 'browser', tool)).toThrow(expect.objectContaining({ code: ERROR_CODES.TOOL_BLOCKED }));
    }
    expect(() => assertToolAccess(registry, 'browser', 'fixture_read')).not.toThrow();
  });

  it('refuses each host-code name at dispatch, before it reaches the connector, and still runs the permitted tool', async () => {
    const { registry, calls } = start();
    for (const tool of REFUSED) {
      await expect(registry.callTool('browser', tool, {}, { kind: 'standalone' })).rejects.toMatchObject({ code: ERROR_CODES.TOOL_BLOCKED });
    }
    expect(calls()).toEqual([]);
    await expect(registry.callTool('browser', 'fixture_read', {}, { kind: 'standalone' })).resolves.toBeDefined();
    expect(calls()).toEqual(['fixture_read']);
  }, 30_000);

  describe.each(clients)('authenticate, through $label', ({ homes }) => {
    it('refuses the unclassified authenticate_probe it picks first, as an error, without falling through to authenticate', async () => {
      const { registry, calls } = start({ packageHomes: homes });
      const result = await handleAuthenticate({ package_id: 'browser' }, registry, new Catalog(registry));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        status: 'error',
        error: `Tool 'browser__authenticate_probe': ${UNREVIEWED}`,
        delegated_tool: 'authenticate_probe',
      });
      expect(calls()).toEqual([]);
    }, 30_000);

    it('delegates to the permitted authenticate control', async () => {
      const { registry, calls } = start({ env: { FAKE_AUTH_TOOLS: 'authenticate' }, packageHomes: homes });
      const result = await handleAuthenticate({ package_id: 'browser' }, registry, new Catalog(registry));
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe('ran authenticate');
      expect(calls()).toEqual(['authenticate']);
    }, 30_000);
  });
});
