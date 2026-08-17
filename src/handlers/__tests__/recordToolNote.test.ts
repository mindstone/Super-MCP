import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleRecordToolNote } from "../recordToolNote.js";
import { createToolNotesStore } from "../../toolNotes.js";
import type { Catalog } from "../../catalog.js";
import { ERROR_CODES } from "../../types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockCatalog(
  tools: Record<string, Record<string, { schemaHash: string }>>,
): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getTool: vi.fn().mockImplementation(async (packageId: string, toolName: string) => {
      const pkgTools = tools[packageId];
      const tool = pkgTools?.[toolName];
      if (!tool) return undefined;
      return {
        packageId,
        tool: { name: toolName, description: `Description for ${toolName}` },
        summary: `Summary for ${toolName}`,
        argsSkeleton: {},
        schemaHash: tool.schemaHash,
      };
    }),
  } as unknown as Catalog;
}

function parseResponse(result: { content: Array<{ text: string }>; isError: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe("handleRecordToolNote", () => {
  let tempDir: string;
  let notesFile: string;
  let store: ReturnType<typeof createToolNotesStore>;
  let catalog: Catalog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-record-note-"));
    notesFile = path.join(tempDir, "tool-notes.json");
    store = createToolNotesStore(notesFile);
    catalog = createMockCatalog({
      filesystem: {
        read_file: { schemaHash: "hash-read-file" },
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records, replaces, and removes notes for an exact catalog tool", async () => {
    const recorded = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "Paths must be absolute.",
      },
      catalog,
      store,
    );
    expect(parseResponse(recorded)).toEqual({ status: "recorded" });
    expect(recorded.isError).toBe(false);
    expect(await store.lookup("filesystem", "read_file", "hash-read-file")).toBe(
      "Paths must be absolute.",
    );

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
    expect(await store.lookup("filesystem", "read_file", "hash-read-file")).toBe(
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
    expect(await store.lookup("filesystem", "read_file", "hash-read-file")).toBeUndefined();
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

  it("rejects remove combined with note text", async () => {
    const result = await handleRecordToolNote(
      {
        package_id: "filesystem",
        tool_id: "read_file",
        note: "still here",
        remove: true,
      },
      catalog,
      store,
    );
    expect(parseResponse(result).message).toContain("remove: true");
    expect(result.isError).toBe(true);
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
    expect(await store.lookup("filesystem", "read_file", "hash-read-file")).toBeUndefined();
  });
});

describe("server registration contract", () => {
  it("advertises and dispatches record_tool_note", () => {
    const serverPath = fileURLToPath(new URL("../../server.ts", import.meta.url));
    const src = readFileSync(serverPath, "utf8");
    expect(src).toContain('name: "record_tool_note"');
    expect(src).toMatch(/case "record_tool_note":/);
    expect(src).toContain("handleRecordToolNote");
  });
});
