import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import properLockfile from "proper-lockfile";
import { getLogger } from "./logging.js";

const logger = getLogger();

export const NOTE_MAX_CHARS = 200;
export const NOTE_TTL_DAYS = 30;
export const MAX_NOTES_PER_PACKAGE = 25;
export const MAX_NOTES_GLOBAL = 200;
export const MAX_FILE_BYTES = 512 * 1024;
export const STORE_VERSION = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ToolNoteEntry {
  note: string;
  written_at: string;
  expires_at: string;
  schema_hash: string;
}

export interface ToolNotesFile {
  version: number;
  notes: Record<string, ToolNoteEntry>;
}

export interface LiveToolNote {
  packageId: string;
  toolName: string;
  note: string;
  schema_hash: string;
}

type ReadState =
  | { kind: "ok"; data: ToolNotesFile }
  | { kind: "empty"; reason: "missing" | "malformed" }
  | { kind: "oversized" }
  | { kind: "unknown_version" };

export type RecordNoteResult =
  | { status: "recorded" }
  | { status: "rejected"; reason: string };

export type RemoveNoteResult =
  | { status: "removed" }
  | { status: "not_found" };

/** Shared tuple key — injective for delimiter-shaped package/tool ids. */
export function makeToolNoteKey(packageId: string, toolName: string): string {
  return JSON.stringify([packageId, toolName]);
}

export function parseToolNoteKey(
  key: string,
): { packageId: string; toolName: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return undefined;
  }
  const [packageId, toolName] = parsed;
  if (typeof packageId !== "string" || typeof toolName !== "string") {
    return undefined;
  }
  if (packageId.length === 0 || toolName.length === 0) {
    return undefined;
  }
  return { packageId, toolName };
}

function hasControlOrMultiline(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function parseIsoTimestamp(value: string): Date | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

/**
 * Handler-facing normalization: collapse whitespace, strip control chars, trim.
 * Rejects empty results and over-cap text without truncation.
 */
export function normalizeNoteText(
  raw: string,
): { ok: true; note: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "note must be a string." };
  }
  const withoutControl = raw.replace(/[\x00-\x1f\x7f]/g, "");
  const collapsed = withoutControl.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return { ok: false, reason: "note must be non-empty after normalization." };
  }
  if (collapsed.length > NOTE_MAX_CHARS) {
    return {
      ok: false,
      reason: `note exceeds maximum of ${NOTE_MAX_CHARS} characters (${collapsed.length} after normalization).`,
    };
  }
  return { ok: true, note: collapsed };
}

function isEntryShape(value: unknown): value is ToolNoteEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.note === "string" &&
    typeof entry.written_at === "string" &&
    typeof entry.expires_at === "string" &&
    typeof entry.schema_hash === "string"
  );
}

function validateEntryTimestamps(
  entry: ToolNoteEntry,
  now: Date,
): boolean {
  const writtenAt = parseIsoTimestamp(entry.written_at);
  const expiresAt = parseIsoTimestamp(entry.expires_at);
  if (!writtenAt || !expiresAt) {
    return false;
  }
  if (writtenAt.getTime() > now.getTime()) {
    return false;
  }
  if (expiresAt.getTime() <= writtenAt.getTime()) {
    return false;
  }
  const maxExpiry = writtenAt.getTime() + NOTE_TTL_DAYS * MS_PER_DAY;
  if (expiresAt.getTime() > maxExpiry) {
    return false;
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/** Store-level validator — guards load, mutation, and hand-edited files. */
export function isValidLiveEntry(
  entry: ToolNoteEntry,
  now: Date,
): boolean {
  if (!entry.note || entry.note.length > NOTE_MAX_CHARS) {
    return false;
  }
  if (hasControlOrMultiline(entry.note)) {
    return false;
  }
  if (!entry.schema_hash || typeof entry.schema_hash !== "string") {
    return false;
  }
  return validateEntryTimestamps(entry, now);
}

function defaultNotesPath(): string {
  return path.join(os.homedir(), ".super-mcp", "tool-notes.json");
}

let defaultStore: ToolNotesStore | undefined;

export function getToolNotesStore(): ToolNotesStore {
  if (!defaultStore) {
    defaultStore = new ToolNotesStore(defaultNotesPath());
  }
  return defaultStore;
}

export function createToolNotesStore(
  filePath: string,
  clock: () => Date = () => new Date(),
): ToolNotesStore {
  return new ToolNotesStore(filePath, clock);
}

export function resetToolNotesStoreForTests(): void {
  defaultStore = undefined;
}

export class ToolNotesStore {
  constructor(
    private readonly filePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async readSnapshot(): Promise<LiveToolNote[]> {
    const state = await this.readFileState();
    if (state.kind !== "ok") {
      return [];
    }
    const now = this.clock();
    const live: LiveToolNote[] = [];
    for (const [key, entry] of Object.entries(state.data.notes)) {
      const parsedKey = parseToolNoteKey(key);
      if (!parsedKey || !isEntryShape(entry) || !isValidLiveEntry(entry, now)) {
        continue;
      }
      live.push({
        packageId: parsedKey.packageId,
        toolName: parsedKey.toolName,
        note: entry.note,
        schema_hash: entry.schema_hash,
      });
    }
    return live;
  }

  async lookup(
    packageId: string,
    toolName: string,
    schemaHash: string,
  ): Promise<string | undefined> {
    const key = makeToolNoteKey(packageId, toolName);
    const state = await this.readFileState();
    if (state.kind !== "ok") {
      return undefined;
    }
    const entry = state.data.notes[key];
    if (!entry || !isEntryShape(entry) || !isValidLiveEntry(entry, this.clock())) {
      return undefined;
    }
    if (entry.schema_hash !== schemaHash) {
      return undefined;
    }
    return entry.note;
  }

  async record(
    packageId: string,
    toolName: string,
    note: string,
    schemaHash: string,
  ): Promise<RecordNoteResult> {
    if (!note || note.length > NOTE_MAX_CHARS || hasControlOrMultiline(note)) {
      return { status: "rejected", reason: "note failed store validation." };
    }
    if (!schemaHash || typeof schemaHash !== "string") {
      return { status: "rejected", reason: "schema_hash is required." };
    }

    try {
      await this.withLockedMutation(async (data) => {
        const key = makeToolNoteKey(packageId, toolName);
        const isReplacement = Object.prototype.hasOwnProperty.call(data.notes, key);
        if (!isReplacement) {
          const quotaError = this.checkQuotaForNewKey(data.notes, packageId);
          if (quotaError) {
            throw new QuotaRejectedError(quotaError);
          }
        }

        const now = this.clock();
        const writtenAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + NOTE_TTL_DAYS * MS_PER_DAY).toISOString();
        const entry: ToolNoteEntry = {
          note,
          written_at: writtenAt,
          expires_at: expiresAt,
          schema_hash: schemaHash,
        };
        if (!isValidLiveEntry(entry, now)) {
          throw new ValidationRejectedError("note failed store validation.");
        }

        data.notes[key] = entry;
        return data;
      });
      logger.info("tool note recorded", {
        package_id: packageId,
        tool_id: toolName,
      });
      return { status: "recorded" };
    } catch (error) {
      if (error instanceof QuotaRejectedError || error instanceof ValidationRejectedError) {
        return { status: "rejected", reason: error.message };
      }
      if (error instanceof MutationBlockedError) {
        return { status: "rejected", reason: error.message };
      }
      throw error;
    }
  }

  async remove(packageId: string, toolName: string): Promise<RemoveNoteResult> {
    const key = makeToolNoteKey(packageId, toolName);
    let removed = false;
    try {
      await this.withLockedMutation(async (data) => {
        if (!Object.prototype.hasOwnProperty.call(data.notes, key)) {
          return data;
        }
        delete data.notes[key];
        removed = true;
        return data;
      });
    } catch (error) {
      if (error instanceof MutationBlockedError) {
        return { status: "not_found" };
      }
      throw error;
    }

    if (removed) {
      logger.info("tool note removed", {
        package_id: packageId,
        tool_id: toolName,
      });
      return { status: "removed" };
    }
    return { status: "not_found" };
  }

  /** Test helper: write raw file bytes without going through the store validator. */
  async writeRawForTests(content: string): Promise<void> {
    const stateDir = path.dirname(this.filePath);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, content, { mode: 0o600 });
  }

  /** Test helper: read on-disk bytes. */
  async readRawForTests(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  private checkQuotaForNewKey(
    notes: Record<string, ToolNoteEntry>,
    packageId: string,
  ): string | undefined {
    const now = this.clock();
    let globalCount = 0;
    let packageCount = 0;
    for (const [key, entry] of Object.entries(notes)) {
      const parsedKey = parseToolNoteKey(key);
      if (!parsedKey || !isEntryShape(entry) || !isValidLiveEntry(entry, now)) {
        continue;
      }
      globalCount += 1;
      if (parsedKey.packageId === packageId) {
        packageCount += 1;
      }
    }
    if (globalCount >= MAX_NOTES_GLOBAL) {
      return `global note capacity reached (${MAX_NOTES_GLOBAL}).`;
    }
    if (packageCount >= MAX_NOTES_PER_PACKAGE) {
      return `package note capacity reached (${MAX_NOTES_PER_PACKAGE} for '${packageId}').`;
    }
    return undefined;
  }

  private compactNotes(
    notes: Record<string, ToolNoteEntry>,
    now: Date,
  ): Record<string, ToolNoteEntry> {
    const compacted: Record<string, ToolNoteEntry> = {};
    for (const [key, entry] of Object.entries(notes)) {
      const parsedKey = parseToolNoteKey(key);
      if (!parsedKey || !isEntryShape(entry) || !isValidLiveEntry(entry, now)) {
        continue;
      }
      compacted[key] = entry;
    }
    return compacted;
  }

  private async readFileState(): Promise<ReadState> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.filePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return { kind: "empty", reason: "missing" };
      }
      throw error;
    }

    if (raw.byteLength > MAX_FILE_BYTES) {
      logger.warn("tool notes file exceeds size limit; treating as empty for reads", {
        file_path: this.filePath,
        size_bytes: raw.byteLength,
        max_bytes: MAX_FILE_BYTES,
      });
      return { kind: "oversized" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      logger.warn("tool notes file contains malformed JSON; treating as empty for reads", {
        file_path: this.filePath,
      });
      return { kind: "empty", reason: "malformed" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("tool notes file has invalid root shape; treating as empty for reads", {
        file_path: this.filePath,
      });
      return { kind: "empty", reason: "malformed" };
    }

    const version = (parsed as { version?: unknown }).version;
    if (version !== STORE_VERSION) {
      logger.warn("tool notes file has unsupported version; reads empty, mutations blocked", {
        file_path: this.filePath,
        version,
      });
      return { kind: "unknown_version" };
    }

    const notesValue = (parsed as { notes?: unknown }).notes;
    if (!notesValue || typeof notesValue !== "object" || Array.isArray(notesValue)) {
      return {
        kind: "ok",
        data: { version: STORE_VERSION, notes: {} },
      };
    }

    return {
      kind: "ok",
      data: {
        version: STORE_VERSION,
        notes: { ...(notesValue as Record<string, ToolNoteEntry>) },
      },
    };
  }

  private async ensureStoreFileExists(): Promise<void> {
    const stateDir = path.dirname(this.filePath);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const initial = JSON.stringify({ version: STORE_VERSION, notes: {} }, null, 2);
    try {
      await fs.writeFile(this.filePath, initial, { flag: "wx", mode: 0o600 });
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        return;
      }
      throw error;
    }
  }

  private async withLockedMutation(
    mutate: (data: ToolNotesFile) => ToolNotesFile | Promise<ToolNotesFile>,
  ): Promise<void> {
    await this.ensureStoreFileExists();

    let release: (() => Promise<void>) | undefined;
    try {
      release = await properLockfile.lock(this.filePath, {
        stale: 30_000,
        retries: { retries: 5, minTimeout: 50, maxTimeout: 200, factor: 1.5, randomize: true },
        realpath: false,
      });

      const state = await this.readFileState();
      if (state.kind === "unknown_version") {
        throw new MutationBlockedError("tool notes store version is unsupported.");
      }
      if (state.kind === "oversized") {
        throw new MutationBlockedError("tool notes file exceeds the size limit.");
      }

      const now = this.clock();
      const base: ToolNotesFile =
        state.kind === "ok"
          ? { version: STORE_VERSION, notes: this.compactNotes(state.data.notes, now) }
          : { version: STORE_VERSION, notes: {} };

      const next = await mutate(base);
      await this.atomicWrite(next);
    } finally {
      if (release) {
        await release().catch((error) => {
          logger.warn("failed to release tool notes lock", {
            file_path: this.filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  private async atomicWrite(data: ToolNotesFile): Promise<void> {
    const stateDir = path.dirname(this.filePath);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      stateDir,
      `.tool-notes.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );

    let wrote = false;
    try {
      const handle = await fs.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(data, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      wrote = true;
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      if (wrote || (await fs.access(tempPath).then(() => true, () => false))) {
        await fs.unlink(tempPath).catch(() => {});
      }
      throw error;
    }
  }
}

class QuotaRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaRejectedError";
  }
}

class ValidationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationRejectedError";
  }
}

class MutationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationBlockedError";
  }
}
