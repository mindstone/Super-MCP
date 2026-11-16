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

  it("leaves a resumption alone when the request is aborted while its body is cancelled", async () => {
    const abort = new AbortController();
    const onDrop = vi.fn();
    const base = vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === "POST"
      ? new Response(encode("id: ev-1\ndata: \n\n"), sse)
      : new Response(new ReadableStream({ cancel() { abort.abort(); } }), { status: 405 }));
    const fetch = failDroppedAnswers(base as typeof globalThis.fetch, onDrop);
    await (await fetch("https://connector.example", post)).text();
    const response = await fetch("https://connector.example", { method: "GET", headers: { "last-event-id": "ev-1" }, signal: abort.signal });
    expect(response.status).toBe(405);
    expect(onDrop).not.toHaveBeenCalled();
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

describe("failDroppedAnswers with the SDK's stream resumption (REBEL-6GZ)", () => {
  // The real SDK transport: a primed POST stream that ends before the answer is resumed by GET with last-event-id.
  const fast = { initialReconnectionDelay: 5, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 2 };
  async function run(
    get: (attempt: number, headers: Headers, url: string) => Promise<Response>,
    // The SDK's default retry count, with short delays so the test is fast; null uses the SDK's own defaults.
    reconnectionOptions: typeof fast | null = fast,
    // A real auth provider, whose token endpoint answers with `token()`: the transport then signs in after a 401.
    signIn?: { token: () => Response },
  ) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const onDrop = vi.fn();
    const gets: (string | null)[] = [];
    const allGets: (string | null)[] = [];
    const base = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (signIn && String(input) === "https://auth.example/token") return signIn.token();
      if (init?.method === "POST") return new Response(encode("id: ev-1\ndata: \n\n"), sse);
      const headers = new Headers(init?.headers);
      gets.push(headers.get("last-event-id"));
      allGets.push(headers.get("last-event-id"));
      return get(gets.length, headers, String(input));
    });
    const transport = new StreamableHTTPClientTransport(new URL("https://connector.example/mcp"), {
      fetch: failDroppedAnswers(base as typeof fetch, onDrop),
      ...(reconnectionOptions ? { reconnectionOptions } : {}),
      ...(signIn ? { authProvider } : {}),
    });
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = () => {};
    await transport.start();
    await transport.send(request as never);
    // The SDK's default delays (1 s, then 1.5 s) outlast vi.waitFor's 1 s default.
    if (reconnectionOptions) await vi.waitFor(() => expect(messages.length + gets.length).toBeGreaterThan(0));
    else await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0), { timeout: 8_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await transport.close();
    // After an error answer the SDK may open its ordinary token-less GET stream; only resumptions count here.
    return { messages, gets: gets.filter((id) => id !== null), allGets, onDrop };
  }
  const issuer = "https://auth.example/";
  // Signs in by refreshing its token; a refresh the server refuses falls back to a sign-in page (REDIRECT).
  const authProvider = {
    redirectUrl: "https://app.example/callback",
    clientMetadata: { redirect_uris: ["https://app.example/callback"] },
    clientInformation: () => ({ client_id: "client", issuer }),
    tokens: () => ({ access_token: "token", token_type: "Bearer", refresh_token: "refresh", issuer }),
    saveTokens: vi.fn(), saveCodeVerifier: vi.fn(), codeVerifier: () => "verifier",
    redirectToAuthorization: vi.fn(),
    discoveryState: () => ({
      authorizationServerUrl: issuer,
      resourceMetadata: { resource: "https://connector.example/mcp", authorization_servers: [issuer] },
      authorizationServerMetadata: {
        issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, response_types_supported: ["code"],
      },
    }),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const signedIn = { token: () => json({ access_token: "new", token_type: "Bearer" }) };
  const closed = { jsonrpc: "2.0", id: 0, error: { code: -32000, message: "Connection closed" } };
  const answer = { jsonrpc: "2.0", id: 0, result: { content: [] } };

  it("settles the request once every resumption GET fails, instead of leaving it pending", async () => {
    const { messages, gets, onDrop } = await run(async () => new Response("down", { status: 503 }));
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([closed]);
    expect(onDrop).toHaveBeenCalledWith(request);
  });

  it("settles the request when resumption throws (network down)", async () => {
    const { messages } = await run(async () => { throw new TypeError("fetch failed"); });
    expect(messages).toEqual([closed]);
  });

  it("settles the request at once when the server has no GET stream (405)", async () => {
    const { messages, gets } = await run(async () => new Response("", { status: 405 }));
    expect(gets).toEqual(["ev-1"]);
    expect(messages).toEqual([closed]);
  });

  const answered = () => new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), sse);

  // The SDK's reopen without the event id looks like its ordinary GET stream, which other requests' answers do not
  // depend on, so the adapter leaves it alone and the request waits out its timeout, as it does without the adapter.
  it("does not settle the request from the SDK's reopen after signing in succeeds", async () => {
    const { messages, gets, allGets, onDrop } = await run(async (_attempt, headers) =>
      headers.get("last-event-id") ? new Response("", { status: 401 }) : new Response(encode(": open\n\n"), sse), fast, signedIn);
    expect(gets).toEqual(["ev-1"]);
    expect(allGets.slice(0, 2)).toEqual(["ev-1", null]);
    expect(messages).toEqual([]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("delivers the answer when signing in succeeds but the reopen fails, so the SDK resumes with the event id", async () => {
    const { messages, allGets, onDrop } = await run(async (attempt, headers) =>
      attempt === 1 ? new Response("", { status: 401 })
      : headers.get("last-event-id") ? answered() : new Response("down", { status: 503 }), fast, signedIn);
    expect(allGets).toEqual(["ev-1", null, "ev-1"]);
    expect(messages).toEqual([answer]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it.each([
    ["sends the person to a sign-in page", () => json({ error: "server_error" }, 500)],
    ["fails", () => json({ error: "invalid_request" }, 400)],
  ])("delivers the answer when signing in after a 401 %s and the SDK resumes with the event id", async (_case, token) => {
    const { messages, gets, onDrop } = await run(async (attempt) =>
      attempt === 1 ? new Response("", { status: 401 }) : answered(), fast, { token });
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([answer]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("retries a 405 whose body fails to cancel, as the SDK does, and delivers the answer", async () => {
    const refusesCancel = () => new ReadableStream({ cancel() { throw new TypeError("cancel failed"); } });
    const { messages, gets } = await run(async (attempt) => attempt === 1 ? new Response(refusesCancel(), { status: 405 }) : answered());
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([answer]);
  });

  it("retries a 401 like any failure when the transport cannot sign in, as the SDK does", async () => {
    const { messages, gets } = await run(async (attempt) => attempt === 1
      ? new Response("", { status: 401 })
      : new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), sse));
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([answer]);
  });

  it("settles the request when a resumption succeeds with no body, which the SDK never retries", async () => {
    const { messages, gets, onDrop } = await run(async () => new Response(null, { status: 204 }));
    expect(gets).toEqual(["ev-1"]);
    expect(messages).toEqual([closed]);
    expect(onDrop).toHaveBeenCalledWith(request);
  });

  it.each(["Text/Event-Stream", "text/plain"])("delivers a resumed answer labelled %s, as the SDK reads it", async (contentType) => {
    const { messages, onDrop } = await run(async (attempt) => attempt === 1
      ? new Response("down", { status: 503 })
      : new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), { status: 200, headers: { "content-type": contentType } }));
    expect(messages).toEqual([answer]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("settles the request when a resumed stream ends with no new event id to resume from", async () => {
    const { messages } = await run(async (attempt) => attempt === 1 ? new Response(encode(": ping\n\n"), sse) : new Response("", { status: 405 }));
    expect(messages).toEqual([closed]);
  });

  it("delivers the real answer from a resumed stream and reports no drop", async () => {
    const { messages, onDrop } = await run(async (attempt) => attempt === 1
      ? new Response("down", { status: 503 })
      : new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), sse));
    expect(messages).toEqual([answer]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("settles the request with the SDK's own retry defaults", async () => {
    const { messages, gets } = await run(async () => new Response("down", { status: 503 }), null);
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([closed]);
  }, 15_000);

  const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

  it("does not count the SDK's same-origin redirects as failed resumptions", async () => {
    const { messages, onDrop } = await run(async (_attempt, _headers, url) =>
      url.endsWith("/mcp") ? redirect("/resume")
      : url.endsWith("/resume") ? redirect("/answer")
      : new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), sse));
    expect(messages).toEqual([answer]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("counts a redirected resumption once, by where it ends", async () => {
    const { messages, gets } = await run(async (_attempt, _headers, url) =>
      url.endsWith("/mcp") ? redirect("/resume") : new Response("down", { status: 503 }));
    // Two SDK attempts, each a redirect and a failure.
    expect(gets).toEqual(["ev-1", "ev-1", "ev-1", "ev-1"]);
    expect(messages).toEqual([closed]);
  });

  const cutOffBody = () => new ReadableStream({ start(controller) { controller.error(new TypeError("socket terminated")); } });

  it.each([503, 405])("settles the request when the last resumption's %i body is cut off", async (status) => {
    const { messages } = await run(async () => new Response(cutOffBody(), { status }));
    expect(messages).toEqual([closed]);
  });

  it.each([405, 401])("retries a %i whose body is cut off, as the SDK does, and delivers the answer", async (status) => {
    const { messages, gets } = await run(async (attempt) => attempt === 1
      ? new Response(cutOffBody(), { status })
      : new Response(encode(`id: ev-2\ndata: ${JSON.stringify(answer)}\n\n`), sse), fast, signedIn);
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([answer]);
  });

  it("counts a redirect whose body is cut off by where the attempt ends", async () => {
    const cutOff = () => new Response(cutOffBody(), { status: 307, headers: { location: "/resume" } });
    const { messages } = await run(async (attempt, _headers, url) =>
      attempt === 1 ? cutOff() : url.endsWith("/resume") ? new Response("down", { status: 503 }) : redirect("/resume"));
    expect(messages).toEqual([closed]);
  });

  it("counts a redirect the SDK will not follow as a failed resumption", async () => {
    const { messages, gets } = await run(async () => redirect("https://elsewhere.example/mcp"));
    expect(gets).toEqual(["ev-1", "ev-1"]);
    expect(messages).toEqual([closed]);
  });

  it("follows a resumed stream that ends with a new event id", async () => {
    const { messages, gets } = await run(async (attempt) => attempt === 1
      ? new Response(encode("id: ev-2\ndata: \n\n"), sse)
      : new Response("down", { status: 503 }));
    expect(gets).toEqual(["ev-1", "ev-2", "ev-2"]);
    expect(messages).toEqual([closed]);
  });
});
