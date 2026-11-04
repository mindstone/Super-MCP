import { afterEach, describe, expect, it, vi } from "vitest";
import { PackageHomeClient } from "../src/clients/packageHomeClient.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import type { McpClient } from "../src/types.js";
import { config, settledWithin } from "./helpers/droppedAnswer.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));

type Drop = "clean-end" | "socket-cut";

type Behavior = "concurrent" | "resume" | "answer" | "split" | "open";
const encode = (text: string) => new TextEncoder().encode(text);
const answer = (id: unknown) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } })}\r\n\r\n`;

/** Exercise the real SDK with fetch streams, without requiring a listening socket. */
async function startServer(drop: Drop, behavior: Behavior): Promise<{ url: string; close: () => Promise<void> }> {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let requestId: unknown;
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    if (init?.method !== "POST") {
      if (new Headers(init?.headers).has("last-event-id")) {
        return new Response(answer(requestId), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(null, { status: 405 });
    }
    const message = JSON.parse(init.body as string);
    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } }, { headers: { "mcp-session-id": "s1" } });
    if (message.id === undefined) return new Response(null, { status: 202 });
    requestId = message.id;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
        const abort = () => controller.error(init?.signal?.reason);
        if (init?.signal?.aborted) { abort(); return; }
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (behavior === "open") return;
        if (behavior === "resume") controller.enqueue(encode('retry: 1\nid: resume-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n'));
        const succeeds = behavior === "answer" || behavior === "split" ||
          (behavior === "concurrent" && message.params?.name === "healthy");
        if (succeeds) {
          const bytes = encode(answer(message.id));
          const split = behavior === "split" ? 17 : bytes.length;
          controller.enqueue(bytes.slice(0, split));
          timers.push(setTimeout(() => {
            if (split < bytes.length) controller.enqueue(bytes.slice(split));
            controller.close();
          }, 50));
        } else timers.push(setTimeout(() => {
          if (drop === "clean-end") controller.close(); else controller.error(new Error("socket cut"));
        }, 20));
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }));
  return {
    url: "https://connector.example/mcp",
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const controller of streams) { try { controller.close(); } catch { /* Already ended. */ } }
    },
  };
}

const routes: Array<[string, (url: string) => McpClient]> = [
  ["package-home", (url) => new PackageHomeClient(config(url), { url, headers: {} })],
  ["HTTP", (url) => new HttpMcpClient("acme", config(url))],
];

describe.each(routes)("%s answer stream behavior", (_route, make) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    logger.warn.mockClear();
  });
  async function connected(behavior: Behavior, drop: Drop = "clean-end") {
    const server = await startServer(drop, behavior);
    cleanups.push(server.close);
    const client = make(server.url);
    cleanups.push(() => client.close());
    await client.connect();
    return client;
  }

  it("keeps a concurrent call alive when the first stream drops, and logs connector and tool", async () => {
    const client = await connected("concurrent");
    const failed = settledWithin(client.callTool("exec", {}), 500);
    const healthy = client.callTool("healthy", {});
    expect(await failed).toMatchObject({ error: { code: -32000 } });
    expect(await healthy).toMatchObject({ content: [{ text: "done" }] });
    expect(logger.warn).toHaveBeenCalledWith("Answer stream ended before the answer", { package_id: "acme", method: "tools/call", tool_name: "exec" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each<Drop>(["clean-end", "socket-cut"])("lets the SDK resume a stream with an event id after %s", async (drop) => {
    const client = await connected("resume", drop);
    expect(await client.callTool("exec", {})).toMatchObject({ content: [{ text: "done" }] });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => new Headers(init?.headers).get("last-event-id") === "resume-1")).toBe(true);
  });

  it.each<Behavior>(["answer", "split"])("does not report a drop after an answer (%s)", async (behavior) => {
    const client = await connected(behavior);
    expect(await client.callTool("exec", {})).toMatchObject({ content: [{ text: "done" }] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("leaves an unanswered open stream pending just under the 90-minute limit", async () => {
    const client = await connected("open");
    vi.useFakeTimers();
    let settled = false;
    const call = client.callTool("exec", {}).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) =>
      typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call")).toBe(true);
    await vi.advanceTimersByTimeAsync(90 * 60_000 - 1);
    expect(settled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    await client.close();
    await call;
  });
});
