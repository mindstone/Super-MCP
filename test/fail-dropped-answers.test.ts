import { describe, expect, it, vi } from "vitest";
import { failDroppedAnswers } from "../src/clients/failDroppedAnswers.js";

const encode = (text: string) => new TextEncoder().encode(text);
const request = { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "exec" } };
const post = { method: "POST", body: JSON.stringify(request) };
const sse = { status: 201, statusText: "Created", headers: { "content-type": "text/event-stream", "x-fixture": "kept" } };

function fixture(parts: string[], error?: Error) {
  const onDrop = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (parts.length) controller.enqueue(encode(parts.shift()!));
      else if (error) controller.error(error);
      else controller.close();
    },
  });
  const response = new Response(source, sse);
  const fetch = failDroppedAnswers(vi.fn(async () => response), onDrop);
  return { response, fetch, onDrop };
}

describe("failDroppedAnswers", () => {
  it("forwards bytes and metadata unchanged before appending one error for a different request id", async () => {
    const original = ': héllo\r\ndata: {"jsonrpc":"2.0","id":9,"result":{}}\r\n\r\n';
    const { fetch, onDrop } = fixture([original]);
    const response = await fetch("https://connector.example", post);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-fixture")).toBe("kept");
    expect(await response.text()).toBe(original + '\n\ndata: {"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"Connection closed"}}\n\n');
    expect(onDrop).toHaveBeenCalledWith(request);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it.each(["result", "error"])("recognizes a multiline %s with CRLF split across chunks", async (field) => {
    const value = field === "error" ? '{"code":-32000,"message":"failed"}' : '{}';
    const parts = ['da', 'ta: {"jsonrpc":"2.0",\r', '\ndata: "id":0,', `\r\ndata: "${field}":${value}}\r`, '\n\r', '\n'];
    const original = parts.join("");
    const { fetch, onDrop } = fixture(parts);
    expect(await (await fetch("https://connector.example", post)).text()).toBe(original);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it.each(['id: resume\ndata: \n\n', 'data: {"jsonrpc":"2.0","id":0,"result":{}}\n\n'])(
    "preserves a read error after an event id or answer (%s)", async (first) => {
      const error = new Error("socket cut");
      const { fetch, onDrop } = fixture([first], error);
      const reader = (await fetch("https://connector.example", post)).body!.getReader();
      expect((await reader.read()).value).toEqual(encode(first));
      await expect(reader.read()).rejects.toBe(error);
      expect(onDrop).not.toHaveBeenCalled();
    },
  );

  it.each(['id: resume\n\n', 'id:\ndata: \n\n', 'id: bad\0id\ndata: \n\n', 'id: resume\ndata: unfinished'])(
    "fails a stream the SDK cannot resume (%s)", async (first) => {
      const { fetch, onDrop } = fixture([first]);
      expect(await (await fetch("https://connector.example", post)).text()).toContain('"message":"Connection closed"');
      expect(onDrop).toHaveBeenCalledWith(request);
    },
  );

  it.each(["close", "error"] as const)("preserves the source %s after abort without reporting a drop", async (end) => {
    const abort = new AbortController();
    const error = new Error("aborted read");
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const onDrop = vi.fn();
    const fetch = failDroppedAnswers(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }), sse)), onDrop);
    const reader = (await fetch("https://connector.example", { ...post, signal: abort.signal })).body!.getReader();
    const reading = reader.read();
    abort.abort();
    if (end === "error") {
      source.error(error);
      await expect(reading).rejects.toBe(error);
    } else {
      source.close();
      expect(await reading).toEqual({ value: undefined, done: true });
    }
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("delivers the synthetic error even if the drop logger throws", async () => {
    const fetch = failDroppedAnswers(vi.fn(async () => new Response("", sse)), () => { throw new Error("logger failed"); });
    expect(await (await fetch("https://connector.example", post)).text()).toContain('"message":"Connection closed"');
  });

  it("cancels the source without reporting a drop, even during a pending read", async () => {
    const cancel = vi.fn();
    const onDrop = vi.fn();
    const fetch = failDroppedAnswers(vi.fn(async () => new Response(new ReadableStream({ cancel }), sse)), onDrop);
    const reader = (await fetch("https://connector.example", post)).body!.getReader();
    const reading = reader.read();
    await reader.cancel("stopped");
    await reading;
    expect(cancel).toHaveBeenCalledWith("stopped");
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("reads a Request body before the base fetch consumes it", async () => {
    const onDrop = vi.fn();
    const fetch = failDroppedAnswers(vi.fn(async (input) => {
      await (input as Request).text();
      return new Response("", sse);
    }), onDrop);
    const response = await fetch(new Request("https://connector.example", post));
    expect(await response.text()).toContain('"message":"Connection closed"');
    expect(onDrop).toHaveBeenCalledWith(request);
  });

  it.each([
    ["GET", post.body, 200, "text/event-stream"],
    ["POST", "{}", 200, "text/event-stream"],
    ["POST", "invalid", 200, "text/event-stream"],
    ["POST", post.body, 400, "text/event-stream"],
    ["POST", post.body, 200, "application/json"],
  ])("returns ineligible responses untouched (%s %s %s %s)", async (method, body, status, contentType) => {
    const response = new Response("{}", { status, headers: { "content-type": contentType } });
    const onDrop = vi.fn();
    const fetch = failDroppedAnswers(vi.fn(async () => response), onDrop);
    expect(await fetch("https://connector.example", { method, body })).toBe(response);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
