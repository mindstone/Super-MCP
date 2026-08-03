import { describe, expect, it, vi } from "vitest";
import * as net from "net";

import { OAuthCallbackServer, OAUTH_CALLBACK_SERVER_STOPPED_MESSAGE } from "../callbackServer.js";

vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// REBEL-7F9 Stage 3 refinement (GPT F2 + runtime-safety F3): stop() must
// settle a pending waitForCallback waiter — otherwise every probe-rejected
// attempt leaks a live 300s timer + closure past teardown, and a callback
// arriving during teardown has no deterministic observable outcome.

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address() as net.AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe("OAuthCallbackServer stop() waiter cancellation", () => {
  it("stop() rejects a pending waiter with the distinct 'server stopped' error (never the 300s timeout)", async () => {
    // Never started: no sockets — stop() must still settle the waiter.
    const server = new OAuthCallbackServer(54_321);
    const waiter = server.waitForCallback(60_000, "state-a");
    waiter.catch(() => {}); // mirrors authenticate.ts's losing-promise suppression

    await server.stop();

    const outcome = await Promise.race([
      waiter.then(
        () => "resolved",
        (err: Error) => err.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 500)),
    ]);
    expect(outcome).toBe(OAUTH_CALLBACK_SERVER_STOPPED_MESSAGE);
    expect(outcome).not.toMatch(/timeout/i);
  });

  it("a late callback carrying an invalidated attempt's state cannot affect a subsequent attempt on the same port", async () => {
    const port = await freePort();

    // Attempt A (the probe-rejected shape): started, waiting on state-a, then
    // torn down while its waiter is still pending.
    const serverA = new OAuthCallbackServer(port);
    await serverA.start();
    const waiterA = serverA.waitForCallback(30_000, "state-a");
    waiterA.catch(() => {});
    await serverA.stop();
    await expect(waiterA).rejects.toThrow(OAUTH_CALLBACK_SERVER_STOPPED_MESSAGE);

    // Attempt B on the same port with a fresh state.
    const serverB = new OAuthCallbackServer(port);
    await serverB.start();
    const waiterB = serverB.waitForCallback(30_000, "state-b");
    waiterB.catch(() => {});

    try {
      // The LATE callback: attempt A's state finally arrives at the port.
      const lateRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=late-code&state=state-a`,
      );
      expect(lateRes.status).toBe(400); // state mismatch — rejected, not resolved

      // Attempt B's waiter is unaffected; the CORRECT callback still resolves it.
      const goodRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=real-code&state=state-b`,
      );
      expect(goodRes.status).toBe(200);
      await expect(waiterB).resolves.toBe("real-code");
    } finally {
      await serverB.stop();
    }
  }, 20_000);
});

// REBEL-7F9 Stage 4c (k3-r2 F1 + opus-r2 F2, convergent): the `?error=`
// branch settled the waiter via rejectCallback WITHOUT state validation —
// the last remaining late-redirect kill path. A stale
// `?error=access_denied&state=<stale>` from a superseded/foreign flow
// arriving at a port a newer attempt owns would reject the newer attempt's
// wait. The branch now applies the same state-check-then-settle pattern the
// Stage 3 refinement gave the `code` branch.
describe("OAuthCallbackServer ?error= branch state validation (REBEL-7F9 Stage 4c)", () => {
  it("a stale error-redirect (state mismatch) gets a 400 and does NOT settle the active wait", async () => {
    const port = await freePort();
    const server = new OAuthCallbackServer(port);
    await server.start();
    const waiter = server.waitForCallback(30_000, "state-new");
    let settled: string | undefined;
    waiter.then(
      () => {
        settled = "resolved";
      },
      (err: Error) => {
        settled = `rejected:${err.message}`;
      },
    );
    waiter.catch(() => {}); // mirrors authenticate.ts's losing-promise suppression

    try {
      // The LATE error-redirect: a superseded attempt's access_denied arrives
      // at the port the newer attempt now owns, carrying the stale state.
      const staleRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=state-stale`,
      );
      expect(staleRes.status).toBe(400); // state mismatch — rejected, not settled

      // Give any (incorrect) settlement a chance to propagate.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBeUndefined();

      // The matching-state error redirect still settles the wait — the guard
      // must not swallow THIS attempt's genuine provider error.
      const goodRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=state-new`,
      );
      expect(goodRes.status).toBe(200);
      await expect(waiter).rejects.toThrow("OAuth error: access_denied");
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("an error-redirect with NO state gets a 400 and does NOT settle the active wait", async () => {
    const port = await freePort();
    const server = new OAuthCallbackServer(port);
    await server.start();
    const waiter = server.waitForCallback(30_000, "state-new");
    let settled: string | undefined;
    waiter.then(
      () => {
        settled = "resolved";
      },
      (err: Error) => {
        settled = `rejected:${err.message}`;
      },
    );
    waiter.catch(() => {});

    try {
      const noStateRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?error=access_denied`,
      );
      expect(noStateRes.status).toBe(400);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBeUndefined();

      // Control: a matching-state error redirect settles the wait
      // (non-vacuous — the wait was genuinely still live).
      const goodRes = await fetch(
        `http://127.0.0.1:${port}/oauth/callback?error=server_error&state=state-new`,
      );
      expect(goodRes.status).toBe(200);
      await expect(waiter).rejects.toThrow("OAuth error: server_error");
    } finally {
      await server.stop();
    }
  }, 20_000);
});
