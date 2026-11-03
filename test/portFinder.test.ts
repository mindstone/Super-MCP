import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import {
  checkPortAvailable,
  findAvailablePort,
  OAUTH_CALLBACK_HOST_V4,
  OAUTH_CALLBACK_HOST_V6,
} from "../src/utils/portFinder.js";

/**
 * Dual-stack OAuth callback port selection.
 *
 * Regression cover for docs/investigations/260225_oauth_callback_connection_refused.md —
 * prior behaviour only checked IPv4, so a port held on `::1` by an unrelated process
 * (e.g. rebel-platform's Vite dev server) looked free, was chosen as the OAuth
 * callback port, and the browser silently hit the wrong process on IPv6.
 */

type StackedServer = {
  server: net.Server;
  close: () => Promise<void>;
};

async function bindTo(host: string, port = 0): Promise<StackedServer & { port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(port, host);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function getFreePort(host: string): Promise<number> {
  const s = await bindTo(host, 0);
  const port = s.port;
  await s.close();
  return port;
}

function ipv6LoopbackUsable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(0, OAUTH_CALLBACK_HOST_V6);
  });
}

describe("portFinder dual-stack availability", () => {
  const openServers: StackedServer[] = [];

  afterEach(async () => {
    while (openServers.length) {
      const s = openServers.pop();
      if (s) await s.close();
    }
  });

  it("returns true when both IPv4 and IPv6 loopback are free", async () => {
    const port = await getFreePort(OAUTH_CALLBACK_HOST_V4);
    const ok = await checkPortAvailable(port);
    expect(ok).toBe(true);
  });

  it("returns false when IPv4 loopback is busy", async () => {
    const s = await bindTo(OAUTH_CALLBACK_HOST_V4, 0);
    openServers.push(s);
    const ok = await checkPortAvailable(s.port);
    expect(ok).toBe(false);
  });

  it("returns false when IPv6 loopback is busy on an otherwise free port (the bug we are fixing)", async () => {
    if (!(await ipv6LoopbackUsable())) {
      // No IPv6 loopback here — this scenario can't be produced; skip.
      return;
    }
    // Bind only to ::1. 127.0.0.1 is still free, which mimics rebel-platform's Vite
    // holding port 5175 on IPv6 while Super-MCP tries to pick the same port.
    const s = await bindTo(OAUTH_CALLBACK_HOST_V6, 0);
    openServers.push(s);
    const ok = await checkPortAvailable(s.port);
    expect(ok).toBe(false);
  });

  it("findAvailablePort skips ports that are busy on either stack", async () => {
    // Hold an IPv4-only busy port, picked by the OS so no other test can
    // already hold it; findAvailablePort should advance past it.
    const v4 = await bindTo(OAUTH_CALLBACK_HOST_V4, 0);
    openServers.push(v4);
    const start = v4.port;

    let v6: StackedServer | undefined;
    if (await ipv6LoopbackUsable()) {
      try {
        v6 = await bindTo(OAUTH_CALLBACK_HOST_V6, start + 1);
        openServers.push(v6);
      } catch {
        // Something else grabbed start+1 between probes; leave only the v4 block.
      }
    }

    const port = await findAvailablePort(start, 10);
    expect(port).toBeGreaterThan(start); // skipped the busy v4 port
    if (v6) {
      expect(port).not.toBe(v6.port); // skipped the busy v6 port too
    }
  });
});
