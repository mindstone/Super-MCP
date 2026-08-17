import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const lockTestState = vi.hoisted(() => ({
  compromiseNext: false,
  contentionNext: false,
  errnoNext: undefined as string | undefined,
  beforeLockNext: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => loggerMocks,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  const lock = actual.default.lock.bind(actual.default);
  return {
    default: {
      ...actual.default,
      lock: vi.fn(async (file: string, options: Record<string, unknown>) => {
        if (lockTestState.contentionNext) {
          lockTestState.contentionNext = false;
          throw Object.assign(new Error("lock busy"), { code: "ELOCKED" });
        }
        if (lockTestState.errnoNext) {
          const code = lockTestState.errnoNext;
          lockTestState.errnoNext = undefined;
          throw Object.assign(new Error("filesystem failure"), { code });
        }
        const beforeLock = lockTestState.beforeLockNext;
        lockTestState.beforeLockNext = undefined;
        await beforeLock?.();
        const release = await lock(file, options);
        if (lockTestState.compromiseNext) {
          lockTestState.compromiseNext = false;
          const onCompromised = options.onCompromised as
            | ((error: Error) => void)
            | undefined;
          onCompromised?.(
            Object.assign(new Error("lock compromised"), { code: "ESTALE" }),
          );
        }
        return release;
      }),
    },
  };
});

import {
  MAX_FILE_BYTES,
  MAX_KEY_COMPONENT_CHARS,
  MAX_NOTES_GLOBAL,
  MAX_NOTES_PER_PACKAGE,
  MAX_SCHEMA_HASH_CHARS,
  STORE_VERSION,
  createToolNotesStore,
  makeToolNoteKey,
  normalizeNoteText,
  type LiveToolNote,
  type ToolNoteEntry,
} from "../src/toolNotes.js";
import { ERROR_CODES } from "../src/types.js";

interface ChildWriter {
  child: ChildProcess;
  ready: Promise<void>;
  completed: Promise<void>;
}

function spawnChildWriter(
  scriptPath: string,
  args: readonly string[],
  isolatedHome: string,
): ChildWriter {
  const child = fork(scriptPath, [...args], {
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let stderr = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.on("message", (message) => {
      if (!readySettled && message === "READY") {
        readySettled = true;
        resolveReady();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error("child writer exited before signalling readiness"));
        }
        resolve();
        return;
      }

      const failure = new Error(
        `child writer exited with code ${String(code)} and signal ${String(signal)}: ${stderr.trim()}`,
      );
      if (!readySettled) {
        readySettled = true;
        rejectReady(failure);
      }
      reject(failure);
    });
  });

  // A spawn failure rejects both coordination promises; keep the completion
  // branch observed while the caller handles the readiness failure.
  void completed.catch(() => undefined);

  return { child, ready, completed };
}

function isChildProcessUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ["EACCES", "ENOENT", "ENOSYS", "EPERM"].includes(code ?? "");
}

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
    lockTestState.compromiseNext = false;
    lockTestState.contentionNext = false;
    lockTestState.errnoNext = undefined;
    lockTestState.beforeLockNext = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function store(filePath = notesFile) {
    return createToolNotesStore(filePath, () => now);
  }

  function liveEntry(note: string, schemaHash = "hash-1"): ToolNoteEntry {
    return {
      note,
      written_at: now.toISOString(),
      expires_at: futureIso(10, now),
      schema_hash: schemaHash,
    };
  }

  async function writeRaw(
    content: string,
    filePath = notesFile,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, { mode: 0o600 });
  }

  async function readRaw(filePath = notesFile): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  function findNote(
    snapshot: readonly LiveToolNote[],
    packageId: string,
    toolName: string,
  ): LiveToolNote | undefined {
    return snapshot.find(
      (entry) => entry.packageId === packageId && entry.toolName === toolName,
    );
  }

  async function readPersistedNotes(): Promise<Record<string, ToolNoteEntry>> {
    const raw = await readRaw();
    expect(raw).toBeDefined();
    return (JSON.parse(raw ?? "{}") as { notes: Record<string, ToolNoteEntry> })
      .notes;
  }

  it("accepts a 200-character note verbatim", async () => {
    const note = "x".repeat(200);
    const normalized = normalizeNoteText(note);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const subject = store();
    const result = await subject.record(
      "filesystem",
      "read_file",
      normalized.note,
      "hash-1",
    );
    expect(result).toEqual({ status: "recorded" });
    expect(
      findNote(await subject.readSnapshot(), "filesystem", "read_file")?.note,
    ).toBe(note);
  });

  it("rejects a 201-character note without truncation", async () => {
    const note = "x".repeat(201);
    expect(normalizeNoteText(note).ok).toBe(false);

    const subject = store();
    const result = await subject.record(
      "filesystem",
      "read_file",
      note,
      "hash-1",
    );
    expect(result.status).toBe("rejected");
    expect(await subject.readSnapshot()).toEqual([]);
    expect(await readRaw()).toBeUndefined();
  });

  it("normalizes word-separating whitespace before stripping remaining controls", () => {
    expect(normalizeNoteText("  hello\n\tworld\u2028again  ")).toEqual({
      ok: true,
      note: "hello world again",
    });
    expect(normalizeNoteText("safe\u0085text\u202E")).toEqual({
      ok: true,
      note: "safetext",
    });
    expect(normalizeNoteText(" \n\t  ")).toEqual({
      ok: false,
      reason: "note must be non-empty after normalization.",
    });
  });

  it("never surfaces expired, far-future, or future-written_at entries", async () => {
    const subject = store();
    await writeRaw(
      JSON.stringify(
        {
          version: STORE_VERSION,
          notes: {
            [makeToolNoteKey("pkg", "expired")]: {
              note: "expired note",
              written_at: pastIso(40, now),
              expires_at: pastIso(5, now),
              schema_hash: "hash-1",
            },
            [makeToolNoteKey("pkg", "far_future")]: {
              note: "far future expiry",
              written_at: now.toISOString(),
              expires_at: futureIso(60, now),
              schema_hash: "hash-1",
            },
            [makeToolNoteKey("pkg", "future_written")]: {
              note: "future written",
              written_at: futureIso(1, now),
              expires_at: futureIso(10, now),
              schema_hash: "hash-1",
            },
          },
        },
        null,
        2,
      ),
    );

    expect(await subject.readSnapshot()).toEqual([]);
    await vi.waitFor(async () => {
      expect(await readPersistedNotes()).toEqual({});
    });
  });

  it("keeps colliding delimiter-shaped tuple keys distinct", async () => {
    const subject = store();
    await subject.record("a", "b__c", "note for a/b__c", "hash-a");
    await subject.record("a__b", "c", "note for a__b/c", "hash-b");

    const snapshot = await subject.readSnapshot();
    expect(findNote(snapshot, "a", "b__c")?.note).toBe("note for a/b__c");
    expect(findNote(snapshot, "a__b", "c")?.note).toBe("note for a__b/c");
    expect(makeToolNoteKey("a", "b__c")).not.toBe(makeToolNoteKey("a__b", "c"));
  });

  it("rejects non-canonical, empty, and overlong tuple components", async () => {
    const subject = store();
    const alternateKey = '[ "pkg", "tool" ]';
    await writeRaw(
      JSON.stringify({
        version: STORE_VERSION,
        notes: { [alternateKey]: liveEntry("hidden") },
      }),
    );

    expect(await subject.readSnapshot()).toEqual([]);
    expect((await subject.record("", "tool", "note", "hash-1")).status).toBe(
      "rejected",
    );
    expect((await subject.remove("pkg", "")).status).toBe("rejected");
    expect(
      (
        await subject.record(
          "p".repeat(MAX_KEY_COMPONENT_CHARS + 1),
          "tool",
          "note",
          "hash-1",
        )
      ).status,
    ).toBe("rejected");
    await vi.waitFor(async () => {
      expect(await readPersistedNotes()).toEqual({});
    });
  });

  it("bounds schema hashes on mutation and persisted load", async () => {
    const subject = store();
    expect(
      (
        await subject.record(
          "pkg",
          "tool",
          "note",
          "h".repeat(MAX_SCHEMA_HASH_CHARS + 1),
        )
      ).status,
    ).toBe("rejected");

    await writeRaw(
      JSON.stringify({
        version: STORE_VERSION,
        notes: {
          [makeToolNoteKey("pkg", "tool")]: liveEntry(
            "hidden",
            "h".repeat(MAX_SCHEMA_HASH_CHARS + 1),
          ),
        },
      }),
    );
    expect(await subject.readSnapshot()).toEqual([]);
  });

  it("rejects new keys at global capacity without evicting live notes", async () => {
    const subject = store();
    for (let index = 0; index < MAX_NOTES_GLOBAL; index += 1) {
      const packageId = `pkg_${Math.floor(index / MAX_NOTES_PER_PACKAGE)}`;
      const result = await subject.record(
        packageId,
        `tool_${index}`,
        `note ${index}`,
        `hash-${index}`,
      );
      expect(result).toEqual({ status: "recorded" });
    }

    const rejected = await subject.record(
      "pkg_overflow",
      "overflow",
      "one too many",
      "hash-overflow",
    );
    expect(rejected.status).toBe("rejected");
    const snapshot = await subject.readSnapshot();
    expect(snapshot).toHaveLength(MAX_NOTES_GLOBAL);
    expect(findNote(snapshot, "pkg_0", "tool_0")?.note).toBe("note 0");
    expect(findNote(snapshot, "pkg_overflow", "overflow")).toBeUndefined();
  });

  it("allows replacement and deletion at capacity, then permits a freed slot", async () => {
    const subject = store();
    for (let index = 0; index < MAX_NOTES_PER_PACKAGE; index += 1) {
      expect(
        await subject.record(
          "filesystem",
          `tool_${index}`,
          `note ${index}`,
          `hash-${index}`,
        ),
      ).toEqual({ status: "recorded" });
    }

    expect(
      (
        await subject.record(
          "filesystem",
          "overflow",
          "blocked",
          "hash-overflow",
        )
      ).status,
    ).toBe("rejected");
    expect(
      await subject.record(
        "filesystem",
        "tool_0",
        "replacement note",
        "hash-0",
      ),
    ).toEqual({ status: "recorded" });
    expect(await subject.remove("filesystem", "tool_1")).toEqual({
      status: "removed",
    });
    expect(
      await subject.record(
        "filesystem",
        "overflow",
        "now fits",
        "hash-overflow",
      ),
    ).toEqual({ status: "recorded" });

    const snapshot = await subject.readSnapshot();
    expect(findNote(snapshot, "filesystem", "tool_0")?.note).toBe(
      "replacement note",
    );
    expect(findNote(snapshot, "filesystem", "overflow")?.note).toBe("now fits");
  });

  it("hides a stable bounded subset of hand-edited over-quota files and compacts it", async () => {
    const subject = store();
    const notes: Record<string, ToolNoteEntry> = {};
    for (let index = 0; index <= MAX_NOTES_PER_PACKAGE; index += 1) {
      notes[makeToolNoteKey("pkg", `tool_${String(index).padStart(2, "0")}`)] =
        liveEntry(`note ${index}`);
    }
    await writeRaw(JSON.stringify({ version: STORE_VERSION, notes }));

    const snapshot = await subject.readSnapshot();
    expect(snapshot).toHaveLength(MAX_NOTES_PER_PACKAGE);
    expect(snapshot.map((entry) => entry.toolName)).toEqual(
      Array.from(
        { length: MAX_NOTES_PER_PACKAGE },
        (_, index) => `tool_${String(index).padStart(2, "0")}`,
      ),
    );
    await vi.waitFor(async () => {
      expect(Object.keys(await readPersistedNotes())).toHaveLength(
        MAX_NOTES_PER_PACKAGE,
      );
    });
  });

  it("preserves a replaced tail entry during read-triggered over-quota compaction", async () => {
    const reader = store();
    const writer = store();
    const notes: Record<string, ToolNoteEntry> = {};
    const tailToolName = `tool_${MAX_NOTES_PER_PACKAGE}`;
    for (let index = 0; index <= MAX_NOTES_PER_PACKAGE; index += 1) {
      notes[makeToolNoteKey("pkg", `tool_${String(index).padStart(2, "0")}`)] =
        liveEntry(`note ${index}`);
    }
    await writeRaw(JSON.stringify({ version: STORE_VERSION, notes }));

    let replacement: Promise<void> | undefined;
    lockTestState.beforeLockNext = async () => {
      replacement = writer
        .record("pkg", tailToolName, "replacement survives", "hash-1")
        .then((result) => {
          expect(result).toEqual({ status: "recorded" });
        });
      await replacement;
    };

    const snapshot = await reader.readSnapshot();
    expect(findNote(snapshot, "pkg", tailToolName)).toBeUndefined();
    await vi.waitFor(() => expect(replacement).toBeDefined());
    await replacement;

    await vi.waitFor(async () => {
      const persisted = await readPersistedNotes();
      expect(Object.keys(persisted)).toHaveLength(MAX_NOTES_PER_PACKAGE);
      expect(persisted[makeToolNoteKey("pkg", tailToolName)]?.note).toBe(
        "replacement survives",
      );
    });
  });

  it("limits over-quota mutations to replacement and deletion until a slot is free", async () => {
    const subject = store();
    const notes: Record<string, ToolNoteEntry> = {};
    for (let index = 0; index <= MAX_NOTES_PER_PACKAGE; index += 1) {
      notes[makeToolNoteKey("pkg", `tool_${String(index).padStart(2, "0")}`)] =
        liveEntry(`note ${index}`);
    }
    await writeRaw(JSON.stringify({ version: STORE_VERSION, notes }));

    expect(
      (await subject.record("pkg", "new", "blocked", "hash-1")).status,
    ).toBe("rejected");
    expect(
      await subject.record("pkg", "tool_25", "replacement", "hash-1"),
    ).toEqual({
      status: "recorded",
    });
    expect(await subject.remove("pkg", "tool_00")).toEqual({
      status: "removed",
    });
    expect(
      (await subject.record("pkg", "new", "still full", "hash-1")).status,
    ).toBe("rejected");
    expect(await subject.remove("pkg", "tool_01")).toEqual({
      status: "removed",
    });
    expect(await subject.record("pkg", "new", "now fits", "hash-1")).toEqual({
      status: "recorded",
    });
  });

  it("caps globally over-quota loaded entries at 200", async () => {
    const subject = store();
    const notes: Record<string, ToolNoteEntry> = {};
    for (let index = 0; index <= MAX_NOTES_GLOBAL; index += 1) {
      const packageId = `pkg_${Math.floor(index / MAX_NOTES_PER_PACKAGE)}`;
      notes[
        makeToolNoteKey(packageId, `tool_${String(index).padStart(3, "0")}`)
      ] = liveEntry(`note ${index}`);
    }
    await writeRaw(JSON.stringify({ version: STORE_VERSION, notes }));

    expect(await subject.readSnapshot()).toHaveLength(MAX_NOTES_GLOBAL);
    await vi.waitFor(async () => {
      expect(Object.keys(await readPersistedNotes())).toHaveLength(
        MAX_NOTES_GLOBAL,
      );
    });
  });

  it("does not delete a concurrent replacement during snapshot-based cleanup", async () => {
    const subject = store();
    await subject.record("filesystem", "read_file", "old note", "hash-1");
    const staleSnapshot = await subject.readSnapshot();
    await subject.record("filesystem", "read_file", "new note", "hash-1");

    await subject.compactSnapshotEntries(staleSnapshot);

    expect(
      findNote(await subject.readSnapshot(), "filesystem", "read_file")?.note,
    ).toBe("new note");
  });

  it("leaves unknown versions byte-untouched and rejects record and removal", async () => {
    const subject = store();
    const unknownPayload = JSON.stringify(
      {
        version: 99,
        notes: { [makeToolNoteKey("pkg", "tool")]: liveEntry("secret") },
      },
      null,
      2,
    );
    await writeRaw(unknownPayload);

    expect(await subject.readSnapshot()).toEqual([]);
    expect(
      (await subject.record("pkg", "tool", "should fail", "hash-1")).status,
    ).toBe("rejected");
    expect(await subject.remove("pkg", "tool")).toMatchObject({
      status: "rejected",
    });
    expect(await readRaw()).toBe(unknownPayload);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain("secret");
  });

  it("treats malformed and deeply nested JSON as empty without breaking reads", async () => {
    const subject = store();
    await writeRaw("{ not valid json");
    expect(await subject.readSnapshot()).toEqual([]);

    const deeplyNested = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    await writeRaw(deeplyNested);
    expect(await subject.readSnapshot()).toEqual([]);

    expect(
      await subject.record("filesystem", "read_file", "fresh note", "hash-1"),
    ).toEqual({
      status: "recorded",
    });
    expect(
      findNote(await subject.readSnapshot(), "filesystem", "read_file")?.note,
    ).toBe("fresh note");
  });

  it("makes non-ENOENT read failures total while keeping mutations fail-closed", async () => {
    await fs.mkdir(notesFile);
    const subject = store();

    expect(await subject.readSnapshot()).toEqual([]);
    await expect(
      subject.record("pkg", "tool", "note", "hash-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not be read"),
      expect.objectContaining({ file_path: notesFile }),
    );
  });

  it("does not parse or overwrite oversized files on record or removal", async () => {
    const subject = store();
    const oversized = " ".repeat(MAX_FILE_BYTES + 64 * 1024);
    await writeRaw(oversized);

    expect(await subject.readSnapshot()).toEqual([]);
    expect(
      (await subject.record("filesystem", "read_file", "blocked", "hash-1"))
        .status,
    ).toBe("rejected");
    expect(await subject.remove("filesystem", "read_file")).toMatchObject({
      status: "rejected",
    });
    expect(await readRaw()).toBe(oversized);
  });

  it("rejects serialized updates over the byte ceiling before replacing existing bytes", async () => {
    const subject = store();
    const key = makeToolNoteKey("pkg", "existing");
    const payload = {
      version: STORE_VERSION,
      notes: {
        [key]: {
          ...liveEntry("existing note"),
          padding: "",
        },
      },
    };
    const emptyPaddingBytes = Buffer.byteLength(JSON.stringify(payload));
    payload.notes[key].padding = "x".repeat(
      MAX_FILE_BYTES - emptyPaddingBytes - 1,
    );
    const original = JSON.stringify(payload);
    expect(Buffer.byteLength(original)).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2))).toBeGreaterThan(
      MAX_FILE_BYTES,
    );
    await writeRaw(original);

    const result = await subject.record(
      "pkg",
      "new",
      "crosses threshold",
      "hash-1",
    );

    expect(result).toMatchObject({ status: "rejected" });
    expect(await readRaw()).toBe(original);
  });

  it("maps contention to retryable rejection and unknown errnos to numeric internal errors", async () => {
    const subject = store();
    lockTestState.contentionNext = true;
    await expect(
      subject.record("pkg", "tool", "note", "hash-1"),
    ).resolves.toEqual({
      status: "rejected",
      reason: expect.stringContaining("retry"),
    });

    lockTestState.errnoNext = "EACCES";
    await expect(
      subject.record("pkg", "tool", "note", "hash-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  });

  it("records lock compromise without writing the pending note", async () => {
    const subject = store();
    lockTestState.compromiseNext = true;

    const result = await subject.record(
      "pkg",
      "tool",
      "must not persist",
      "hash-1",
    );

    expect(result).toEqual({
      status: "rejected",
      reason: expect.stringContaining("retry"),
    });
    expect(await subject.readSnapshot()).toEqual([]);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(
      "must not persist",
    );
  });

  it("preserves concurrent writes including simultaneous first writes", async () => {
    const sharedFile = path.join(tempDir, "shared.json");
    const first = store(sharedFile);
    const second = store(sharedFile);

    await Promise.all([
      first.record("filesystem", "read_file", "note A", "hash-a"),
      second.record("github", "search", "note B", "hash-b"),
    ]);

    const snapshot = await store(sharedFile).readSnapshot();
    expect(findNote(snapshot, "filesystem", "read_file")?.note).toBe("note A");
    expect(findNote(snapshot, "github", "search")?.note).toBe("note B");
  });

  it("preserves concurrent writes from two child processes", async (context) => {
    const sharedFile = path.join(tempDir, "child-process-shared.json");
    const childScript = path.join(tempDir, "record-tool-note.mjs");
    const toolNotesModuleUrl = new URL(
      "../dist/toolNotes.js",
      import.meta.url,
    ).href;
    await fs.writeFile(
      childScript,
      `
        const [moduleUrl, storeFile, nowIso, packageId, toolName, note, schemaHash] = process.argv.slice(2);
        try {
          const { createToolNotesStore } = await import(moduleUrl);
          const subject = createToolNotesStore(storeFile, () => new Date(nowIso));
          if (!process.send) {
            throw new Error("child IPC channel is unavailable");
          }
          process.send("READY");
          await new Promise((resolve) => {
            process.once("message", resolve);
          });
          const result = await subject.record(packageId, toolName, note, schemaHash);
          if (result.status !== "recorded") {
            throw new Error("record rejected: " + JSON.stringify(result));
          }
        } catch (error) {
          process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
          process.exitCode = 1;
        } finally {
          process.disconnect?.();
        }
      `,
    );

    const commonArgs = [toolNotesModuleUrl, sharedFile, now.toISOString()];
    const writers = [
      spawnChildWriter(
        childScript,
        [...commonArgs, "filesystem", "read_file", "note A", "hash-a"],
        tempDir,
      ),
      spawnChildWriter(
        childScript,
        [...commonArgs, "github", "search", "note B", "hash-b"],
        tempDir,
      ),
    ];

    try {
      await Promise.all(writers.map((writer) => writer.ready));
      await Promise.all(
        writers.map(
          (writer) =>
            new Promise<void>((resolve, reject) => {
              writer.child.send("GO", (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
      await Promise.all(writers.map((writer) => writer.completed));
    } catch (error) {
      if (isChildProcessUnavailable(error)) {
        context.skip();
      }
      throw error;
    } finally {
      for (const writer of writers) {
        if (writer.child.exitCode === null && writer.child.signalCode === null) {
          writer.child.kill();
        }
      }
      await Promise.allSettled(writers.map((writer) => writer.completed));
    }

    const snapshot = await store(sharedFile).readSnapshot();
    expect(findNote(snapshot, "filesystem", "read_file")?.note).toBe("note A");
    expect(findNote(snapshot, "github", "search")?.note).toBe("note B");
  });

  it("writes restrictive modes on store-created files and nested directories", async () => {
    if (process.platform === "win32") {
      return;
    }

    const nestedDir = path.join(tempDir, "store-created", "nested");
    notesFile = path.join(nestedDir, "tool-notes.json");
    const subject = store();
    await subject.record("filesystem", "read_file", "mode check", "hash-1");

    const fileStat = await fs.stat(notesFile);
    const dirStat = await fs.stat(nestedDir);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("rejects direct-file note text that bypasses handler normalization", async () => {
    const subject = store();
    await writeRaw(
      JSON.stringify({
        version: STORE_VERSION,
        notes: {
          [makeToolNoteKey("filesystem", "newline")]:
            liveEntry("line one\nline two"),
          [makeToolNoteKey("filesystem", "separator")]: liveEntry(
            "line one\u2028line two",
          ),
        },
      }),
    );

    expect(await subject.readSnapshot()).toEqual([]);
    expect(
      await subject.record("filesystem", "newline", "valid note", "hash-1"),
    ).toEqual({ status: "recorded" });
    expect(
      findNote(await subject.readSnapshot(), "filesystem", "newline")?.note,
    ).toBe("valid note");
  });
});

describe("normalizeNoteText", () => {
  it("strips controls before measuring the normalized length", () => {
    const base = "a".repeat(200);
    expect(normalizeNoteText(`${base}\u0007`)).toEqual({
      ok: true,
      note: base,
    });
    expect(normalizeNoteText(`${"a".repeat(201)}\u0007`).ok).toBe(false);
  });
});
