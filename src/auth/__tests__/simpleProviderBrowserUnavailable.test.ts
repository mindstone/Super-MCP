import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, mockLogger } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

import { OAUTH_BROWSER_UNAVAILABLE_CODE, SimpleOAuthProvider } from "../providers/simple.js";

const AUTH_URL = new URL("https://auth.example.com/authorize?client_id=test-client");
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

function makeProvider(platform: NodeJS.Platform = "linux") {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const provider = new SimpleOAuthProvider("browser-unavailable-test");
  provider.setSkipAuthorizeProbe(true);
  return provider;
}

async function expectPending(signal: Promise<Error>) {
  const settled = vi.fn();
  signal.then(settled);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SimpleOAuthProvider browser unavailable signal", () => {
  it.each(["linux", "darwin", "win32"] as const)("settles on a spawn error on %s", async (platform) => {
    const provider = makeProvider(platform);
    const signal = provider.browserUnavailable();
    await provider.redirectToAuthorization(AUTH_URL);
    child.emit("error", new Error("spawn launcher ENOENT"));

    const error = await signal;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: OAUTH_BROWSER_UNAVAILABLE_CODE });
    child.emit("error", new Error("another launch failure"));
    expect(await provider.browserUnavailable()).toBe(error);
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to open browser", {
      package_id: "browser-unavailable-test",
      error: "spawn launcher ENOENT",
    });
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(AUTH_URL.toString());
  });

  it("settles when spawn throws synchronously", async () => {
    const provider = makeProvider();
    const signal = provider.browserUnavailable();
    spawnMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });

    await expect(provider.redirectToAuthorization(AUTH_URL)).resolves.toBeUndefined();
    await expect(signal).resolves.toMatchObject({ code: "OAUTH_BROWSER_UNAVAILABLE" });
  });

  it.each([
    ["linux", "xdg-open"],
    ["darwin", "open"],
  ] as const)("settles on a non-zero %s launcher exit", async (platform, launcher) => {
    const provider = makeProvider(platform);
    const settled = vi.fn();
    provider.browserUnavailable().then(settled);
    await provider.redirectToAuthorization(AUTH_URL);
    expect(spawnMock).toHaveBeenCalledWith(launcher, [AUTH_URL.toString()], expect.any(Object));
    child.emit("exit", 3, null);

    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OAUTH_BROWSER_UNAVAILABLE" }),
    ));
  });

  it.each(["linux", "darwin"] as const)("stays pending on exit 0 on %s", async (platform) => {
    const provider = makeProvider(platform);
    const signal = provider.browserUnavailable();
    await provider.redirectToAuthorization(AUTH_URL);
    child.emit("exit", 0, null);
    await expectPending(signal);
  });

  it("ignores an unreliable non-zero rundll32 exit", async () => {
    const provider = makeProvider("win32");
    const signal = provider.browserUnavailable();
    await provider.redirectToAuthorization(AUTH_URL);
    expect(spawnMock).toHaveBeenCalledWith(
      "rundll32", ["url.dll,FileProtocolHandler", AUTH_URL.toString()], expect.any(Object),
    );
    child.emit("exit", 1, null);
    await expectPending(signal);
  });

  it("stays pending when the launcher starts successfully", async () => {
    const provider = makeProvider();
    const signal = provider.browserUnavailable();
    await provider.redirectToAuthorization(AUTH_URL);
    child.emit("spawn");
    expect(child.unref).toHaveBeenCalledOnce();
    await expectPending(signal);
  });
});
