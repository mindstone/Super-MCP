// FOX-11451: a package home that cannot be reached marks its paused error, and the
// router's tools/call catch forwards that marker as `data.home_failure`, so the host
// can count the pause. The code and the message the model reads stay the same.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageRegistry } from '../src/registry.js';
import { Catalog } from '../src/catalog.js';
import { getValidator } from '../src/validator.js';
import { handleUseTool } from '../src/handlers/useTool.js';
import { homeFailureOf } from '../src/clients/packageHomeClient.js';
import { toolCallFailure } from '../src/toolCallFailure.js';
import { ERROR_CODES } from '../src/types.js';

vi.mock('../src/logging.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), setLevel: vi.fn() }),
}));

const paused = "Your cloud isn't reachable, so Fictional Notes is paused for now. An action that was in progress may already have happened; check its outcome before trying again.";
const advice = ". Try 'get_help(topic: \"error_handling\")' for general troubleshooting.";

const registries: PackageRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.closeAll();
  vi.unstubAllGlobals();
});

/** A desktop router whose `notebook` package lives in a cloud home, with a ready catalog. */
function homedRouter() {
  const registry = new PackageRegistry({
    mcpServers: { notebook: { command: '/must-never-run', name: 'Fictional Notes' } },
    packageHomes: { notebook: { url: 'https://cloud.example.test/mcp/packages/notebook', headers: { Authorization: 'Bearer test-key-1' } } },
  } as ConstructorParameters<typeof PackageRegistry>[0]);
  registries.push(registry);
  const catalog = new Catalog(registry);
  catalog.commitReady('notebook', [{ name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], catalog.getConfigurationGeneration());
  return { registry, catalog };
}

async function routerFailure(registry: PackageRegistry, catalog: Catalog): Promise<unknown> {
  try {
    await handleUseTool({ package_id: 'notebook', tool_id: 'write_note', args: { text: 'a note' } }, registry, catalog, getValidator());
  } catch (error) {
    return { thrown: error, wire: toolCallFailure('use_tool', error, registry.getPackages({ safe_only: false })) };
  }
  throw new Error('use_tool did not fail');
}

describe('a paused package home reaches the tools/call answer with its marker', () => {
  it.each([503, 'ECONNREFUSED'])('marks the homed rethrow and forwards home_failure (%s)', async (failure) => {
    const { registry, catalog } = homedRouter();
    vi.stubGlobal('fetch', async () => {
      if (typeof failure === 'number') return new Response('Unavailable', { status: failure });
      throw Object.assign(new Error('Connection failed'), { code: failure });
    });
    const { thrown, wire } = await routerFailure(registry, catalog) as { thrown: Error; wire: unknown };

    // The producer's error survives the homed rethrow unchanged, marked and without a code.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe(paused);
    expect(homeFailureOf(thrown)).toBe('unreachable');
    expect('code' in thrown).toBe(false);
    expect(Object.keys(thrown)).not.toContain('home_failure');

    // Same code and message as before; the marker is the only addition to its data.
    expect(wire).toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: paused + advice,
      data: { tool_name: 'use_tool', home_failure: 'unreachable' },
    });
  });

  it('leaves an ordinary error without the marker', () => {
    expect(toolCallFailure('use_tool', new Error('Something broke'), [])).toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Something broke' + advice,
      data: { tool_name: 'use_tool' },
    });
    expect(homeFailureOf(new Error(paused))).toBeUndefined();
    expect(homeFailureOf({ message: paused, home_failure: 'unreachable' })).toBeUndefined();
  });

  it('leaves a structured error as it was', () => {
    const error = { code: ERROR_CODES.TOOL_NOT_FOUND, message: 'Tool not found: x in package y', data: { package_id: 'y' } };
    expect(toolCallFailure('use_tool', error, [])).toEqual({
      ...error,
      message: `${error.message}. Try 'search_tools(query: "...")' to find tools by intent, or 'list_tools(package_id: "...", detail: "lite")' to browse.`,
    });
  });
});
