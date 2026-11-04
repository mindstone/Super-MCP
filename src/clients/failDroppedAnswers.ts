import { createParser } from "eventsource-parser";
import { isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse, JSONRPCMessageSchema, type JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

function readJsonRpcRequest(init?: RequestInit): JSONRPCRequest | undefined {
  if (init?.method !== "POST" || typeof init.body !== "string") return;
  try {
    const request: unknown = JSON.parse(init.body);
    if (isJSONRPCRequest(request)) return request;
  } catch { /* Not a readable JSON-RPC request. */ }
}

/** Fail only the request whose non-resumable POST answer stream disappeared. */
export function failDroppedAnswers(baseFetch: typeof fetch, onDrop: (request: JSONRPCRequest) => void): typeof fetch {
  return async (input, init) => {
    const request = readJsonRpcRequest(init);
    const response = await baseFetch(input, init);
    if (!request || !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answered = false, resumable = false, cancelled = false;
    const parser = createParser({ onEvent(event) {
      // Like the SDK's hasPrimingEvent, only a delivered event can enable resumption.
      if (event.id) resumable = true;
      if (!event.data || (event.event && event.event !== "message")) return;
      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
        if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
            message.id === request.id) answered = true;
      } catch { /* Notifications and invalid data are not answers. */ }
    } });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (error) {
          if (cancelled) return;
          if (answered || resumable || init?.signal?.aborted) { controller.error(error); return; }
        }
        if (cancelled) return;
        if (chunk && !chunk.done) {
          parser.feed(decoder.decode(chunk.value, { stream: true }));
          controller.enqueue(chunk.value);
          return;
        }
        const dropped = !answered && !resumable && !init?.signal?.aborted;
        if (dropped) {
          // Finish any partial event before appending the synthetic answer.
          controller.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify({
            jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Connection closed" },
          })}\n\n`));
        }
        controller.close();
        if (dropped) onDrop(request);
      },
      cancel(reason) { cancelled = true; return reader.cancel(reason); },
    });
    return new globalThis.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
