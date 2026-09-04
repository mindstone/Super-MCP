// R1 regression: super-mcp coerces missing/null args to {} before validation,
// so the agent's "no-arg tool with no args object" call (e.g. list_workspace_accounts)
// no longer hits the validation repair-ticket loop.
//
// See docs/plans/260517_mcp_sprint1_p0.md § Stage C.
// Telemetry: _meta.superMcp.normalisations:["coerce_undefined_args"].

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

function createMocks() {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };

  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "google_workspace_demo" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const toolSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const getTool = (packageId: string, toolId: string) =>
    packageId === "google_workspace_demo" && toolId === "list_workspace_accounts"
      ? { packageId, tool: { name: toolId, inputSchema: toolSchema }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

function parseEnvelope(response: { content: Array<{ type: string; text?: string }> }) {
  const text = (response.content[0] as { text: string }).text;
  const footerStart = text.indexOf("\n\n[");
  const sliceEnd = footerStart >= 0 ? footerStart : text.length;
  return JSON.parse(text.slice(0, sliceEnd)) as Record<string, unknown>;
}

describe("useTool R1 — undefined/null args coercion", () => {
  it("coerces undefined args to {} and forwards to downstream", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "list_workspace_accounts",
        args: undefined as unknown as Record<string, unknown>,
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({ tool_id: "list_workspace_accounts" }),
    );
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_accounts", {});

    const envelope = parseEnvelope(response);
    expect(envelope.args_used).toEqual({});

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual(["coerce_undefined_args"]);
  });

  it("coerces null args to {}", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "list_workspace_accounts",
        args: null as unknown as Record<string, unknown>,
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_accounts", {});

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual(["coerce_undefined_args"]);
  });

  it("leaves provided args untouched and does not emit normalisation breadcrumb", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "list_workspace_accounts",
        args: { include_inactive: true },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp).toBeDefined();
    expect(superMcp).not.toHaveProperty("normalisations");
  });

  it("emits breadcrumb on the dry_run egress as well", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "list_workspace_accounts",
        args: undefined as unknown as Record<string, unknown>,
        max_output_chars: null,
        dry_run: true,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    const envelope = parseEnvelope(response);
    expect(envelope.args_used).toEqual({});
    expect((envelope.result as { dry_run?: boolean } | undefined)?.dry_run).toBe(true);

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.dryRun).toBe(true);
    expect(superMcp?.normalisations).toEqual(["coerce_undefined_args"]);
  });
});
