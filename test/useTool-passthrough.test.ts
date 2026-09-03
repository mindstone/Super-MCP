// Conformance test suite for the super-mcp passthrough contract.
// See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md.
//
// This suite locks the contract that super-mcp's use_tool outer block carries:
//   - structuredContent (hoisted from inner.structuredContent)
//   - _meta.ui (hoisted from inner._meta.ui when shaped like a usable record)
//   - _meta.superMcp (super-mcp's own telemetry namespace)
//   - _meta.materialization (super-mcp's materialisation namespace, when fired)
//   - isError (preserved from the inner tool result)
//
// The model-facing JSON envelope inside content[0].text MUST remain unchanged
// (backward-compat invariant).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";

// Mirrors the consumer-side Method 0 prefix heuristic documented in
// docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md. Keep this local to the
// standalone super-mcp package; the app exports the matching constants from
// src/main/services/agentMessageHandler.ts.
const SUPER_MCP_ENVELOPE_PREFIX_MARKER = "\"package_id\"";
const SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS = 64;

function createUseToolMocks(toolResult: unknown) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue(toolResult),
  };

  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "google_workspace_demo" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const getTool = (packageId: string, toolId: string) =>
    packageId === "google_workspace_demo" && toolId === "compose_workspace_email"
      ? { packageId, tool: { name: toolId, inputSchema: { type: "object" } }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
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

function parseEnvelope(response: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  expect(response.content[0].type).toBe("text");
  expect(typeof response.content[0].text).toBe("string");
  // Trim trailing continuation hint / large-output footer if present (separated by "\n\n[").
  const text = response.content[0].text as string;
  expect(text.slice(0, SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS)).toContain(SUPER_MCP_ENVELOPE_PREFIX_MARKER);
  const footerStart = text.indexOf("\n\n[");
  const sliceEnd = footerStart >= 0 ? footerStart : text.length;
  return JSON.parse(text.slice(0, sliceEnd)) as Record<string, unknown>;
}

const SUCCESS_INPUT = {
  package_id: "google_workspace_demo",
  tool_id: "compose_workspace_email",
  args: {},
  max_output_chars: null,
} as const;

describe("useTool passthrough contract", () => {
  let tempWorkspace: string;
  let originalWorkspacePath: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-passthrough-"));
    originalWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    process.env.REBEL_WORKSPACE_PATH = originalWorkspacePath;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("Contract — JSON use_tool envelopes expose package_id within the consumer prefix window", async () => {
    const inner = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { draftId: "abc123", subject: "Hello" },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text?.slice(0, SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS)).toContain(
      SUPER_MCP_ENVELOPE_PREFIX_MARKER,
    );
  });

  it("Case 1 — plain text result: outer block carries _meta.superMcp; no _meta.ui or structuredContent", async () => {
    const inner = {
      content: [{ type: "text", text: "ok" }],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toBeUndefined();
    expect(response._meta).toBeDefined();
    expect(response._meta.ui).toBeUndefined();
    expect(response._meta.materialization).toBeUndefined();
    expect(response._meta.superMcp).toMatchObject({
      packageId: "google_workspace_demo",
      toolId: "compose_workspace_email",
    });
    expect(typeof response._meta.superMcp.durationMs).toBe("number");
    expect(typeof response._meta.superMcp.outputChars).toBe("number");
  });

  it("strips an extracted image/jpg resource from serialized output and emits canonical image/jpeg", async () => {
    const inner = {
      content: [{
        type: "resource",
        resource: {
          uri: "file:///legacy.jpg",
          mimeType: "image/jpg",
          blob: "legacy-base64",
        },
      }],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);
    const envelope = parseEnvelope(response);

    expect(JSON.stringify(envelope)).not.toContain("legacy-base64");
    expect(response.content[1]).toEqual({
      type: "image",
      data: "legacy-base64",
      mimeType: "image/jpeg",
    });
  });

  it("Case 2 — structuredContent only: hoisted onto outer block; _meta.ui still absent", async () => {
    const inner = {
      content: [{ type: "text", text: "draft staged" }],
      structuredContent: { draftId: "abc123", subject: "Hello" },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual({ draftId: "abc123", subject: "Hello" });
    expect(response._meta.ui).toBeUndefined();
    expect(response._meta.superMcp.packageId).toBe("google_workspace_demo");
  });

  it("Case 3 — _meta.ui only: hoisted onto outer block; structuredContent absent", async () => {
    const inner = {
      content: [{ type: "text", text: "view ready" }],
      _meta: {
        ui: {
          resourceUri: "ui://google-workspace/compose-email.html",
          sourcePackageId: "google_workspace_demo",
          protocolUrl: "rebel-mcp-app://google-workspace/compose-email.html",
        },
      },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toBeUndefined();
    expect(response._meta.ui).toEqual({
      resourceUri: "ui://google-workspace/compose-email.html",
      sourcePackageId: "google_workspace_demo",
      protocolUrl: "rebel-mcp-app://google-workspace/compose-email.html",
    });
  });

  it("Case 4 — both _meta.ui AND structuredContent: both hoisted onto outer block (load-bearing email-compose case)", async () => {
    const innerStructured = {
      to: ["alice@example.com"],
      subject: "Hello from Rebel",
      body: "Thanks for the meeting today.",
    };
    const innerUi = {
      resourceUri: "ui://google-workspace/compose-email.html",
      sourcePackageId: "google_workspace_demo",
      protocolUrl: "rebel-mcp-app://google-workspace/compose-email.html",
      visibility: "user-and-llm",
    };
    const inner = {
      content: [{ type: "text", text: "Email draft prepared" }],
      structuredContent: innerStructured,
      _meta: { ui: innerUi },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(innerStructured);
    expect(response._meta.ui).toEqual(innerUi);

    // Backward-compat invariant: model-facing JSON envelope unchanged. The
    // text block must still parse as a UseToolOutput envelope.
    const envelope = parseEnvelope(response);
    expect(envelope.package_id).toBe("google_workspace_demo");
    expect(envelope.tool_id).toBe("compose_workspace_email");
    expect(envelope.telemetry).toMatchObject({ status: "ok" });
  });

  it("Case 5 — materialised path WITHOUT _meta.ui: _meta.superMcp + _meta.materialization populated", async () => {
    const inner = {
      content: [{ type: "text", text: "X".repeat(30_000) }],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response._meta.materialization).toBeDefined();
    expect(response._meta.materialization.status).toBe("materialized");
    expect(response._meta.ui).toBeUndefined();
    expect(response.structuredContent).toBeUndefined();
  });

  it("Case 6 — materialised path WITH _meta.ui + structuredContent: passthrough preserved through materialisation", async () => {
    const innerStructured = { draftId: "abc", body: "X".repeat(30_000) };
    const innerUi = {
      resourceUri: "ui://google-workspace/compose-email.html",
      sourcePackageId: "google_workspace_demo",
    };
    const inner = {
      content: [{ type: "text", text: "X".repeat(30_000) }],
      structuredContent: innerStructured,
      _meta: { ui: innerUi },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response._meta.materialization.status).toBe("materialized");
    expect(response._meta.ui).toEqual(innerUi);
    expect(response.structuredContent).toEqual(innerStructured);
  });

  it("Case 7 — error result: NOT hoisted (inner envelope is malformed; outer is a clean error envelope)", async () => {
    const inner = {
      content: [{ type: "text", text: "downstream failed" }],
      structuredContent: { error: "permission_denied" },
      _meta: {
        ui: {
          resourceUri: "ui://should-not-be-hoisted/error.html",
          sourcePackageId: "google_workspace_demo",
        },
      },
      isError: true,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response._meta.ui).toBeUndefined();
    // superMcp namespace still present even on errors.
    expect(response._meta.superMcp.packageId).toBe("google_workspace_demo");
  });

  it("Case 8 — malformed _meta.ui (missing resourceUri) is dropped", async () => {
    const inner = {
      content: [{ type: "text", text: "ok" }],
      _meta: {
        ui: {
          // No resourceUri — must NOT be hoisted.
          sourcePackageId: "google_workspace_demo",
        },
      },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response._meta.ui).toBeUndefined();
  });

  it("Case 9 — array _meta.ui is dropped (must be a non-array record)", async () => {
    const inner = {
      content: [{ type: "text", text: "ok" }],
      _meta: { ui: ["bad-shape"] as unknown as Record<string, unknown> },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    expect(response.isError).toBe(false);
    expect(response._meta.ui).toBeUndefined();
  });

  it("Case 10 — backward-compat: model-facing JSON envelope still parseable with passthrough fields present", async () => {
    const inner = {
      content: [{ type: "text", text: "view ready" }],
      structuredContent: { foo: "bar" },
      _meta: { ui: { resourceUri: "ui://x/y.html", sourcePackageId: "x" } },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(SUCCESS_INPUT, mockRegistry, mockCatalog, mockValidator);

    // Existing consumers parse content[0].text as JSON — this MUST still work.
    const envelope = parseEnvelope(response);
    expect(envelope).toMatchObject({
      package_id: "google_workspace_demo",
      tool_id: "compose_workspace_email",
      telemetry: { status: "ok" },
    });
    // The inner result is wrapped as `result` inside the JSON envelope (legacy path).
    expect(envelope.result).toBeDefined();
  });

  it("Case 11 — load-bearing acceptance: replay of compose-email envelope renders both structuredContent and _meta.ui", async () => {
    // This mirrors handleComposeWorkspaceEmail's production result shape. If
    // this test regresses, the compose-email iframe loses pre-fill — the bug is
    // back.
    const innerStructured = {
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      bcc: ["blind@example.com"],
      subject: "Project update — week 18",
      body: "Hi team,\n\nQuick update on…",
      email: "sender@example.com",
    };
    const innerUi = {
      resourceUri: "ui://google-workspace/compose-email",
    };
    const inner = {
      content: [
        {
          type: "text",
          text: `Drafting email to recipient@example.com with subject "Project update — week 18"\n\n${JSON.stringify(innerStructured)}\n\n[View: ui://google-workspace/compose-email]`,
        },
      ],
      structuredContent: innerStructured,
      _meta: { ui: innerUi },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {
          to: ["recipient@example.com"],
          cc: ["copy@example.com"],
          bcc: ["blind@example.com"],
          subject: "Project update — week 18",
          body: "Hi team,\n\nQuick update on…",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    // Structural consumers: outer-block visibility per the contract.
    expect(response.structuredContent).toEqual(innerStructured);
    expect(response._meta.ui).toEqual(innerUi);
    expect(response.structuredContent).not.toHaveProperty("body_markdown");
    expect(response.structuredContent).not.toHaveProperty("attachment_paths");

    // Legacy consumers: the JSON envelope still carries the same fields nested
    // under `result` (parseUseToolEnvelopeJson fallback path keeps working).
    const envelope = parseEnvelope(response);
    const legacyResult = envelope.result as Record<string, unknown>;
    expect(legacyResult.structuredContent).toEqual(innerStructured);
    expect((legacyResult._meta as Record<string, unknown>).ui).toEqual(innerUi);
  });

  it("Case 12 — _rebel_staged bypass: emits super-mcp staged metadata only", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({ content: [{ type: "text", text: "unused" }] });

    const response = await handleUseTool(
      {
        ...SUCCESS_INPUT,
        _rebel_staged: true,
        _rebel_staged_message: "Waiting for approval.",
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.content).toEqual([{ type: "text", text: "Waiting for approval." }]);
    expect(response.structuredContent).toBeUndefined();
    expect(response._meta.ui).toBeUndefined();
    expect(response._meta.materialization).toBeUndefined();
    expect(response._meta.superMcp).toMatchObject({
      packageId: "google_workspace_demo",
      toolId: "compose_workspace_email",
      durationMs: 0,
      staged: true,
    });
    expect(response._meta.superMcp.dryRun).toBeUndefined();
    expect(response._meta.superMcp.continuation).toBeUndefined();
  });

  it("Case 13 — dry_run bypass: emits super-mcp dryRun metadata and preserves args_used", async () => {
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createUseToolMocks({ content: [{ type: "text", text: "unused" }] });

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: { to: ["recipient@example.com"], subject: "Dry run" },
        dry_run: true,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(mockClient.callTool).not.toHaveBeenCalled();
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toBeUndefined();
    expect(response._meta.ui).toBeUndefined();
    expect(response._meta.materialization).toBeUndefined();
    expect(response._meta.superMcp).toMatchObject({
      packageId: "google_workspace_demo",
      toolId: "compose_workspace_email",
      durationMs: 0,
      dryRun: true,
    });
    expect(response._meta.superMcp.continuation).toBeUndefined();
    expect(response._meta.superMcp.staged).toBeUndefined();

    const envelope = parseEnvelope(response);
    expect(envelope.args_used).toEqual({ to: ["recipient@example.com"], subject: "Dry run" });
    expect(envelope.result).toEqual({ dry_run: true });
  });

  it("Case 14 — result_id continuation bypass: emits super-mcp continuation metadata only", async () => {
    // Materialisation would short-circuit before truncation in this suite's
    // default workspace setup; disable it so the first call seeds the
    // continuation cache through the truncation branch.
    delete process.env.REBEL_WORKSPACE_PATH;

    const innerStructured = { draftId: "abc", body: "This should not be hoisted on continuation." };
    const innerUi = {
      resourceUri: "ui://google-workspace/compose-email.html",
      sourcePackageId: "google_workspace_demo",
    };
    const inner = {
      content: [{ type: "text", text: "X".repeat(200) }],
      structuredContent: innerStructured,
      _meta: { ui: innerUi },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const firstResponse = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
        max_output_chars: 20,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(firstResponse._meta.superMcp.truncated).toBe(true);
    const resultId = firstResponse._meta.superMcp.resultId;
    expect(typeof resultId).toBe("string");

    const continuationResponse = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
        result_id: resultId,
        output_offset: 0,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(continuationResponse.isError).toBe(false);
    expect(continuationResponse.structuredContent).toBeUndefined();
    expect(continuationResponse._meta.ui).toBeUndefined();
    expect(continuationResponse._meta.materialization).toBeUndefined();
    expect(continuationResponse._meta.superMcp).toMatchObject({
      packageId: "google_workspace_demo",
      toolId: "compose_workspace_email",
      durationMs: 0,
      resultId,
      continuation: true,
    });
    expect(continuationResponse._meta.superMcp.dryRun).toBeUndefined();
    expect(continuationResponse._meta.superMcp.staged).toBeUndefined();
  });

  it("Case 15 — oversized_output safety net preserves passthrough metadata", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    const innerStructured = {
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: "Oversized structured payload",
      body: "Body text survives through the outer structuredContent hoist.",
      email: "sender@example.com",
      oversizedPayload: "Y".repeat(220_000),
    };
    const innerUi = {
      resourceUri: "ui://google-workspace/compose-email.html",
      sourcePackageId: "google_workspace_demo",
      protocolUrl: "rebel-mcp-app://google-workspace/compose-email.html",
    };
    const inner = {
      content: [{ type: "text", text: "Draft prepared." }],
      structuredContent: innerStructured,
      _meta: { ui: innerUi },
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
        max_output_chars: 100_000,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(innerStructured);
    expect(response._meta.ui).toEqual(innerUi);
    expect(response._meta.superMcp).toMatchObject({
      packageId: "google_workspace_demo",
      toolId: "compose_workspace_email",
      truncated: true,
    });
    expect(typeof response._meta.superMcp.resultId).toBe("string");
    expect(response._meta.materialization).toMatchObject({
      status: "oversized_output",
    });

    const envelope = parseEnvelope(response);
    const telemetry = envelope.telemetry as Record<string, unknown>;
    expect(response._meta.superMcp.outputChars).toBe(telemetry.output_chars);

    const originalOutputWithoutOutputChars = {
      package_id: "google_workspace_demo",
      tool_id: "compose_workspace_email",
      args_used: {},
      result: inner,
      telemetry: { duration_ms: telemetry.duration_ms, status: "ok" },
    };
    const originalOutputWithOutputChars = {
      ...originalOutputWithoutOutputChars,
      telemetry: {
        ...originalOutputWithoutOutputChars.telemetry,
        output_chars: JSON.stringify(originalOutputWithoutOutputChars, null, 2).length,
      },
    };
    expect(response._meta.materialization.originalChars).toBe(
      JSON.stringify(originalOutputWithOutputChars, null, 2).length,
    );

    expect(envelope.result).toMatchObject({
      status: "oversized_output",
      result_id: response._meta.superMcp.resultId,
    });
  });

  it("Case 16 — _meta.superMcp telemetry mirrors the JSON envelope exactly", async () => {
    delete process.env.REBEL_WORKSPACE_PATH;

    const inner = {
      content: [{ type: "text", text: "X".repeat(200) }],
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(inner);

    const response = await handleUseTool(
      {
        package_id: "google_workspace_demo",
        tool_id: "compose_workspace_email",
        args: {},
        max_output_chars: 20,
      },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    const envelope = parseEnvelope(response);
    const telemetry = envelope.telemetry as Record<string, unknown>;

    expect(response._meta.superMcp.packageId).toBe(envelope.package_id);
    expect(response._meta.superMcp.toolId).toBe(envelope.tool_id);
    expect(response._meta.superMcp.durationMs).toBe(telemetry.duration_ms);
    expect(response._meta.superMcp.resultId).toBe(telemetry.result_id);
  });
});
