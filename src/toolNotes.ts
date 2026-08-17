import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import properLockfile from "proper-lockfile";
import { getLogger } from "./logging.js";
import { ERROR_CODES } from "./types.js";

const logger = getLogger();

export const NOTE_MAX_CHARS = 200;
export const NOTE_TTL_DAYS = 30;
export const MAX_NOTES_PER_PACKAGE = 25;
export const MAX_NOTES_GLOBAL = 200;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_KEY_COMPONENT_CHARS = 256;
export const MAX_SCHEMA_HASH_CHARS = 128;
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
  written_at: string;
  expires_at: string;
  schema_hash: string;
}

type ReadState =
  | { kind: "ok"; data: ToolNotesFile }
  | { kind: "empty"; reason: "missing" | "malformed" }
  | { kind: "oversized" }
  | { kind: "unreadable" }
  | { kind: "unknown_version" };

interface NoteAnalysis {
  visibleNotes: Record<string, ToolNoteEntry>;
  discardCandidates: Record<string, ToolNoteEntry>;
  needsCompaction: boolean;
  overQuota: boolean;
}

interface CompactionObservation {
  observedNotes: Record<string, ToolNoteEntry>;
  discardCandidates: Record<string, ToolNoteEntry>;
}

interface MutationContext {
  analysis: NoteAnalysis;
}

interface LockedMutationOptions {
  compactionObservation?: CompactionObservation;
  preserveCurrentEntries?: boolean;
}

export type RecordNoteResult =
  | { status: "recorded" }
  | { status: "rejected"; reason: string };

export type RemoveNoteResult =
  | { status: "removed" }
  | { status: "not_found" }
  | { status: "rejected"; reason: string };

/** Shared tuple key — injective for delimiter-shaped package/tool ids. */
export function makeToolNoteKey(packageId: string, toolName: string): string {
  return JSON.stringify([packageId, toolName]);
}

function isValidKeyComponent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_COMPONENT_CHARS
  );
}

function parseCanonicalToolNoteKey(
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
  if (!isValidKeyComponent(packageId) || !isValidKeyComponent(toolName)) {
    return undefined;
  }
  if (key !== makeToolNoteKey(packageId, toolName)) {
    return undefined;
  }
  return { packageId, toolName };
}

function isDisallowedNoteCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function hasDisallowedNoteText(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isDisallowedNoteCodePoint(codePoint)) {
      return true;
    }
  }
  return false;
}

function stripDisallowedNoteText(text: string): string {
  let stripped = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isDisallowedNoteCodePoint(codePoint)) {
      stripped += character;
    }
  }
  return stripped;
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
 * Handler-facing normalization: collapse whitespace, strip remaining controls, trim.
 * Rejects empty results and over-cap text without truncation.
 */
export function normalizeNoteText(
  raw: string,
): { ok: true; note: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "note must be a string." };
  }
  const whitespaceCollapsed = raw.replace(/\s+/gu, " ");
  const normalized = stripDisallowedNoteText(whitespaceCollapsed).trim();
  if (!normalized) {
    return { ok: false, reason: "note must be non-empty after normalization." };
  }
  if (normalized.length > NOTE_MAX_CHARS) {
    return {
      ok: false,
      reason: `note exceeds maximum of ${NOTE_MAX_CHARS} characters (${normalized.length} after normalization).`,
    };
  }
  return { ok: true, note: normalized };
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

function validateEntryTimestamps(entry: ToolNoteEntry, now: Date): boolean {
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
function isValidLiveEntry(entry: ToolNoteEntry, now: Date): boolean {
  if (!entry.note || entry.note.length > NOTE_MAX_CHARS) {
    return false;
  }
  if (hasDisallowedNoteText(entry.note)) {
    return false;
  }
  if (!entry.schema_hash || entry.schema_hash.length > MAX_SCHEMA_HASH_CHARS) {
    return false;
  }
  return validateEntryTimestamps(entry, now);
}

function entryMatchesSnapshot(
  entry: ToolNoteEntry,
  snapshot: LiveToolNote,
): boolean {
  return (
    entry.note === snapshot.note &&
    entry.written_at === snapshot.written_at &&
    entry.expires_at === snapshot.expires_at &&
    entry.schema_hash === snapshot.schema_hash
  );
}

/** A cleanup may discard an entry only when the persisted value is unchanged. */
function entryMatchesObservation(left: unknown, right: unknown): boolean {
  if (isEntryShape(left) && isEntryShape(right)) {
    return (
      left.note === right.note &&
      left.written_at === right.written_at &&
      left.expires_at === right.expires_at &&
      left.schema_hash === right.schema_hash
    );
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function isContentionError(error: unknown): boolean {
  return getErrorCode(error) === "ELOCKED";
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

    const analysis = this.analyzeNotes(state.data.notes, this.clock());
    const snapshot: LiveToolNote[] = [];
    for (const [key, entry] of Object.entries(analysis.visibleNotes)) {
      const parsedKey = parseCanonicalToolNoteKey(key);
      if (!parsedKey) {
        logger.warn(
          "tool notes snapshot skipped a non-canonical key after analysis",
          {
            file_path: this.filePath,
            key_length: key.length,
          },
        );
        continue;
      }
      snapshot.push({
        packageId: parsedKey.packageId,
        toolName: parsedKey.toolName,
        note: entry.note,
        written_at: entry.written_at,
        expires_at: entry.expires_at,
        schema_hash: entry.schema_hash,
      });
    }

    if (analysis.needsCompaction) {
      this.scheduleBestEffortCompaction({
        observedNotes: { ...state.data.notes },
        discardCandidates: { ...analysis.discardCandidates },
      });
    }
    return snapshot;
  }

  /**
   * Re-read under the lock and remove only snapshot entries that are still
   * byte-for-byte unchanged, without deleting a concurrent replacement.
   */
  async compactSnapshotEntries(
    entriesToRemove: readonly LiveToolNote[] = [],
  ): Promise<void> {
    await this.compactEntries(entriesToRemove);
  }

  private async compactEntries(
    entriesToRemove: readonly LiveToolNote[],
    observation?: CompactionObservation,
  ): Promise<void> {
    await this.withLockedMutation(
      (data, { analysis }) => {
        let changed = observation !== undefined && analysis.needsCompaction;
        for (const snapshot of entriesToRemove) {
          const key = makeToolNoteKey(snapshot.packageId, snapshot.toolName);
          const current = data.notes[key];
          if (current && entryMatchesSnapshot(current, snapshot)) {
            delete data.notes[key];
            changed = true;
          }
        }
        return changed ? data : undefined;
      },
      observation
        ? { compactionObservation: observation }
        : { preserveCurrentEntries: true },
    );
  }

  async record(
    packageId: string,
    toolName: string,
    note: string,
    schemaHash: string,
  ): Promise<RecordNoteResult> {
    if (!isValidKeyComponent(packageId) || !isValidKeyComponent(toolName)) {
      return {
        status: "rejected",
        reason: `package and tool identifiers must be 1-${MAX_KEY_COMPONENT_CHARS} characters.`,
      };
    }
    if (!note || note.length > NOTE_MAX_CHARS || hasDisallowedNoteText(note)) {
      return { status: "rejected", reason: "note failed store validation." };
    }
    if (!schemaHash || typeof schemaHash !== "string") {
      return { status: "rejected", reason: "schema_hash is required." };
    }
    if (schemaHash.length > MAX_SCHEMA_HASH_CHARS) {
      return {
        status: "rejected",
        reason: `schema_hash exceeds maximum of ${MAX_SCHEMA_HASH_CHARS} characters.`,
      };
    }

    try {
      await this.withLockedMutation(async (data, { analysis }) => {
        const key = makeToolNoteKey(packageId, toolName);
        const isReplacement = Object.prototype.hasOwnProperty.call(
          data.notes,
          key,
        );
        if (analysis.overQuota && !isReplacement) {
          throw new QuotaRejectedError(
            "tool notes file is over capacity; replace or remove an existing note before adding another.",
          );
        }
        if (!isReplacement) {
          const quotaError = this.checkQuotaForNewKey(data.notes, packageId);
          if (quotaError) {
            throw new QuotaRejectedError(quotaError);
          }
        }

        const now = this.clock();
        const writtenAt = now.toISOString();
        const expiresAt = new Date(
          now.getTime() + NOTE_TTL_DAYS * MS_PER_DAY,
        ).toISOString();
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
      const reason = this.getMutationRejectionReason(error);
      if (reason) {
        return { status: "rejected", reason };
      }
      this.rethrowProtocolSafe(error);
    }
  }

  async remove(packageId: string, toolName: string): Promise<RemoveNoteResult> {
    if (!isValidKeyComponent(packageId) || !isValidKeyComponent(toolName)) {
      return {
        status: "rejected",
        reason: `package and tool identifiers must be 1-${MAX_KEY_COMPONENT_CHARS} characters.`,
      };
    }

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
      const reason = this.getMutationRejectionReason(error);
      if (reason) {
        return { status: "rejected", reason };
      }
      this.rethrowProtocolSafe(error);
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

  private getMutationRejectionReason(error: unknown): string | undefined {
    if (
      error instanceof QuotaRejectedError ||
      error instanceof ValidationRejectedError ||
      error instanceof MutationBlockedError
    ) {
      return error.message;
    }
    if (isContentionError(error)) {
      return "another process is writing tool notes; retry.";
    }
    return undefined;
  }

  private rethrowProtocolSafe(error: unknown): never {
    if (getErrorCode(error)) {
      throw new ToolNotesInternalError("Tool notes storage failed.", error);
    }
    throw error;
  }

  private checkQuotaForNewKey(
    notes: Record<string, ToolNoteEntry>,
    packageId: string,
  ): string | undefined {
    let globalCount = 0;
    let packageCount = 0;
    for (const key of Object.keys(notes)) {
      const parsedKey = parseCanonicalToolNoteKey(key);
      if (!parsedKey) {
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

  private analyzeNotes(
    notes: Record<string, ToolNoteEntry>,
    now: Date,
  ): NoteAnalysis {
    const visibleNotes: Record<string, ToolNoteEntry> = {};
    const discardCandidates: Record<string, ToolNoteEntry> = {};
    const packageCounts = new Map<string, number>();
    let globalCount = 0;
    let needsCompaction = false;
    let overQuota = false;

    const entries = Object.entries(notes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [key, entry] of entries) {
      const parsedKey = parseCanonicalToolNoteKey(key);
      if (!parsedKey || !isEntryShape(entry) || !isValidLiveEntry(entry, now)) {
        discardCandidates[key] = entry;
        needsCompaction = true;
        continue;
      }

      const packageCount = packageCounts.get(parsedKey.packageId) ?? 0;
      if (
        globalCount >= MAX_NOTES_GLOBAL ||
        packageCount >= MAX_NOTES_PER_PACKAGE
      ) {
        discardCandidates[key] = entry;
        needsCompaction = true;
        overQuota = true;
        continue;
      }

      visibleNotes[key] = entry;
      globalCount += 1;
      packageCounts.set(parsedKey.packageId, packageCount + 1);
    }

    return {
      visibleNotes,
      discardCandidates,
      needsCompaction,
      overQuota,
    };
  }

  private scheduleBestEffortCompaction(
    observation: CompactionObservation,
  ): void {
    void this.compactEntries([], observation).catch((error) => {
      logger.warn(
        "tool notes compaction failed; read snapshot remains usable",
        {
          file_path: this.filePath,
          error_code: getErrorCode(error),
          error_name: error instanceof Error ? error.name : typeof error,
        },
      );
    });
  }

  /**
   * Concurrently changed or added entries get first claim on quota. Stable
   * entries then fill the remaining deterministic subset, so cleanup can
   * restore caps without deleting a write made after the read snapshot.
   */
  private reconcileObservedCompaction(
    currentNotes: Record<string, ToolNoteEntry>,
    observation: CompactionObservation,
    now: Date,
  ): Record<string, ToolNoteEntry> | undefined {
    const retainedEntries: Array<[string, ToolNoteEntry]> = [];
    const concurrentKeys = new Set<string>();
    const currentEntries = Object.entries(currentNotes).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );

    for (const [key, entry] of currentEntries) {
      const wasObserved = Object.prototype.hasOwnProperty.call(
        observation.observedNotes,
        key,
      );
      const unchanged =
        wasObserved &&
        entryMatchesObservation(entry, observation.observedNotes[key]);
      const wasDiscardCandidate = Object.prototype.hasOwnProperty.call(
        observation.discardCandidates,
        key,
      );

      if (
        unchanged &&
        wasDiscardCandidate &&
        entryMatchesObservation(entry, observation.discardCandidates[key])
      ) {
        continue;
      }
      if (!unchanged) {
        concurrentKeys.add(key);
      }
      retainedEntries.push([key, entry]);
    }

    const selectedNotes: Record<string, ToolNoteEntry> = {};
    const packageCounts = new Map<string, number>();
    let globalCount = 0;

    const addWithinQuota = (
      [key, entry]: [string, ToolNoteEntry],
      mustRetain: boolean,
    ): boolean => {
      const parsedKey = parseCanonicalToolNoteKey(key);
      if (!parsedKey || !isEntryShape(entry) || !isValidLiveEntry(entry, now)) {
        selectedNotes[key] = entry;
        return true;
      }

      const packageCount = packageCounts.get(parsedKey.packageId) ?? 0;
      if (
        globalCount >= MAX_NOTES_GLOBAL ||
        packageCount >= MAX_NOTES_PER_PACKAGE
      ) {
        return !mustRetain;
      }

      selectedNotes[key] = entry;
      globalCount += 1;
      packageCounts.set(parsedKey.packageId, packageCount + 1);
      return true;
    };

    for (const entry of retainedEntries) {
      if (concurrentKeys.has(entry[0]) && !addWithinQuota(entry, true)) {
        return undefined;
      }
    }
    for (const entry of retainedEntries) {
      if (!concurrentKeys.has(entry[0])) {
        addWithinQuota(entry, false);
      }
    }

    return selectedNotes;
  }

  private async readFileState(): Promise<ReadState> {
    let raw: Buffer;
    try {
      const handle = await fs.open(this.filePath, "r");
      try {
        const { size } = await handle.stat();
        const buffer = Buffer.allocUnsafe(Math.min(size, MAX_FILE_BYTES) + 1);
        let totalBytesRead = 0;
        while (totalBytesRead < buffer.byteLength) {
          const { bytesRead } = await handle.read(
            buffer,
            totalBytesRead,
            buffer.byteLength - totalBytesRead,
            totalBytesRead,
          );
          if (bytesRead === 0) {
            break;
          }
          totalBytesRead += bytesRead;
        }
        raw = buffer.subarray(0, totalBytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return { kind: "empty", reason: "missing" };
      }
      logger.warn(
        "tool notes file could not be read; treating as empty for reads",
        {
          file_path: this.filePath,
          error_code: getErrorCode(error),
        },
      );
      return { kind: "unreadable" };
    }

    if (raw.byteLength > MAX_FILE_BYTES) {
      logger.warn(
        "tool notes file exceeds size limit; treating as empty for reads",
        {
          file_path: this.filePath,
          observed_bytes: raw.byteLength,
          max_bytes: MAX_FILE_BYTES,
        },
      );
      return { kind: "oversized" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      logger.warn(
        "tool notes file contains malformed JSON; treating as empty for reads",
        {
          file_path: this.filePath,
        },
      );
      return { kind: "empty", reason: "malformed" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn(
        "tool notes file has invalid root shape; treating as empty for reads",
        {
          file_path: this.filePath,
        },
      );
      return { kind: "empty", reason: "malformed" };
    }

    const version = (parsed as { version?: unknown }).version;
    if (version !== STORE_VERSION) {
      logger.warn(
        "tool notes file has unsupported version; reads empty, mutations blocked",
        {
          file_path: this.filePath,
          version: typeof version === "number" ? version : undefined,
          version_type: typeof version,
        },
      );
      return { kind: "unknown_version" };
    }

    const notesValue = (parsed as { notes?: unknown }).notes;
    if (
      !notesValue ||
      typeof notesValue !== "object" ||
      Array.isArray(notesValue)
    ) {
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
    const initial = JSON.stringify(
      { version: STORE_VERSION, notes: {} },
      null,
      2,
    );
    try {
      await fs.writeFile(this.filePath, initial, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") {
        return;
      }
      throw error;
    }
  }

  private async assertLockHealthy(tracker: { error?: Error }): Promise<void> {
    if (tracker.error) {
      throw new MutationBlockedError("tool notes lock was compromised; retry.");
    }
    try {
      await fs.access(`${this.filePath}.lock`);
    } catch {
      throw new MutationBlockedError("tool notes lock was compromised; retry.");
    }
  }

  private async withLockedMutation(
    mutate: (
      data: ToolNotesFile,
      context: MutationContext,
    ) => ToolNotesFile | undefined | Promise<ToolNotesFile | undefined>,
    options: LockedMutationOptions = {},
  ): Promise<void> {
    await this.ensureStoreFileExists();

    const tracker: { error?: Error } = {};
    let release: (() => Promise<void>) | undefined;
    try {
      release = await properLockfile.lock(this.filePath, {
        stale: 30_000,
        retries: {
          retries: 5,
          minTimeout: 50,
          maxTimeout: 200,
          factor: 1.5,
          randomize: true,
        },
        realpath: false,
        onCompromised: (error: Error) => {
          tracker.error = error;
          logger.warn("tool notes lock was compromised", {
            file_path: this.filePath,
            error_code: getErrorCode(error),
          });
        },
      });

      const state = await this.readFileState();
      if (state.kind === "unknown_version") {
        throw new MutationBlockedError(
          "tool notes store version is unsupported.",
        );
      }
      if (state.kind === "oversized") {
        throw new MutationBlockedError(
          "tool notes file exceeds the size limit.",
        );
      }
      if (state.kind === "unreadable") {
        throw new ToolNotesInternalError("Tool notes storage is unavailable.");
      }

      const now = this.clock();
      const analysis: NoteAnalysis =
        state.kind === "ok"
          ? this.analyzeNotes(state.data.notes, now)
          : {
              visibleNotes: {},
              discardCandidates: {},
              needsCompaction: false,
              overQuota: false,
            };
      const reconciledNotes =
        state.kind === "ok" && options.compactionObservation
          ? this.reconcileObservedCompaction(
              state.data.notes,
              options.compactionObservation,
              now,
            )
          : undefined;
      if (
        state.kind === "ok" &&
        options.compactionObservation &&
        !reconciledNotes
      ) {
        logger.warn(
          "tool notes compaction skipped to preserve concurrent writes",
          {
            file_path: this.filePath,
          },
        );
        return;
      }
      const base: ToolNotesFile = {
        version: STORE_VERSION,
        notes:
          state.kind === "ok"
            ? options.compactionObservation
              ? { ...reconciledNotes }
              : options.preserveCurrentEntries || analysis.overQuota
                ? { ...state.data.notes }
                : { ...analysis.visibleNotes }
            : {},
      };

      const next = await mutate(base, { analysis });
      if (!next) {
        return;
      }
      await this.assertLockHealthy(tracker);
      await this.atomicWrite(next);
    } finally {
      if (release) {
        await release().catch((error) => {
          logger.warn("failed to release tool notes lock", {
            file_path: this.filePath,
            error_code: getErrorCode(error),
          });
        });
      }
    }
  }

  private async atomicWrite(data: ToolNotesFile): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    const serializedBytes = Buffer.byteLength(serialized);
    if (serializedBytes > MAX_FILE_BYTES) {
      throw new ValidationRejectedError(
        `tool notes update would exceed the ${MAX_FILE_BYTES}-byte file limit.`,
      );
    }

    const stateDir = path.dirname(this.filePath);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      stateDir,
      `.tool-notes.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );

    let tempCreated = false;
    try {
      const handle = await fs.open(tempPath, "w", 0o600);
      tempCreated = true;
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      if (tempCreated) {
        await fs.unlink(tempPath).catch((cleanupError) => {
          logger.warn("failed to clean up tool notes temporary file", {
            file_path: tempPath,
            error_code: getErrorCode(cleanupError),
          });
        });
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

class ToolNotesInternalError extends Error {
  readonly code = ERROR_CODES.INTERNAL_ERROR;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ToolNotesInternalError";
  }
}
