import { describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/catalog.js';
import { handleGetToolDetails } from '../src/handlers/getToolDetails.js';
import { handleListToolPackages } from '../src/handlers/listToolPackages.js';
import { handleListTools } from '../src/handlers/listTools.js';
import { PackageRegistry } from '../src/registry.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { handleReadResource } from '../src/handlers/readResource.js';
import { handleBulkExport } from '../src/handlers/bulkExport.js';
import type { SetupIncompleteReason } from '../src/types.js';
import type { Validator } from '../src/validator.js';

const packageId = 'GoogleWorkspace-example-com';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function createBlockedPackage(reason: SetupIncompleteReason = 'missing_managed_credentials'): {
  registry: PackageRegistry;
  catalog: Catalog;
} {
  const registry = new PackageRegistry({
    mcpServers: {
      [packageId]: {
        command: process.execPath,
        args: ['this-file-must-never-be-spawned.mjs'],
        name: 'Google Workspace',
        setupStatus: {
          state: 'blocked',
          reason,
        },
      },
    },
  });
  return { registry, catalog: new Catalog(registry) };
}

function createReprovisionRequiredPackage(): {
  registry: PackageRegistry;
  catalog: Catalog;
} {
  const registry = new PackageRegistry({
    mcpServers: {
      [packageId]: {
        command: process.execPath,
        args: ['this-file-must-never-be-spawned.mjs'],
        setupStatus: {
          state: 'blocked',
          reason: 'cloud_reprovision_required',
        },
      },
    },
  });
  return { registry, catalog: new Catalog(registry) };
}

describe('setup_incomplete package carrier', () => {
  it.each(['reconnect_required', 'missing_managed_credentials', 'cloud_reprovision_required', 'future_reason'])(
    'preserves setup recovery copy and structured reason for %s across all five handlers', async (reason) => {
      const { registry, catalog } = createBlockedPackage(
        reason === 'future_reason' ? 'missing_managed_credentials' : reason as SetupIncompleteReason,
      );
      if (reason === 'future_reason') vi.spyOn(catalog, 'getPackageError').mockReturnValue(reason);
      const message = reason === 'reconnect_required'
        ? `Connection '${packageId}' needs setup. Try reconnecting it in Rebel's settings on your computer.`
        : `Package '${packageId}' is not set up on this instance. Signing in again will not fix it.`;
      const data = { package_id: packageId, status: 'setup_incomplete', reason };
      try {
        await expect(handleListTools({ package_id: packageId }, catalog, null, registry)).rejects.toMatchObject({ code: -33004, message, data });
        await expect(handleUseTool({ package_id: packageId, tool_id: 'search_emails', args: {} }, registry, catalog, {} as Validator)).rejects.toMatchObject({ code: -33004, message, data });
        await expect(handleReadResource({ uri: `ui://${packageId}/view` }, registry, catalog)).rejects.toMatchObject({ code: -33004, message, data });
        const details = await handleGetToolDetails({ tool_ids: [`${packageId}__search_emails`] }, catalog, registry);
        expect(JSON.parse(details.content[0].text).tools[0]).toMatchObject({
          ...data,
          error: 'setup_incomplete',
          description: reason === 'reconnect_required' ? message
            : `Package '${packageId}' is not set up on this instance (${reason}). Signing in again will not fix it.`,
        });
        const bulk = await handleBulkExport({ package_id: packageId, tool_id: 'search_emails', args: {}, output_file: 'emails.ndjson', items_path: 'emails' }, registry, catalog);
        expect(bulk).toMatchObject({ isError: true, content: [{ type: 'text', text: `Error: ${message}` }] });
        expect(registry.getChildStats()[0]).toMatchObject({ spawn_count: 0, connected: false });
      } finally {
        await registry.closeAll();
        vi.restoreAllMocks();
      }
    },
  );

  it('does not spawn a blocked package and reports its reason from list_tool_packages', async () => {
    const { registry, catalog } = createBlockedPackage();

    const result = await handleListToolPackages({}, registry, catalog);
    const body = JSON.parse(result.content[0].text);

    expect(body.packages).toEqual([
      expect.objectContaining({
        package_id: packageId,
        health: 'unavailable',
        tool_count: 0,
        catalog_status: 'setup_incomplete',
        catalog_error: 'missing_managed_credentials',
      }),
    ]);
    expect(registry.getChildStats()).toEqual([
      expect.objectContaining({
        package_id: packageId,
        spawn_count: 0,
        connected: false,
      }),
    ]);
  });

  it('surfaces setup_incomplete and the reason from get_tool_details', async () => {
    const { registry, catalog } = createBlockedPackage();

    const result = await handleGetToolDetails({ tool_ids: [`${packageId}__search_emails`] }, catalog, registry);
    const body = JSON.parse(result.content[0].text);

    expect(body.tools).toEqual([
      expect.objectContaining({
        package_id: packageId,
        error: 'setup_incomplete',
        status: 'setup_incomplete',
        reason: 'missing_managed_credentials',
      }),
    ]);
    expect(body.tools[0].description).toContain('Signing in again will not fix it');
    expect(registry.getChildStats()[0]).toMatchObject({
      spawn_count: 0,
      connected: false,
    });
  });

  it('returns a structured setup_incomplete package error from list_tools without spawning', async () => {
    const { registry, catalog } = createBlockedPackage();

    await expect(handleListTools({ package_id: packageId }, catalog, null, registry)).rejects.toMatchObject({
      code: -33004,
      data: {
        package_id: packageId,
        status: 'setup_incomplete',
        reason: 'missing_managed_credentials',
      },
    });
    expect(registry.getChildStats()[0]).toMatchObject({
      spawn_count: 0,
      connected: false,
    });
  });

  it('carries the reprovision-required reason without spawning', async () => {
    const { registry, catalog } = createReprovisionRequiredPackage();

    await expect(handleListTools({ package_id: packageId }, catalog, null, registry)).rejects.toMatchObject({
      code: -33004,
      data: {
        package_id: packageId,
        status: 'setup_incomplete',
        reason: 'cloud_reprovision_required',
      },
    });
    expect(registry.getChildStats()[0]).toMatchObject({
      spawn_count: 0,
      connected: false,
    });
  });
});
