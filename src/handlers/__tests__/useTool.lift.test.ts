import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleUseTool } from "../useTool.js";
import { PackageRegistry } from "../../registry.js";
import { Catalog } from "../../catalog.js";
import { ValidationResult } from "../../validator.js";

type UseToolResponse = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  _meta?: Record<string, unknown>;
};

function createUseToolMocks(toolResult: unknown) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue(toolResult),
  };

  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;

  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue({ type: "object" }),
  } as unknown as Catalog;

  const mockValidator = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] } as unknown as ValidationResult),
  };

  return { mockRegistry, mockCatalog, mockValidator };
}

async function callUseTool(
  toolResult: unknown,
  overrides: Record<string, unknown> = {},
): Promise<UseToolResponse> {
  const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);
  return await handleUseTool(
    {
      package_id: "pkg1",
      tool_id: "tool1",
      args: {},
      ...overrides,
    },
    mockRegistry,
    mockCatalog,
    mockValidator,
  ) as UseToolResponse;
}

function parseLeadingJsonObject(text: string): Record<string, unknown> {
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (startIndex === -1) {
      if (/\s/.test(char)) {
        continue;
      }
      if (char !== "{") {
        throw new Error("Expected leading JSON object in response text");
      }
      startIndex = i;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(startIndex, i + 1)) as Record<string, unknown>;
      }
    }
  }

  throw new Error("Could not parse leading JSON object from response text");
}

function getLiftedMeta(response: UseToolResponse): Record<string, unknown> | undefined {
  const outerMeta = response._meta;
  if (!outerMeta || typeof outerMeta !== "object") {
    return undefined;
  }
  const unwrapped = outerMeta["rebel:unwrapped"];
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return undefined;
  }
  return unwrapped as Record<string, unknown>;
}

describe("use_tool rebel:unwrapped lift", () => {
  let originalWorkspacePath: string | undefined;
  const tempWorkspaces: string[] = [];

  beforeEach(() => {
    originalWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    delete process.env.REBEL_WORKSPACE_PATH;
  });

  afterEach(async () => {
    if (originalWorkspacePath === undefined) {
      delete process.env.REBEL_WORKSPACE_PATH;
    } else {
      process.env.REBEL_WORKSPACE_PATH = originalWorkspacePath;
    }

    for (const workspace of tempWorkspaces) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
    tempWorkspaces.length = 0;
    vi.restoreAllMocks();
  });

  async function enableTempWorkspace(): Promise<void> {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-lift-"));
    tempWorkspaces.push(workspace);
    process.env.REBEL_WORKSPACE_PATH = workspace;
  }

  it("T-LIFT-1: happy path — compose-email shape lifts both `ui.resourceUri` and `structuredContent`", async () => {
    const structured = {
      to: ["person@example.com"],
      subject: "Draft subject",
      body: "Draft body",
    };
    const response = await callUseTool({
      content: [{ type: "text", text: "Draft prepared [View: ui://google-workspace/compose-email]" }],
      _meta: {
        ui: {
          resourceUri: "ui://google-workspace/compose-email",
          protocolUrl: "https://example.test/protocol",
          csp: { sandbox: ["allow-scripts"] },
          permissions: ["read"],
        },
      },
      structuredContent: structured,
    }, {
      package_id: "google-workspace",
      tool_id: "compose_workspace_email",
      max_output_chars: null,
    });

    expect(getLiftedMeta(response)).toEqual({
      ui: {
        resourceUri: "ui://google-workspace/compose-email",
        protocolUrl: "https://example.test/protocol",
        csp: { sandbox: ["allow-scripts"] },
        permissions: ["read"],
      },
      structuredContent: structured,
    });
  });

  it("T-LIFT-2: structured-only — `structuredContent` but no `_meta.ui` → lift includes `structuredContent` only", async () => {
    const structured = { id: "structured-only", ok: true };
    const response = await callUseTool({
      content: [{ type: "text", text: "Structured payload without ui meta" }],
      structuredContent: structured,
    }, {
      max_output_chars: null,
    });

    expect(getLiftedMeta(response)).toEqual({
      structuredContent: structured,
    });
  });

  it("T-LIFT-3: ui-only — `_meta.ui` but no `structuredContent` → lift includes `ui` only", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "UI-only payload" }],
      _meta: {
        ui: {
          resourceUri: "ui://google-workspace/compose-email",
        },
      },
    }, {
      max_output_chars: null,
    });

    expect(getLiftedMeta(response)).toEqual({
      ui: {
        resourceUri: "ui://google-workspace/compose-email",
      },
    });
  });

  it.each([
    { label: "empty", meta: { ui: { resourceUri: "" } } },
    { label: "missing", meta: { ui: {} } },
    { label: "ui:///", meta: { ui: { resourceUri: "ui:///" } } },
    { label: "whitespace '   '", meta: { ui: { resourceUri: "   " } } },
    { label: "null-byte 'ui://app/\\u0000'", meta: { ui: { resourceUri: "ui://app/\u0000" } } },
    { label: "non-string resourceUri 42", meta: { ui: { resourceUri: 42 } } },
  ])("T-LIFT-4: malformed inner `_meta.ui` ($label)", async ({ meta }) => {
    const response = await callUseTool({
      content: [{ type: "text", text: "Malformed ui meta case" }],
      _meta: meta,
    }, {
      max_output_chars: null,
    });

    expect(getLiftedMeta(response)).toBeUndefined();
  });

  it("T-LIFT-5: oversized_output → lift skipped", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "small text content" }],
      _meta: { ui: { resourceUri: "ui://google-workspace/compose-email" } },
      structuredContent: { id: "oversized-case" },
      oversizedBlob: "x".repeat(260_000),
    });

    const parsedEnvelope = parseLeadingJsonObject(response.content[0].text ?? "");
    expect((parsedEnvelope.result as { status?: string }).status).toBe("oversized_output");
    expect(getLiftedMeta(response)).toBeUndefined();
  });

  it("T-LIFT-6: materialized → lift skipped", async () => {
    await enableTempWorkspace();
    const response = await callUseTool({
      content: [{ type: "text", text: "x".repeat(50_000) }],
      _meta: { ui: { resourceUri: "ui://google-workspace/compose-email" } },
      structuredContent: { id: "materialized-case" },
    });

    const parsedEnvelope = parseLeadingJsonObject(response.content[0].text ?? "");
    expect((parsedEnvelope.result as { status?: string }).status).toBe("materialized");
    expect(getLiftedMeta(response)).toBeUndefined();
  });

  it("T-LIFT-7: dry_run → lift skipped", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "unused for dry-run" }],
      _meta: { ui: { resourceUri: "ui://google-workspace/compose-email" } },
      structuredContent: { id: "dry-run-structured" },
    }, {
      dry_run: true,
    });

    const parsedEnvelope = parseLeadingJsonObject(response.content[0].text ?? "");
    expect(((parsedEnvelope.result as { dry_run?: boolean })?.dry_run)).toBe(true);
    expect(getLiftedMeta(response)).toBeUndefined();
  });

  it("T-LIFT-8: continuation response → lift skipped", async () => {
    const initialResponse = await callUseTool({
      content: [{ type: "text", text: "z".repeat(150_000) }],
    });
    const initialEnvelope = parseLeadingJsonObject(initialResponse.content[0].text ?? "");
    const resultId = (initialEnvelope.telemetry as { result_id?: string }).result_id;
    expect(typeof resultId).toBe("string");

    const continuationResponse = await callUseTool({
      content: [{ type: "text", text: "unused by continuation" }],
    }, {
      result_id: resultId,
      output_offset: 0,
    });
    const continuationEnvelope = parseLeadingJsonObject(continuationResponse.content[0].text ?? "");

    expect(continuationEnvelope.continuation).toBe(true);
    expect(getLiftedMeta(continuationResponse)).toBeUndefined();
  });

  it("T-LIFT-9: truncated success → lift still includes inner metadata", async () => {
    const structured = { id: "truncated-success", ok: true };
    const response = await callUseTool({
      content: [{ type: "text", text: "x".repeat(500) }],
      _meta: { ui: { resourceUri: "ui://google-workspace/compose-email" } },
      structuredContent: structured,
    }, {
      max_output_chars: 100,
    });

    const parsedEnvelope = parseLeadingJsonObject(response.content[0].text ?? "");
    expect((parsedEnvelope.telemetry as { output_truncated?: boolean }).output_truncated).toBe(true);
    expect(getLiftedMeta(response)).toEqual({
      ui: { resourceUri: "ui://google-workspace/compose-email" },
      structuredContent: structured,
    });
  });

  it("T-LIFT-10: large-output warning → lift still includes inner metadata", async () => {
    const structured = { id: "large-output-warning", ok: true };
    const response = await callUseTool({
      content: [{ type: "text", text: "y".repeat(160_000) }],
      _meta: { ui: { resourceUri: "ui://google-workspace/compose-email" } },
      structuredContent: structured,
    }, {
      max_output_chars: null,
    });

    expect(response.content[0].text).toContain("LARGE OUTPUT WARNING");
    expect(getLiftedMeta(response)).toEqual({
      ui: { resourceUri: "ui://google-workspace/compose-email" },
      structuredContent: structured,
    });
  });

  it("T-LIFT-11: non-MCP-Apps tool through use_tool (e.g. gmail/list_messages) → no lift", async () => {
    const response = await callUseTool({
      content: [{ type: "text", text: "Found 3 messages." }],
    }, {
      package_id: "gmail",
      tool_id: "list_messages",
      max_output_chars: null,
    });

    expect(getLiftedMeta(response)).toBeUndefined();
  });

  it("T-LIFT-12: __proto__ / constructor / prototype keys in inner `_meta.ui` are NOT propagated", async () => {
    const maliciousUi = JSON.parse(
      "{\"resourceUri\":\"ui://google-workspace/compose-email\",\"protocolUrl\":\"https://example.test/protocol\",\"__proto__\":{\"polluted\":true},\"constructor\":{\"polluted\":true},\"prototype\":{\"polluted\":true}}",
    ) as Record<string, unknown>;

    const response = await callUseTool({
      content: [{ type: "text", text: "Malicious ui keys payload" }],
      _meta: { ui: maliciousUi },
    }, {
      max_output_chars: null,
    });

    const liftedMeta = getLiftedMeta(response);
    expect(liftedMeta).toBeDefined();
    expect(liftedMeta?.ui).toEqual({
      resourceUri: "ui://google-workspace/compose-email",
      protocolUrl: "https://example.test/protocol",
    });
    expect(Object.prototype.hasOwnProperty.call(liftedMeta?.ui ?? {}, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(liftedMeta?.ui ?? {}, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(liftedMeta?.ui ?? {}, "prototype")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
