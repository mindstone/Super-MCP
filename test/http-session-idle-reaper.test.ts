import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logger, handleUseTool } = vi.hoisted(() => ({
  logger: {
    setLevel: vi.fn(), info: vi.fn(), debug: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  },
  handleUseTool: vi.fn(),
}));

// Isolate connector/config startup; the HTTP router, sweep and both SDK
// transports below are the real production implementations.
vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("../src/registry.js", () => ({
  PackageRegistry: { fromConfigFiles: async () => ({ startIdleReaper() {} }) },
}));
vi.mock("../src/catalog.js", () => ({ Catalog: class {} }));
vi.mock("../src/catalogRefresher.js", () => ({
  CatalogRefresher: class { start() {} },
}));
vi.mock("../src/configWatcher.js", () => ({
  ConfigWatcher: class { async start() {} },
}));
vi.mock("../src/validator.js", () => ({ getValidator: () => ({}) }));
vi.mock("../src/handlers/index.js", () => ({ handleUseTool }));

import { startServer } from "../src/server.js";

const MINUTE = 60_000;
const IDLE_LIMIT = 30 * MINUTE;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("HTTP session idle reaper", () => {
  let now: number;
  let sweep: () => void;
  let httpServer: http.Server | undefined;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let started: ReturnType<typeof deferred>;
  let release: ReturnType<typeof deferred>;
  let requests: Array<{
    method: string | undefined;
    body: { method?: string } | undefined;
    response: ServerResponse;
  }>;
  let intervals: ReturnType<typeof setInterval>[];
  let previousSigint: NodeJS.SignalsListener[];
  let previousSigterm: NodeJS.SignalsListener[];

  function wasReaped() {
    return logger.debug.mock.calls.some(([message]) =>
      message === "Reaping idle MCP session");
  }

  function toolResponse() {
    return requests.find((request) => request.body?.method === "tools/call")!.response;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    requests = [];
    intervals = [];
    started = deferred();
    release = deferred();
    handleUseTool.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "Tool completed" }] };
    });

    const realHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockImplementation(function (this: StreamableHTTPServerTransport, request: IncomingMessage, response: ServerResponse, body) {
        const method = typeof body === "object" && body !== null && "method" in body &&
          typeof body.method === "string" ? body.method : undefined;
        requests.push({ method: request.method, body: { method }, response });
        return realHandleRequest.call(this, request, response, body);
      });

    const realCreateServer = http.createServer;
    vi.spyOn(http, "createServer").mockImplementation((...args: Parameters<typeof http.createServer>) => {
      httpServer = realCreateServer(...args);
      return httpServer;
    });
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (delay !== 5 * MINUTE) return realSetInterval(callback, delay, ...args);
      // Capture the actual production sweep without waiting five minutes.
      sweep = callback as () => void;
      const interval = realSetInterval(() => {}, delay, ...args);
      intervals.push(interval);
      return interval;
    });
    previousSigint = process.listeners("SIGINT");
    previousSigterm = process.listeners("SIGTERM");
    await startServer({ transport: "http", port: 0 });
    if (!httpServer!.listening) await once(httpServer!, "listening");
    const address = httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No HTTP listener");

    client = new Client({ name: "idle-reaper-test", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    await client.connect(transport);
    // Wait for initialization's POST to close and the real background GET to open.
    await vi.waitFor(() => {
      expect(requests.some((request) => request.method === "GET")).toBe(true);
      expect(requests.filter((request) => request.method === "POST")
        .every((request) => request.response.closed)).toBe(true);
    });
  });

  afterEach(async () => {
    release?.resolve();
    await client?.close();
    intervals?.forEach(clearInterval);
    for (const listener of process.listeners("SIGINT")) {
      if (!previousSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!previousSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    if (httpServer?.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => error ? reject(error) : resolve());
      });
      httpServer.closeAllConnections();
      await closed;
    }
    httpServer = undefined;
    vi.restoreAllMocks();
  });

  function callTool(signal?: AbortSignal) {
    // Observe rejection immediately so a red assertion can still clean up safely.
    return client.callTool({ name: "use_tool", arguments: {} }, undefined, { timeout: 3_000, signal })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
  }

  it("keeps a session with an open tool POST, delivers the result, then idles from when it closed", async () => {
    const call = callTool();
    await started.promise;
    expect(toolResponse().closed).toBe(false);

    now += 31 * MINUTE;
    sweep();
    expect(wasReaped()).toBe(false);

    const completedAt = now;
    release.resolve();
    expect(await call).toEqual({
      result: { content: [{ type: "text", text: "Tool completed" }] },
    });
    await vi.waitFor(() => expect(toolResponse().closed).toBe(true));

    now = completedAt + IDLE_LIMIT;
    sweep();
    expect(wasReaped()).toBe(false);
    now += 1;
    sweep();
    expect(wasReaped()).toBe(true);
    await expect(client.ping()).rejects.toThrow(/Session not found/);
  });

  it("reaps a session whose cancelled call left its POST open, once no client can still be waiting", async () => {
    const abort = new AbortController();
    const call = callTool(abort.signal);
    await started.promise;
    abort.abort(); // Sends notifications/cancelled; the POST stream stays open.
    expect(await call).toEqual({ error: expect.any(Error) });
    // Client rejection precedes delivery of its cancellation notification.
    await vi.waitFor(() => expect(requests.find((request) =>
      request.body?.method === "notifications/cancelled")?.response.closed).toBe(true));
    release.resolve();
    expect(toolResponse().closed).toBe(false);

    now += 4 * 60 * MINUTE + IDLE_LIMIT;
    sweep();
    expect(wasReaped()).toBe(false);
    now += 1;
    sweep();
    expect(wasReaped()).toBe(true);
    await vi.waitFor(() => expect(toolResponse().closed).toBe(true));
    await expect(client.ping()).rejects.toThrow(/Session not found/);
  });

  it("still reaps a session with only a GET listening stream open", async () => {
    const listeningResponse = requests.find((request) => request.method === "GET")!.response;
    expect(listeningResponse.closed).toBe(false);
    now += 31 * MINUTE;
    sweep();
    expect(wasReaped()).toBe(true);
    await vi.waitFor(() => expect(listeningResponse.closed).toBe(true));
    await expect(client.ping()).rejects.toThrow(/Session not found/);
  });

  it("releases an open POST when its client aborts mid-call", async () => {
    const call = callTool();
    await started.promise;
    now += 31 * MINUTE;
    await client.close(); // Aborts the SDK transport's actual HTTP fetches.
    await call;
    await vi.waitFor(() => expect(toolResponse().closed).toBe(true));

    sweep();
    expect(wasReaped()).toBe(false);
    now += IDLE_LIMIT + 1;
    sweep();
    expect(wasReaped()).toBe(true);
  });
});
