import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackageHomeClient } from "../src/clients/packageHomeClient.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import type { McpClient, PackageConfig } from "../src/types.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));

type Drop = "clean-end" | "socket-cut" | "open";

/** A streamable HTTP MCP server whose tools/call stream drops before any answer. */
async function startServer(drop: Drop): Promise<{ url: string; answering: Promise<void>; close: () => Promise<void> }> {
  let answerStarted!: () => void;
  const answering = new Promise<void>((resolve) => { answerStarted = resolve; });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" },
        } }));
        return;
      }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      answerStarted();
      if (drop === "open") return;
      setTimeout(() => { if (drop === "clean-end") res.end(); else res.destroy(); }, 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    answering,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const NOT_SETTLED = Symbol("not settled");
const settledWithin = (call: Promise<unknown>, ms: number) => Promise.race([
  call.then((value) => ({ value }), (error: unknown) => ({ error })),
  new Promise<typeof NOT_SETTLED>((resolve) => { setTimeout(() => resolve(NOT_SETTLED), ms); }),
]);

const config = (url: string): PackageConfig => ({
  id: "acme", name: "Acme", transport: "http", base_url: url, visibility: "default",
} as PackageConfig);

describe.each<Drop>(["clean-end", "socket-cut"])("a connector's answer stream drops: %s", (drop) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

  it.each<[string, (url: string) => McpClient]>([
    ["package-home route", (url) => new PackageHomeClient(config(url), { url, headers: {} })],
    ["direct HTTP route", (url) => new HttpMcpClient("acme", config(url)) as unknown as McpClient],
  ])("%s fails the call instead of leaving it waiting", async (_route, make) => {
    const server = await startServer(drop);
    cleanups.push(server.close);
    const client = make(server.url);
    cleanups.push(() => client.close().catch(() => undefined));
    await client.connect();
    const outcome = await settledWithin(client.callTool("exec", {}), 2_000);
    expect(outcome).not.toBe(NOT_SETTLED);
    expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("Connection closed") }) });
  });
});

describe.each<[string, (url: string) => McpClient]>([
  ["package-home route", (url) => new PackageHomeClient(config(url), { url, headers: {} })],
  ["direct HTTP route", (url) => new HttpMcpClient("acme", config(url))],
])("%s client close", (_route, make) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    logger.warn.mockClear();
  });

  it("rejects the open call with Connection closed without logging a dropped answer", async () => {
    const server = await startServer("open");
    cleanups.push(server.close);
    const client = make(server.url);
    cleanups.push(() => client.close().catch(() => undefined));
    await client.connect();
    const outcome = settledWithin(client.callTool("exec", {}), 2_000);
    await server.answering;
    // Let fetch deliver the open response body to the SDK before closing it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    logger.warn.mockClear();
    await client.close();
    expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("Connection closed") }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
