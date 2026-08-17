import { Catalog } from "../catalog.js";
import { ERROR_CODES } from "../types.js";
import { getLogger } from "../logging.js";
import { coerceStringifiedBoolean } from "../utils/normalizeInput.js";
import {
  getToolNotesStore,
  normalizeNoteText,
  type ToolNotesStore,
} from "../toolNotes.js";

const logger = getLogger();

export interface RecordToolNoteInput {
  package_id: string;
  tool_id: string;
  note?: string;
  remove?: boolean;
}

function resolveStore(store?: ToolNotesStore): ToolNotesStore {
  return store ?? getToolNotesStore();
}

function makeResponse(payload: Record<string, unknown>, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

export async function handleRecordToolNote(
  input: RecordToolNoteInput,
  catalog: Catalog,
  store?: ToolNotesStore,
): Promise<any> {
  const notesStore = resolveStore(store);
  const package_id = input.package_id;
  const tool_id = input.tool_id;
  const remove = coerceStringifiedBoolean(input.remove, {
    handler: "record_tool_note",
    field: "remove",
  });
  const note = input.note;

  if (remove !== undefined && typeof remove !== "boolean") {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: "remove must be a boolean.",
    };
  }

  if (
    !package_id ||
    typeof package_id !== "string" ||
    package_id.trim().length === 0
  ) {
    return makeResponse(
      {
        status: "error",
        message: "package_id is required and must be a non-empty string.",
      },
      true,
    );
  }

  if (!tool_id || typeof tool_id !== "string" || tool_id.trim().length === 0) {
    return makeResponse(
      {
        status: "error",
        message: "tool_id is required and must be a non-empty string.",
      },
      true,
    );
  }

  if (remove === true && Object.prototype.hasOwnProperty.call(input, "note")) {
    return makeResponse(
      {
        status: "error",
        message: "remove: true cannot be combined with a note.",
      },
      true,
    );
  }

  const cachedTool = await catalog.getTool(package_id, tool_id);
  if (!cachedTool && tool_id.includes("__")) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message:
        "tool_id must be the bare canonical tool name. list_tools returns namespaced IDs; remove only the leading '<package_id>__' prefix and pass the remainder unchanged (for example, 'package__tool__name' becomes 'tool__name').",
    };
  }

  const packageStatus = catalog.getPackageStatus(package_id);
  if (packageStatus !== "ready") {
    return makeResponse(
      {
        status: "error",
        message: `Package '${package_id}' is not available for recording notes.`,
      },
      true,
    );
  }

  if (!cachedTool) {
    return makeResponse({ status: "not_found" }, true);
  }

  const canonicalToolName = cachedTool.tool.name;

  if (remove === true) {
    const result = await notesStore.remove(package_id, canonicalToolName);
    if (result.status === "rejected") {
      return makeResponse({ status: "rejected", message: result.reason }, true);
    }
    return makeResponse(
      { status: result.status },
      result.status === "not_found",
    );
  }

  if (note === undefined || note === null) {
    return makeResponse(
      { status: "error", message: "note is required unless remove is true." },
      true,
    );
  }

  if (typeof note !== "string") {
    return makeResponse(
      { status: "error", message: "note must be a string." },
      true,
    );
  }

  const normalized = normalizeNoteText(note);
  if (!normalized.ok) {
    logger.warn("record_tool_note rejected note text", {
      package_id,
      tool_id: canonicalToolName,
      reason: normalized.reason,
    });
    return makeResponse(
      { status: "rejected", message: normalized.reason },
      true,
    );
  }

  const recordResult = await notesStore.record(
    package_id,
    canonicalToolName,
    normalized.note,
    cachedTool.schemaHash,
  );

  if (recordResult.status === "rejected") {
    return makeResponse(
      { status: "rejected", message: recordResult.reason },
      true,
    );
  }

  return makeResponse({ status: "recorded" });
}
