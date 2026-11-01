import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import {
  OAuthCallbackServer,
  OAUTH_PROVIDER_ERROR_CODE,
} from "../src/auth/callbackServer.js";
import { OAUTH_CALLBACK_HOST_V4, findAvailablePort } from "../src/utils/portFinder.js";

function get(port: number, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: OAUTH_CALLBACK_HOST_V4, port, path, family: 4 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("OAuthCallbackServer: the provider's error redirect", () => {
  let server: OAuthCallbackServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("settles the wait with a coded error carrying the provider's code", async () => {
    expect(OAUTH_PROVIDER_ERROR_CODE).toEqual(expect.any(String));
    const port = await findAvailablePort(5173, 10);
    server = new OAuthCallbackServer(port);
    await server.start();
    const wait = server.waitForCallback(5_000, "expected-state");
    const settled = wait.catch((error: unknown) => error);

    expect(await get(port, "/oauth/callback?error=access_denied&state=expected-state")).toBe(200);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("OAuth error: access_denied");
    expect((error as NodeJS.ErrnoException).code).toBe(OAUTH_PROVIDER_ERROR_CODE);
  });

  it("leaves the wait running when the error redirect carries another attempt's state", async () => {
    const port = await findAvailablePort(5173, 10);
    server = new OAuthCallbackServer(port);
    await server.start();
    const settled = server.waitForCallback(300, "expected-state").catch((error: unknown) => error);

    expect(await get(port, "/oauth/callback?error=access_denied&state=stale-state")).toBe(400);

    const error = await settled;
    expect((error as Error).message).toBe("OAuth callback timeout");
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
  });
});
