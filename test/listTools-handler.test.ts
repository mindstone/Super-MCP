import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListTools } from '../src/handlers/listTools.js';
import type { Catalog } from '../src/catalog.js';
import type { PackageRegistry } from '../src/registry.js';
import { ERROR_CODES } from '../src/types.js';

// Suppress logger output during tests
vi.mock('../src/logging.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Shared mock security policy — same instance returned by every getSecurityPolicy() call
const mockSecurityPolicy = {
  isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
  isUserDisabled: vi.fn().mockReturnValue(false),
  isAdminDisabled: vi.fn().mockReturnValue(false),
};

vi.mock('../src/security.js', () => ({
  getSecurityPolicy: () => mockSecurityPolicy,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock CachedTool-like structure that buildToolInfos returns as ToolInfo */
function makeTool(name: string, opts: {
  description?: string;
  summary?: string;
  argsSkeleton?: any;
  schemaHash?: string;
  inputSchema?: any;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
} = {}) {
  return {
    package_id: 'test-pkg',
    tool_id: `test-pkg__${name}`,
    name: `test-pkg__${name}`,
    description: opts.description ?? `Description for ${name}`,
    summary: opts.summary ?? `Summary for ${name}`,
    args_skeleton: opts.argsSkeleton ?? { arg1: '<string>' },
    schema_hash: opts.schemaHash ?? `sha256:${name}hash`,
    schema: opts.inputSchema ?? { type: 'object', properties: { arg1: { type: 'string' } } },
    annotations: opts.annotations,
  };
}

/**
 * Create a mock Catalog that returns tools based on the options passed to buildToolInfos.
 * Simulates the real Catalog's behavior by omitting fields when summarize/include_schemas are false.
 */
function createMockCatalog(tools: ReturnType<typeof makeTool>[]): Catalog {
  return {
    getPackageStatus: vi.fn().mockReturnValue('ready'),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({
      retryAt: null,
      retryInMs: null,
      schedule: 'none',
    }),
    getPackageTools: vi.fn().mockReturnValue(tools.map(t => ({
      packageId: t.package_id,
      tool: {
        name: t.tool_id.replace(`${t.package_id}__`, ''),
        description: t.description,
        inputSchema: t.schema,
        annotations: t.annotations,
      },
      summary: t.summary,
      argsSkeleton: t.args_skeleton,
      schemaHash: t.schema_hash,
    }))),
  } as unknown as Catalog;
}

/** Create a minimal mock registry */
function createMockRegistry(catalogId?: string): PackageRegistry {
  return {
    getPackage: vi.fn().mockReturnValue(catalogId ? { catalogId } : undefined),
  } as unknown as PackageRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleListTools — detail parameter', () => {
  const sampleTools = [
    makeTool('send_email', {
      description: 'Send an email',
      summary: 'Sends emails via Gmail',
      argsSkeleton: { to: '<email>', subject: '<string>', body: '<string>' },
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', format: 'email' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject'],
      },
    }),
    makeTool('read_inbox', {
      description: 'Read inbox messages',
      summary: 'Lists recent inbox messages',
      argsSkeleton: { limit: '<number>' },
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    }),
  ];

  let catalog: Catalog;
  let registry: PackageRegistry;

  beforeEach(() => {
    catalog = createMockCatalog(sampleTools);
    registry = createMockRegistry();
  });

  // -----------------------------------------------------------------------
  // detail: "lite"
  // -----------------------------------------------------------------------

  it('detail: "lite" returns descriptions but NO args_skeleton and NO schema', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools).toHaveLength(2);

    for (const tool of parsed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.args_skeleton).toBeUndefined();
      expect(tool.schema).toBeUndefined();
      expect(tool.summary).toBeUndefined();
      expect(tool.schema_hash).toBeTruthy();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  // -----------------------------------------------------------------------
  // detail: "full"
  // -----------------------------------------------------------------------

  it('detail: "full" returns descriptions, args_skeleton, AND schema', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools).toHaveLength(2);

    for (const tool of parsed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeDefined();
      expect(tool.summary).toBeTruthy();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  // -----------------------------------------------------------------------
  // detail drives response shape
  // -----------------------------------------------------------------------

  it('detail: "lite" returns lite tool info', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      expect(tool.args_skeleton).toBeUndefined();
      expect(tool.schema).toBeUndefined();
      expect(tool.summary).toBeUndefined();
      expect(tool.description).toBeTruthy();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  it('detail: "full" returns full tool info', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      expect(tool.summary).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeDefined();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  // -----------------------------------------------------------------------
  // Invalid detail value
  // -----------------------------------------------------------------------

  it('invalid detail value throws INVALID_PARAMS error', async () => {
    await expect(
      handleListTools(
        { package_id: 'test-pkg', detail: 'medium' as any },
        catalog,
        null,
        registry,
      )
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('Invalid detail value: "medium"'),
    });

    // Should fail before reading the catalog snapshot.
    expect(catalog.getPackageTools).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Security annotations work with both detail levels
  // -----------------------------------------------------------------------

  it('security annotations are applied with detail: "lite"', async () => {
    // Override shared mock for this test to block a specific tool
    mockSecurityPolicy.isToolBlocked.mockImplementation((_pkgId: string, toolId: string) => {
      if (toolId === 'send_email') {
        return { blocked: true, reason: 'Blocked by security policy' };
      }
      return { blocked: false };
    });

    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'lite' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    const blockedTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__send_email');
    expect(blockedTool.blocked).toBe(true);
    expect(blockedTool.blocked_reason).toBe('Blocked by security policy');

    const normalTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__read_inbox');
    expect(normalTool.blocked).toBeUndefined();

    // Reset for other tests
    mockSecurityPolicy.isToolBlocked.mockReturnValue({ blocked: false });
  });

  it('security annotations are applied with detail: "full"', async () => {
    // Override shared mock for this test to disable a specific tool
    mockSecurityPolicy.isUserDisabled.mockImplementation((_pkgId: string, toolId: string) => {
      return toolId === 'read_inbox';
    });

    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    const disabledTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__read_inbox');
    expect(disabledTool.blocked).toBe(true);
    expect(disabledTool.user_disabled).toBe(true);

    const normalTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__send_email');
    expect(normalTool.blocked).toBeUndefined();
    expect(normalTool.schema).toBeDefined();
    expect(normalTool.args_skeleton).toBeDefined();

    // Reset for other tests
    mockSecurityPolicy.isUserDisabled.mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // Default behavior when no params are provided at all.
  // NOTE: Handler default is `detail: "lite"` since commit 12889cd (2026-04-04,
  // "fix(ux): Prioritize search_tools over list_tools... Default list_tools
  // detail to lite"). Before that the default was "full". This test locks in
  // the current lite default. The explicit "full" branch is covered separately
  // below to ensure we don't silently lose that coverage.
  // -----------------------------------------------------------------------

  it('defaults to detail: "lite" when detail is omitted', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      // Lite default: no summary, no args_skeleton, no schema — but description still included.
      expect(tool.summary).toBeUndefined();
      expect(tool.args_skeleton).toBeUndefined();
      expect(tool.schema).toBeUndefined();
      expect(tool.description).toBeTruthy();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  it('emits full tool info when detail: "full" is explicitly requested', async () => {
    const result = await handleListTools(
      { package_id: 'test-pkg', detail: 'full' },
      catalog,
      null,
      registry,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);

    for (const tool of parsed.tools) {
      // Full detail: summary + args_skeleton + schema + description all present.
      expect(tool.summary).toBeTruthy();
      expect(tool.args_skeleton).toBeDefined();
      expect(tool.schema).toBeDefined();
      expect(tool.description).toBeTruthy();
    }

    expect(catalog.getPackageTools).toHaveBeenCalledWith('test-pkg');
  });

  // -----------------------------------------------------------------------
  // MCP annotations forwarded in both detail levels
  // -----------------------------------------------------------------------

  describe('MCP annotations forwarding', () => {
    const annotatedTools = [
      makeTool('list_contacts', {
        description: 'List all contacts',
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
      makeTool('delete_contact', {
        description: 'Delete a contact',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      }),
      makeTool('search_email', {
        description: 'Search emails',
        // No annotations — should produce annotations: undefined
      }),
    ];

    it('annotations are forwarded with detail: "lite"', async () => {
      const annotatedCatalog = createMockCatalog(annotatedTools);
      const result = await handleListTools(
        { package_id: 'test-pkg', detail: 'lite' },
        annotatedCatalog,
        null,
        registry,
      );

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tools).toHaveLength(3);

      const listTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__list_contacts');
      expect(listTool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

      const deleteTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__delete_contact');
      expect(deleteTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });

      const searchTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__search_email');
      expect(searchTool.annotations).toBeUndefined();
    });

    it('annotations are forwarded with detail: "full"', async () => {
      const annotatedCatalog = createMockCatalog(annotatedTools);
      const result = await handleListTools(
        { package_id: 'test-pkg', detail: 'full' },
        annotatedCatalog,
        null,
        registry,
      );

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tools).toHaveLength(3);

      const listTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__list_contacts');
      expect(listTool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
      // Full mode also has schema and summary
      expect(listTool.schema).toBeDefined();
      expect(listTool.summary).toBeTruthy();

      const deleteTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__delete_contact');
      expect(deleteTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });

      const searchTool = parsed.tools.find((t: any) => t.tool_id === 'test-pkg__search_email');
      expect(searchTool.annotations).toBeUndefined();
    });

    it('tools without annotations produce annotations: undefined (not empty object)', async () => {
      const noAnnotationTools = [
        makeTool('basic_tool', { description: 'A basic tool' }),
      ];
      const noAnnotationCatalog = createMockCatalog(noAnnotationTools);

      const result = await handleListTools(
        { package_id: 'test-pkg', detail: 'full' },
        noAnnotationCatalog,
        null,
        registry,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tools).toHaveLength(1);
      expect(parsed.tools[0].annotations).toBeUndefined();
      expect('annotations' in parsed.tools[0]).toBe(false);
    });
  });
});
