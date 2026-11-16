import http from "node:http";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logger } = vi.hoisted(() => ({
  logger: {
    setLevel: vi.fn(), info: vi.fn(), debug: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  },
}));

// Isolate connector/config startup; startServer's HTTP wiring of the
// shutdown route is the real production code.
vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("../src/registry.js", () => ({
  PackageRegistry: {
    fromConfigFiles: async () => ({ startIdleReaper() {}, async closeAll() {} }),
  },
}));
vi.mock("../src/catalog.js", () => ({ Catalog: class {} }));
vi.mock("../src/catalogRefresher.js", () => ({
  CatalogRefresher: class { start() {} async dispose() {} },
}));
vi.mock("../src/configWatcher.js", () => ({
  ConfigWatcher: class { async start() {} async stop() {} },
}));
vi.mock("../src/validator.js", () => ({ getValidator: () => ({}) }));

import { startServer } from "../src/server.js";

const OWNER_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("POST /api/shutdown on a router started with only the health owner id", () => {
  // Rebel passes only --rebel-health-owner-id when it can't read its own start
  // time, so there is no watchdog ownerInfo; the route must still check the id.
  let httpServer: http.Server | undefined;
  let port: number;
  let exit: ReturnType<typeof vi.spyOn>;
  let previousSigint: NodeJS.SignalsListener[];
  let previousSigterm: NodeJS.SignalsListener[];

  beforeEach(async () => {
    vi.clearAllMocks();
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const realCreateServer = http.createServer;
    vi.spyOn(http, "createServer").mockImplementation((...args: Parameters<typeof http.createServer>) => {
      httpServer = realCreateServer(...args);
      return httpServer;
    });
    previousSigint = process.listeners("SIGINT");
    previousSigterm = process.listeners("SIGTERM");
    await startServer({ transport: "http", port: 0, healthOwnerId: OWNER_ID });
    if (!httpServer!.listening) await once(httpServer!, "listening");
    const address = httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No HTTP listener");
    port = address.port;
  });

  afterEach(async () => {
    for (const listener of process.listeners("SIGINT")) {
      if (!previousSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!previousSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    if (httpServer?.listening) {
      const closed = new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer.closeAllConnections();
      await closed;
    }
    httpServer = undefined;
    vi.restoreAllMocks();
  });

  async function requestShutdown(ownerId?: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: ownerId ? { "x-super-mcp-owner-id": ownerId } : {},
    });
    await response.body?.cancel();
    return response.status;
  }

  it("refuses a missing or wrong owner id and accepts the right one", async () => {
    expect(await requestShutdown()).toBe(403);
    expect(await requestShutdown("00000000-0000-4000-8000-000000000000")).toBe(403);
    expect(exit).not.toHaveBeenCalled();

    expect(await requestShutdown(OWNER_ID)).toBe(202);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
