export interface ToolResultPayload {
  data: unknown;
  serialized: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Resolve JSON text first, then an object structuredContent, or no data. */
export function resolveToolResultPayload(toolResult: unknown, joinedText: string): ToolResultPayload | null {
  if (!isRecord(toolResult)) return null;

  if (joinedText.length > 0) {
    try {
      return { data: JSON.parse(joinedText), serialized: joinedText };
    } catch {
      // Prose is not a JSON payload; structuredContent may carry the data.
    }
  }

  if (isRecord(toolResult.structuredContent)) {
    return {
      data: toolResult.structuredContent,
      serialized: JSON.stringify(toolResult.structuredContent),
    };
  }

  return null;
}
