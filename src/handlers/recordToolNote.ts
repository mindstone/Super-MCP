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

function invalidParams(message: string): never {
  throw {
    code: ERROR_CODES.INVALID_PARAMS,
    message,
  };
}

export async function handleRecordToolNote(
  input: RecordToolNoteInput,
  catalog: Catalog,
  store?: ToolNotesStore,
): Promise<any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalidParams("record_tool_note arguments must be an object.");
  }

  const notesStore = resolveStore(store);
  const package_id = input.package_id;
  const tool_id = input.tool_id;
  const remove = coerceStringifiedBoolean(input.remove, {
    handler: "record_tool_note",
    field: "remove",
  });
  const note = input.note;

  if (remove !== undefined && typeof remove !== "boolean") {
    invalidParams("remove must be a boolean.");
  }

  if (typeof package_id !== "string" || package_id.trim().length === 0) {
    invalidParams("package_id is required and must be a non-empty string.");
  }

  if (package_id.includes("__")) {
    invalidParams(
      "package_id cannot contain '__' because get_tool_details uses that delimiter to separate package and tool IDs; a note for this package could never be retrieved.",
    );
  }

  if (typeof tool_id !== "string" || tool_id.trim().length === 0) {
    invalidParams("tool_id is required and must be a non-empty string.");
  }

  let noteToRecord: string | undefined;
  if (remove === true && Object.prototype.hasOwnProperty.call(input, "note")) {
    invalidParams("remove: true cannot be combined with a note.");
  } else if (remove !== true) {
    if (note === undefined || note === null) {
      invalidParams("note is required unless remove is true.");
    }
    if (typeof note !== "string") {
      invalidParams("note must be a string.");
    }
    noteToRecord = note;
  }

  const cachedTool = await catalog.getTool(package_id, tool_id);
  if (!cachedTool && tool_id.includes("__")) {
    invalidParams(
      "tool_id must be the bare canonical tool name. list_tools returns namespaced IDs; remove only the leading '<package_id>__' prefix and pass the remainder unchanged (for example, 'package__tool__name' becomes 'tool__name').",
    );
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

  if (noteToRecord === undefined) {
    invalidParams("note is required unless remove is true.");
  }

  const normalized = normalizeNoteText(noteToRecord);
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
