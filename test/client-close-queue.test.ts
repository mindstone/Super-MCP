import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type PQueue from "p-queue";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { StdioMcpClient } from "../src/clients/stdioClient.js";
import type { PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

it("delivers a running stdio call's answer while the SDK is closing", async () => {
  const client = new StdioMcpClient("acme", {
    id: "acme", name: "Acme", transport: "stdio", visibility: "default", command: "unused",
  });
  const internals = client as unknown as { client: Client };
  const answer = { content: [{ type: "text", text: "finished during close" }] };
  let deliverAnswer!: () => void;
  vi.spyOn(internals.client, "callTool").mockImplementation(() => new Promise((resolve) => {
    deliverAnswer = () => resolve(answer);
  }));
  vi.spyOn(internals.client, "close").mockImplementation(async () => {
    // Model the SDK waiting for the child's exit while stdout still delivers an answer.
    await Promise.resolve();
    deliverAnswer();
  });
  const running = client.callTool("exec", {});
  const result = expect(running).resolves.toEqual(answer);
  await client.close();
  await result;
});

describe.each(["http", "stdio"] as const)("%s close settles queued requests", (transport) => {
  it.each(["callTool", "listTools", "listResources", "readResource", "healthCheck"] as const)(
    "rejects queued %s without invoking its callback",
    async (method) => {
      const config: PackageConfig = {
        id: "acme", name: "Acme", transport, visibility: "default",
        base_url: "https://connector.example/mcp", command: "unused",
      };
      const client = transport === "http"
        ? new HttpMcpClient(config.id, config) : new StdioMcpClient(config.id, config);
      const internals = client as unknown as { client: Client; requestQueue: PQueue; isConnected: boolean };
      internals.isConnected = true;
      internals.requestQueue.concurrency = 1;
      let finish!: () => void;
      vi.spyOn(internals.client, "callTool").mockImplementation(() => new Promise((resolve) => {
        finish = () => resolve({ content: [] });
      }));
      // Occupy the only slot, so the next request must wait in the real queue.
      const running = client.callTool("slow", {}).catch((error: unknown) => error);
      const callback = vi.spyOn(internals.client, method === "healthCheck" ? "listTools" : method).mockResolvedValue({ tools: [], resources: [], contents: [] } as never);
      if (method === "callTool") callback.mockClear();
      const queued = method === "callTool" ? client.callTool("queued", {})
        : method === "readResource" ? client.readResource("test:///queued") : client[method]();
      // Attach rejection handling before close aborts any job.
      const outcome = queued.then((value) => ({ value }), (error: unknown) => ({ error }));
      expect(internals.requestQueue.size).toBe(1);
      vi.spyOn(internals.client, "close").mockImplementation(async () => { finish(); });
      await client.close();
      await running;
      expect(callback).not.toHaveBeenCalled();
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        outcome,
        new Promise((resolve) => { timer = setTimeout(() => resolve("still pending"), 100); }),
      ]).finally(() => clearTimeout(timer));
      if (method === "healthCheck") expect(result).toEqual({ value: "error" });
      else expect(result).toMatchObject({ error: { code: ErrorCode.ConnectionClosed, message: expect.stringContaining("Connection closed") } });
    },
  );

  it("accepts work after reconnecting with a fresh queue signal", async () => {
    const config: PackageConfig = {
      id: "acme", name: "Acme", transport, visibility: "default",
      base_url: "https://connector.example/mcp", command: "unused",
    };
    const client = transport === "http"
      ? new HttpMcpClient(config.id, config) : new StdioMcpClient(config.id, config);
    const internals = client as unknown as { client: Client; queueAbort: AbortController };
    vi.spyOn(internals.client, "close").mockResolvedValue();
    vi.spyOn(internals.client, "connect").mockResolvedValue();
    vi.spyOn(internals.client, "callTool").mockResolvedValue({ content: [] });
    const previousSignal = internals.queueAbort.signal;
    await client.close();
    expect(previousSignal.aborted).toBe(true);
    await client.connect();
    expect(internals.queueAbort.signal).not.toBe(previousSignal);
    expect(internals.queueAbort.signal.aborted).toBe(false);
    await expect(client.callTool("exec", {})).resolves.toEqual({ content: [] });
    await client.close();
  });
});
