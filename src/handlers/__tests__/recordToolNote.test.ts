import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const loggerMocks = vi.hoisted(() => ({
  setLevel: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
}));

const serverHarness = vi.hoisted(() => ({
  handlers: new Map<unknown, (...args: any[]) => unknown>(),
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

const dispatchRecordToolNote = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "dispatched" }] }),
);

vi.mock("../../logging.js", () => ({
  getLogger: () => loggerMocks,
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    setRequestHandler(
      schema: unknown,
      handler: (...args: any[]) => unknown,
    ): void {
      serverHarness.handlers.set(schema, handler);
    }

    async connect(): Promise<void> {
      await serverHarness.connect();
    }

    async close(): Promise<void> {
      await serverHarness.close();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

vi.mock("../../registry.js", () => ({
  PackageRegistry: class MockPackageRegistry {
    static async fromConfigFiles(): Promise<Record<string, unknown>> {
      return {
        startIdleReaper: vi.fn(),
        closeAll: vi.fn().mockResolvedValue(undefined),
        getPackages: vi.fn().mockReturnValue([]),
      };
    }
  },
}));

vi.mock("../../configWatcher.js", () => ({
  ConfigWatcher: class MockConfigWatcher {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

vi.mock("../index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../index.js")>();
  return {
    ...actual,
    handleRecordToolNote: dispatchRecordToolNote,
  };
});

import { handleRecordToolNote } from "../recordToolNote.js";
import { createToolNotesStore, makeToolNoteKey } from "../../toolNotes.js";
import type { Catalog } from "../../catalog.js";
import { ERROR_CODES } from "../../types.js";

function createMockCatalog(
  tools: Record<
    string,
    Record<string, { schemaHash: string; canonicalName?: string }>
  >,
): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getTool: vi
      .fn()
      .mockImplementation(async (packageId: string, toolName: string) => {
        const tool = tools[packageId]?.[toolName];
        if (!tool) return undefined;
        const canonicalName = tool.canonicalName ?? toolName;
        return {
          packageId,
          tool: {
            name: canonicalName,
            description: `Description for ${canonicalName}`,
          },
          summary: `Summary for ${canonicalName}`,
          argsSkeleton: {},
          schemaHash: tool.schemaHash,
        };
      }),
  } as unknown as Catalog;
}

function parseResponse(result: {
  content: Array<{ text: string }>;
  isError: boolean;
}) {
  return JSON.parse(result.content[0].text);
}

describe("handleRecordToolNote", () => {
  let tempDir: string;
  let notesFile: string;
  let store: ReturnType<typeof createToolNotesStore>;
  let catalog: Catalog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "super-mcp-record-note-"),
    );
    notesFile = path.join(tempDir, "tool-notes.json");
    store = createToolNotesStore(notesFile);
    catalog = createMockCatalog({
      filesystem: {
        read_file_alias: {
          canonicalName: "read_file",
          schemaHash: "hash-read-file",
        },
        read_file: { schemaHash: "hash-read-file" },
      },
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function storedNote(
    packageId: string,
    toolName: string,
  ): Promise<string | undefined> {
    return (await store.readSnapshot()).find(
      (entry) => entry.packageId === packageId && entry.toolName === toolName,
    )?.note;
  }

  it("records canonical names, replaces, and removes notes for an exact catalog tool", async () => {
    const recorded = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file_alias",
        note: "Paths must be absolute.",
      },
      catalog,
      store,
    );
    expect(parseResponse(recorded)).toEqual({ status: "recorded" });
    expect(recorded.isError).toBe(false);
    expect(await storedNote("filesystem", "read_file")).toBe(
      "Paths must be absolute.",
    );
    expect(await storedNote("filesystem", "read_file_alias")).toBeUndefined();

    const replaced = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "Use absolute paths only.",
      },
      catalog,
      store,
    );
    expect(parseResponse(replaced)).toEqual({ status: "recorded" });
    expect(await storedNote("filesystem", "read_file")).toBe(
      "Use absolute paths only.",
    );

    const removed = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        remove: true,
      },
      catalog,
      store,
    );
    expect(parseResponse(removed)).toEqual({ status: "removed" });
    expect(await storedNote("filesystem", "read_file")).toBeUndefined();
  });

  it("rejects combined discovery tool_id values with an actionable invalid-params error", async () => {
    await expect(
      handleRecordToolNote(
        {
          package_id: "filesystem",
          tool_id: "filesystem__read_file",
          note: "bad id form",
        },
        catalog,
        store,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("bare canonical tool name"),
    });
    expect(catalog.getTool).toHaveBeenCalledWith(
      "filesystem",
      "filesystem__read_file",
    );
  });

  it("records an exact canonical bare tool name containing __", async () => {
    const embeddedDelimiterCatalog = createMockCatalog({
      filesystem: {
        audit__events: { schemaHash: "hash-audit-events" },
      },
    });

    const result = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "audit__events",
        note: "Use the narrowest available event filter.",
      },
      embeddedDelimiterCatalog,
      store,
    );

    expect(parseResponse(result)).toEqual({ status: "recorded" });
    expect(result.isError).toBe(false);
    expect(await storedNote("filesystem", "audit__events")).toBe(
      "Use the narrowest available event filter.",
    );
    expect(embeddedDelimiterCatalog.getTool).toHaveBeenCalledWith(
      "filesystem",
      "audit__events",
    );
  });

  it("returns not_found when the tool does not exist in the catalog", async () => {
    const result = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "missing_tool",
        note: "won't stick",
      },
      catalog,
      store,
    );
    expect(parseResponse(result)).toEqual({ status: "not_found" });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["text", "still here"],
    ["empty string", ""],
    ["null", null],
    ["non-string", 42],
  ])("rejects remove combined with a present %s note", async (_label, note) => {
    const result = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note,
        remove: true,
      } as any,
      catalog,
      store,
    );
    expect(parseResponse(result).message).toContain("remove: true");
    expect(result.isError).toBe(true);
  });

  it.each([
    ["an unrecognized string", "yes"],
    ["a number", 1],
    ["an object", {}],
  ])("rejects %s remove value before recording", async (_label, remove) => {
    await expect(
      handleRecordToolNote(
        {
          package_id: "filesystem",
          tool_id: "read_file",
          note: "This must not be recorded.",
          remove,
        } as any,
        catalog,
        store,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("remove must be a boolean"),
    });
    expect(await storedNote("filesystem", "read_file")).toBeUndefined();
  });

  it("rejects an invalid remove value without deleting an existing note", async () => {
    await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "Keep this note.",
      },
      catalog,
      store,
    );

    await expect(
      handleRecordToolNote(
        {
          package_id: "filesystem",
          tool_id: "read_file",
          remove: 1,
        } as any,
        catalog,
        store,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining("remove must be a boolean"),
    });
    expect(await storedNote("filesystem", "read_file")).toBe(
      "Keep this note.",
    );
  });

  it("passes removal rejection reasons through without claiming not_found", async () => {
    const unsupported = JSON.stringify(
      {
        version: 99,
        notes: {
          [makeToolNoteKey("filesystem", "read_file")]: {
            note: "preserve me",
            written_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            schema_hash: "hash-read-file",
          },
        },
      },
      null,
      2,
    );
    await fs.writeFile(notesFile, unsupported);

    const result = await handleRecordToolNote(
      { package_id: "filesystem", tool_id: "read_file", remove: true },
      catalog,
      store,
    );

    expect(parseResponse(result)).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("unsupported"),
    });
    expect(result.isError).toBe(true);
    expect(await fs.readFile(notesFile, "utf8")).toBe(unsupported);
  });

  it("rejects overlong notes without truncation", async () => {
    const result = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "x".repeat(201),
      },
      catalog,
      store,
    );
    expect(parseResponse(result).status).toBe("rejected");
    expect(result.isError).toBe(true);
    expect(await storedNote("filesystem", "read_file")).toBeUndefined();
  });

  it("never includes note text in logger calls", async () => {
    const distinctiveNote = "DISTINCTIVE_NOTE_TEXT_7f341";
    await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: distinctiveNote,
      },
      catalog,
      store,
    );

    expect(
      JSON.stringify(
        Object.values(loggerMocks).flatMap((mock) => mock.mock.calls),
      ),
    ).not.toContain(distinctiveNote);
  });
});

describe("server registration contract", () => {
  it("behaviorally advertises the intended schema and dispatches record_tool_note", async () => {
    serverHarness.handlers.clear();
    dispatchRecordToolNote.mockClear();
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);

    try {
      const { startServer } = await import("../../server.js");
      await startServer({ configPaths: [], transport: "stdio" });

      const listTools = serverHarness.handlers.get(ListToolsRequestSchema);
      const callTool = serverHarness.handlers.get(CallToolRequestSchema);
      expect(listTools).toBeTypeOf("function");
      expect(callTool).toBeTypeOf("function");

      const advertised = (await listTools?.()) as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>;
      };
      expect(
        advertised.tools.find((tool) => tool.name === "record_tool_note"),
      ).toMatchObject({
        description: expect.stringContaining(
          "Notes are limited to 200 characters",
        ),
        inputSchema: {
          type: "object",
          properties: {
            package_id: { type: "string" },
            tool_id: {
              type: "string",
              description: expect.stringContaining(
                "remove only the leading '<package_id>__' prefix",
              ),
            },
            note: { type: "string" },
            remove: { type: "boolean", default: false },
          },
          required: ["package_id", "tool_id"],
        },
      });

      const args = {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "Use absolute paths.",
      };
      const dispatched = await callTool?.(
        { params: { name: "record_tool_note", arguments: args } },
        {},
      );
      expect(dispatchRecordToolNote).toHaveBeenCalledOnce();
      expect(dispatchRecordToolNote).toHaveBeenCalledWith(
        args,
        expect.anything(),
      );
      expect(dispatched).toEqual({
        content: [{ type: "text", text: "dispatched" }],
      });
    } finally {
      processOn.mockRestore();
    }
  });
});
