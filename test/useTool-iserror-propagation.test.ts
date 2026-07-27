import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { ValidationResult } from "../src/validator.js";
import { ERROR_CODES } from "../src/types.js";

function createUseToolMocks(toolResult: unknown) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue(toolResult),
  };

  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
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

  return { mockRegistry, mockCatalog, mockValidator, mockClient };
}

function parseEnvelope(response: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  expect(response.content[0].type).toBe("text");
  expect(typeof response.content[0].text).toBe("string");
  return JSON.parse(response.content[0].text as string) as Record<string, unknown>;
}

describe("useTool isError propagation", () => {
  let tempWorkspace: string;
  let originalWorkspacePath: string | undefined;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-iserror-"));
    originalWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  });

  afterEach(async () => {
    process.env.REBEL_WORKSPACE_PATH = originalWorkspacePath;
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("propagates inner isError=true to outer isError on normal path", async () => {
    const toolResult = {
      content: [{ type: "text", text: "inner failure payload" }],
      isError: true,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: null },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    const envelope = parseEnvelope(response);
    expect((envelope.result as { isError?: boolean }).isError).toBe(true);
  });

  it("propagates inner isError=true to outer isError on materialized path", async () => {
    const toolResult = {
      content: [{ type: "text", text: "E".repeat(30_000) }],
      isError: true,
    };
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {} },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    const envelope = parseEnvelope(response);
    expect((envelope.result as { status?: string }).status).toBe("materialized");
  });

  it("keeps dry_run responses at outer isError=false", async () => {
    const toolResult = {
      content: [{ type: "text", text: "should not execute" }],
      isError: true,
    };
    const { mockRegistry, mockCatalog, mockValidator, mockClient } = createUseToolMocks(toolResult);

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, dry_run: true },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).not.toHaveBeenCalled();
    const envelope = parseEnvelope(response);
    expect((envelope.result as { dry_run?: boolean }).dry_run).toBe(true);
  });

  it("keeps continuation error behavior unchanged", async () => {
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({
      content: [{ type: "text", text: "unused" }],
      isError: false,
    });

    const response = await handleUseTool(
      { package_id: "pkg1", tool_id: "tool1", args: {}, result_id: "abc123" },
      mockRegistry,
      mockCatalog,
      mockValidator,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toContain("output_offset is required");
  });

  it("enforces normal-path parity: outer isError mirrors parsed.result.isError", async () => {
    for (const innerIsError of [true, false]) {
      const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({
        content: [{ type: "text", text: `inner=${innerIsError}` }],
        isError: innerIsError,
      });

      const response = await handleUseTool(
        { package_id: "pkg1", tool_id: "tool1", args: {}, max_output_chars: null },
        mockRegistry,
        mockCatalog,
        mockValidator,
      );

      const envelope = parseEnvelope(response);
      const parsedInnerIsError = (envelope.result as { isError?: boolean }).isError === true;

      expect(response.isError).toBe(parsedInnerIsError);
      expect(response.isError).toBe(innerIsError);
    }
  });
});

describe("useTool connect diagnostics", () => {
  it("forwards only allowlisted connect diagnostics and never the stderr tail", async () => {
    const sensitiveStderr = "synthetic connector output must not cross the boundary";
    const connectError = Object.assign(
      new Error("Failed to connect to MCP server 'pkg1': Request timed out (-32001)"),
      {
        data: {
          stderrTail: sensitiveStderr,
          spawnObservedThisCall: true,
          spawnError: null,
          childCloseObserved: false,
          childExitCode: null,
        },
      },
    );
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({
      content: [],
    });
    vi.spyOn(mockRegistry, "callTool").mockRejectedValue(connectError);

    let thrown: unknown;
    try {
      await handleUseTool(
        { package_id: "pkg1", tool_id: "tool1", args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      data: {
        connect_summary: {
          attempt: 1,
          spawnObservedThisCall: true,
          childCloseObserved: false,
          childExitCode: null,
          stderrPresent: true,
          errorClass: "connect_timeout",
        },
      },
    });
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain("stderrTail");
    expect(serialized).not.toContain(sensitiveStderr);
    expect(serialized).not.toContain("spawnError");
  });

  it("adds a separately allowlisted first-attempt summary on double failure", async () => {
    const firstSensitiveStderr = "synthetic first-attempt connector output";
    const secondSensitiveStderr = "synthetic second-attempt connector output";
    const rawSpawnError = "spawn fictional-mcp ENOENT";
    const connectError = Object.assign(
      new Error("Failed to connect to MCP server 'pkg1': Connection closed"),
      {
        data: {
          stderrTail: secondSensitiveStderr,
          spawnObservedThisCall: false,
          spawnError: null,
          childCloseObserved: true,
          childExitCode: 17,
          firstAttempt: {
            stderrTail: firstSensitiveStderr,
            spawnObservedThisCall: true,
            spawnError: rawSpawnError,
            childCloseObserved: false,
            childExitCode: null,
          },
        },
      },
    );
    const { mockRegistry, mockCatalog, mockValidator } = createUseToolMocks({
      content: [],
    });
    vi.spyOn(mockRegistry, "callTool").mockRejectedValue(connectError);

    let thrown: unknown;
    try {
      await handleUseTool(
        { package_id: "pkg1", tool_id: "tool1", args: {} },
        mockRegistry,
        mockCatalog,
        mockValidator,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      data: {
        connect_summary: {
          attempt: 2,
          spawnObservedThisCall: false,
          childCloseObserved: true,
          childExitCode: 17,
          stderrPresent: true,
          errorClass: "connection_closed",
        },
        first_attempt_summary: {
          attempt: 1,
          spawnObservedThisCall: true,
          childCloseObserved: false,
          childExitCode: null,
          stderrPresent: true,
          errorClass: "spawn_error",
        },
      },
    });
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain("stderrTail");
    expect(serialized).not.toContain(firstSensitiveStderr);
    expect(serialized).not.toContain(secondSensitiveStderr);
    expect(serialized).not.toContain("spawnError");
    expect(serialized).not.toContain(rawSpawnError);
  });
});
