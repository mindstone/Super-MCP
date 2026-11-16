import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn() }),
}));

import { listenOnLoopback } from "../src/server.js";

// FOX-9654 / REBEL-7TK: a router that cannot take its port must fail its start,
// not report success and run without listening.

const servers: Array<{ close(cb?: () => void): unknown }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function holdLoopbackPort(): Promise<{ holder: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", () => {
      servers.push(holder);
      resolve({ holder, port: (holder.address() as AddressInfo).port });
    });
  });
}

describe("listenOnLoopback", () => {
  it("reports a port that is already taken as a failure, not a start", async () => {
    const { port } = await holdLoopbackPort();
    const onListening = vi.fn();

    const error = await new Promise<Error>((resolve) => {
      listenOnLoopback(express(), port, onListening, resolve);
    });

    expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    expect(onListening).not.toHaveBeenCalled();
  });

  it("starts on a free port", async () => {
    const onFailed = vi.fn();
    const server = await new Promise<ReturnType<typeof listenOnLoopback>>((resolve) => {
      const started = listenOnLoopback(express(), 0, () => resolve(started), onFailed);
    });
    servers.push(server);

    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    expect(onFailed).not.toHaveBeenCalled();
  });
});
