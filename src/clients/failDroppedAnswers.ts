import { createParser } from "eventsource-parser";
import { isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse, JSONRPCMessageSchema, type JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { isWithinOrigin } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The SDK's default `maxRetries`: after this many failed resumption attempts it stops trying, silently. */
const SDK_RESUMPTION_ATTEMPTS = 2;
// The SDK's redirect rule for a GET (shared/transport.js followWithinOrigin), under its default redirect policy.
const SDK_REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const SDK_MAX_REDIRECTS = 5;

/** Whether the SDK follows this redirect itself, fetching again within the same resumption attempt. */
function sdkFollowsRedirect(response: Response, url: string, followed: number): boolean {
  const location = SDK_REDIRECT_STATUSES.includes(response.status) ? response.headers.get("location") : null;
  if (!location || followed >= SDK_MAX_REDIRECTS || !URL.canParse(location, url)) return false;
  const from = new URL(url), to = new URL(location, url);
  const addsUserinfo = (to.username || to.password) && (to.username !== from.username || to.password !== from.password);
  return !addsUserinfo && isWithinOrigin(from, to);
}

function readJsonRpcRequest(init?: RequestInit): JSONRPCRequest | undefined {
  if (init?.method !== "POST" || typeof init.body !== "string") return;
  try {
    const request: unknown = JSON.parse(init.body);
    if (isJSONRPCRequest(request)) return request;
  } catch { /* Not a readable JSON-RPC request. */ }
}

function connectionClosed(request: JSONRPCRequest): string {
  return `\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Connection closed" } })}\n\n`;
}

/**
 * Fail only the request whose answer stream disappeared with no way left to resume it: a POST stream that ends
 * with no event id, or a resumable one whose resumption (GET with last-event-id) the SDK gives up on. Without this
 * the SDK leaves the request pending until its call timeout (REBEL-6GZ).
 */
export function failDroppedAnswers(
  baseFetch: typeof fetch,
  onDrop: (request: JSONRPCRequest) => void,
): typeof fetch {
  // Requests waiting on a resumption, by the event id the SDK resumes from.
  // `redirects` counts the hops the SDK has followed in the current attempt.
  const awaitingResumption = new Map<string, { request: JSONRPCRequest; failures: number; redirects: number }>();

  function drop(request: JSONRPCRequest, controller?: ReadableStreamDefaultController<Uint8Array>): Response | void {
    const text = new TextEncoder().encode(connectionClosed(request));
    try { onDrop(request); } catch { /* Logging must not stop the answer. */ }
    if (controller) { controller.enqueue(text); return; }
    return new globalThis.Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function track(response: Response, request: JSONRPCRequest, signal?: AbortSignal | null): Response {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let answered = false, lastEventId: string | undefined, cancelled = false;
    const parser = createParser({ onEvent(event) {
      // Like the SDK's hasPrimingEvent, only a delivered event can enable resumption.
      if (event.id) lastEventId = event.id;
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
        let readError: unknown;
        try { chunk = await reader.read(); }
        catch (error) { readError = error; }
        if (cancelled) return;
        if (chunk && !chunk.done) {
          parser.feed(decoder.decode(chunk.value, { stream: true }));
          controller.enqueue(chunk.value);
          return;
        }
        if (!answered && !signal?.aborted && lastEventId !== undefined) {
          awaitingResumption.set(lastEventId, { request, failures: 0, redirects: 0 });
        }
        if (readError !== undefined && (answered || lastEventId !== undefined || signal?.aborted)) {
          controller.error(readError);
          return;
        }
        // Finish any partial event before appending the synthetic answer.
        if (!answered && lastEventId === undefined && !signal?.aborted) drop(request, controller);
        controller.close();
      },
      cancel(reason) { cancelled = true; return reader.cancel(reason); },
    });
    return new globalThis.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /**
   * Discard a body nobody reads. A body cut off with the connection rejects its cancel; that is the failure already
   * being handled, so it must not stop the request from settling (or spend an SDK attempt this adapter cannot count).
   */
  async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  async function resume(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, eventId: string): Promise<Response> {
    const waiting = awaitingResumption.get(eventId)!;
    let response: Response;
    try { response = await baseFetch(input, init); }
    catch (error) {
      waiting.redirects = 0;
      if (init?.signal?.aborted || ++waiting.failures < SDK_RESUMPTION_ATTEMPTS) throw error;
      awaitingResumption.delete(eventId);
      return drop(waiting.request)!;
    }
    // A hop within one attempt: only where the attempt ends counts.
    const url = input instanceof Request ? input.url : String(input);
    if (sdkFollowsRedirect(response, url, waiting.redirects)) {
      waiting.redirects++;
      // Discarded here, so a body cut off with the connection cannot fail an attempt this adapter would not count.
      await discardBody(response);
      return new globalThis.Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    waiting.redirects = 0;
    // Judged as the SDK's _startOrAuthSse judges it. A success with a body is read as the stream, whatever its type.
    if (response.ok && response.body) {
      awaitingResumption.delete(eventId);
      return track(response, waiting.request, init?.signal);
    }
    if (init?.signal?.aborted) return response;
    if (!response.ok) {
      // The SDK cancels the body before it looks at the status; a rejected cancel is a failed attempt it retries.
      // The rejection is passed on as the attempt's failure, since a second cancel may not reject again.
      let cancelFailure: { error: unknown } | undefined;
      await response.body?.cancel().catch((error: unknown) => { cancelFailure = { error }; });
      if (init?.signal?.aborted) return response;
      // 405: the server has no GET stream, and the SDK stops. A 401 is a failed attempt like any other: with an auth
      // provider the SDK signs in first, and if that fails or redirects it resumes with the event id again. If it
      // succeeds, the SDK reopens without the event id and the request waits out its timeout, as it does without
      // this adapter: nothing here can tell that reopen from the SDK's ordinary GET stream.
      if (cancelFailure || response.status !== 405) {
        if (++waiting.failures < SDK_RESUMPTION_ATTEMPTS) {
          if (cancelFailure) throw cancelFailure.error;
          return response;
        }
      }
    }
    // Recovery is over: a success with no body (the SDK reads nothing and never tries again), a 405, or the last attempt.
    awaitingResumption.delete(eventId);
    return drop(waiting.request)!;
  }

  return async (input, init) => {
    const eventId = init?.method === "GET" ? new Headers(init.headers).get("last-event-id") : null;
    if (eventId !== null && awaitingResumption.has(eventId)) return resume(input, init, eventId);
    const request = readJsonRpcRequest(init);
    const response = await baseFetch(input, init);
    if (!request || !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response;
    return track(response, request, init?.signal);
  };
}
