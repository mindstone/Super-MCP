import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_NOTES_GLOBAL,
  MAX_NOTES_PER_PACKAGE,
  MAX_FILE_BYTES,
  STORE_VERSION,
  createToolNotesStore,
  makeToolNoteKey,
  normalizeNoteText,
  isValidLiveEntry,
} from "../src/toolNotes.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function futureIso(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("ToolNotesStore", () => {
  let tempDir: string;
  let notesFile: string;
  let now: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-tool-notes-"));
    notesFile = path.join(tempDir, "tool-notes.json");
    now = new Date("2026-08-17T12:00:00.000Z");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function store() {
    return createToolNotesStore(notesFile, () => now);
  }

  it("accepts a 200-character note verbatim", async () => {
    const note = "x".repeat(200);
    const normalized = normalizeNoteText(note);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const s = store();
    const result = await s.record("filesystem", "read_file", normalized.note, "hash-1");
    expect(result).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBe(note);
  });

  it("rejects a 201-character note without truncation", async () => {
    const note = "x".repeat(201);
    const normalized = normalizeNoteText(note);
    expect(normalized.ok).toBe(false);

    const s = store();
    const result = await s.record("filesystem", "read_file", note, "hash-1");
    expect(result.status).toBe("rejected");
    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBeUndefined();
    expect(await s.readRawForTests()).toBeUndefined();
  });

  it("normalizes whitespace and rejects empty notes", async () => {
    expect(normalizeNoteText("  hello   world  ")).toEqual({ ok: true, note: "hello world" });
    expect(normalizeNoteText(" \n\t  ")).toEqual({
      ok: false,
      reason: "note must be non-empty after normalization.",
    });

    const s = store();
    const normalized = normalizeNoteText("  spaced  note  ");
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const result = await s.record("filesystem", "read_file", normalized.note, "hash-1");
    expect(result).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBe("spaced note");
  });

  it("never surfaces expired, far-future, or future-written_at entries", async () => {
    const s = store();
    const expiredKey = makeToolNoteKey("pkg", "expired");
    const farFutureKey = makeToolNoteKey("pkg", "far_future");
    const futureWrittenKey = makeToolNoteKey("pkg", "future_written");

    await s.writeRawForTests(JSON.stringify({
      version: STORE_VERSION,
      notes: {
        [expiredKey]: {
          note: "expired note",
          written_at: pastIso(40, now),
          expires_at: pastIso(5, now),
          schema_hash: "hash-1",
        },
        [farFutureKey]: {
          note: "far future expiry",
          written_at: now.toISOString(),
          expires_at: futureIso(60, now),
          schema_hash: "hash-1",
        },
        [futureWrittenKey]: {
          note: "future written",
          written_at: futureIso(1, now),
          expires_at: futureIso(10, now),
          schema_hash: "hash-1",
        },
      },
    }, null, 2));

    expect(await s.lookup("pkg", "expired", "hash-1")).toBeUndefined();
    expect(await s.lookup("pkg", "far_future", "hash-1")).toBeUndefined();
    expect(await s.lookup("pkg", "future_written", "hash-1")).toBeUndefined();
    expect(await s.readSnapshot()).toEqual([]);
  });

  it("keeps colliding delimiter-shaped tuple keys distinct", async () => {
    const s = store();
    await s.record("a", "b__c", "note for a/b__c", "hash-a");
    await s.record("a__b", "c", "note for a__b/c", "hash-b");

    expect(await s.lookup("a", "b__c", "hash-a")).toBe("note for a/b__c");
    expect(await s.lookup("a__b", "c", "hash-b")).toBe("note for a__b/c");
    expect(makeToolNoteKey("a", "b__c")).not.toBe(makeToolNoteKey("a__b", "c"));
  });

  it("rejects new keys at capacity without evicting live notes", async () => {
    const s = store();
    for (let i = 0; i < MAX_NOTES_GLOBAL; i += 1) {
      const packageId = `pkg_${Math.floor(i / MAX_NOTES_PER_PACKAGE)}`;
      const result = await s.record(packageId, `tool_${i}`, `note ${i}`, `hash-${i}`);
      expect(result).toEqual({ status: "recorded" });
    }

    const rejected = await s.record("pkg_overflow", "overflow", "one too many", "hash-overflow");
    expect(rejected.status).toBe("rejected");
    expect(await s.lookup("pkg_0", "tool_0", "hash-0")).toBe("note 0");
    expect(await s.lookup("pkg_overflow", "overflow", "hash-overflow")).toBeUndefined();
  });

  it("rejects per-package additions at capacity while allowing replacement and deletion", async () => {
    const s = store();
    for (let i = 0; i < MAX_NOTES_PER_PACKAGE; i += 1) {
      const result = await s.record("filesystem", `tool_${i}`, `note ${i}`, `hash-${i}`);
      expect(result).toEqual({ status: "recorded" });
    }

    const rejected = await s.record("filesystem", "overflow", "blocked", "hash-overflow");
    expect(rejected.status).toBe("rejected");

    const replaced = await s.record("filesystem", "tool_0", "replacement note", "hash-0");
    expect(replaced).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "tool_0", "hash-0")).toBe("replacement note");

    const removed = await s.remove("filesystem", "tool_1");
    expect(removed).toEqual({ status: "removed" });

    const freed = await s.record("filesystem", "overflow", "now fits", "hash-overflow");
    expect(freed).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "overflow", "hash-overflow")).toBe("now fits");
  });

  it("leaves unknown versions byte-untouched and rejects mutations", async () => {
    const s = store();
    const unknownPayload = JSON.stringify({ version: 99, notes: {} }, null, 2);
    await s.writeRawForTests(unknownPayload);

    expect(await s.readSnapshot()).toEqual([]);
    const recordResult = await s.record("filesystem", "read_file", "should fail", "hash-1");
    expect(recordResult.status).toBe("rejected");
    expect(await s.readRawForTests()).toBe(unknownPayload);
  });

  it("treats malformed JSON as empty for reads and repairs on mutation", async () => {
    const s = store();
    await s.writeRawForTests("{ not valid json");

    expect(await s.readSnapshot()).toEqual([]);
    const result = await s.record("filesystem", "read_file", "fresh note", "hash-1");
    expect(result).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBe("fresh note");
  });

  it("does not parse or overwrite oversized files", async () => {
    const s = store();
    const oversized = " ".repeat(MAX_FILE_BYTES + 1);
    await s.writeRawForTests(oversized);

    expect(await s.readSnapshot()).toEqual([]);
    const result = await s.record("filesystem", "read_file", "blocked", "hash-1");
    expect(result.status).toBe("rejected");
    expect(await s.readRawForTests()).toBe(oversized);
  });

  it("preserves concurrent writes including simultaneous first writes", async () => {
    const sharedFile = path.join(tempDir, "shared.json");
    const a = createToolNotesStore(sharedFile, () => now);
    const b = createToolNotesStore(sharedFile, () => now);

    await Promise.all([
      a.record("filesystem", "read_file", "note A", "hash-a"),
      b.record("github", "search", "note B", "hash-b"),
    ]);

    const verify = createToolNotesStore(sharedFile, () => now);
    expect(await verify.lookup("filesystem", "read_file", "hash-a")).toBe("note A");
    expect(await verify.lookup("github", "search", "hash-b")).toBe("note B");
  });

  it("writes restrictive file modes where supported", async () => {
    if (process.platform === "win32") {
      return;
    }

    const s = store();
    await s.record("filesystem", "read_file", "mode check", "hash-1");
    const fileStat = await fs.stat(notesFile);
    const dirStat = await fs.stat(tempDir);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("rejects store writes that bypass handler normalization", async () => {
    const s = store();
    const key = makeToolNoteKey("filesystem", "read_file");
    await s.writeRawForTests(JSON.stringify({
      version: STORE_VERSION,
      notes: {
        [key]: {
          note: "line one\nline two",
          written_at: now.toISOString(),
          expires_at: futureIso(10, now),
          schema_hash: "hash-1",
        },
      },
    }, null, 2));

    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBeUndefined();
    expect(isValidLiveEntry({
      note: "line one\nline two",
      written_at: now.toISOString(),
      expires_at: futureIso(10, now),
      schema_hash: "hash-1",
    }, now)).toBe(false);

    const repaired = await s.record("filesystem", "read_file", "valid note", "hash-1");
    expect(repaired).toEqual({ status: "recorded" });
    expect(await s.lookup("filesystem", "read_file", "hash-1")).toBe("valid note");
  });
});

describe("normalizeNoteText", () => {
  it("strips control characters before measuring length", () => {
    const base = "a".repeat(200);
    const withControl = `${base}\u0007`;
    expect(normalizeNoteText(withControl)).toEqual({ ok: true, note: base });

    const tooLongAfterStrip = `${"a".repeat(201)}\u0007`;
    expect(normalizeNoteText(tooLongAfterStrip).ok).toBe(false);
  });
});
