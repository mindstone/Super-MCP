import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate, OAUTH_CALLBACK_TIMEOUT_MS } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

const { mockLogger, callbackServers, attemptClients, scenario } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  callbackServers: [] as Array<{
    waitForCallback: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  attemptClients: [] as Array<{
    finishOAuth: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  scenario: {
    bootstrapConnects: false,
    unavailable: undefined as unknown as Promise<Error>,
    callback: undefined as unknown as Promise<string>,
  },
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));
vi.mock("../../utils/portFinder.js", () => ({
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
  getOAuthCallbackPortCandidates: vi.fn(() => [5173, 8080, 5174]),
}));
vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = vi.fn(async () => null);
    static hasPersistedAccessToken = vi.fn(async () => false);
    static async readNeedsReconnectMarkerState() { return { state: "absent" as const }; }
    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    state = vi.fn(async () => "csrf-state");
    invalidateCredentials = vi.fn(async () => {});
    setSkipAuthorizeProbe = vi.fn();
    consumeProbeVerdict = vi.fn(() => undefined);
    getProbeVerdictForTrace = vi.fn(() => undefined);
    hasStartedRedirect = vi.fn(() => true);
    browserUnavailable = vi.fn(() => scenario.unavailable);
  }
  return {
    SimpleOAuthProvider: MockSimpleOAuthProvider,
    OAUTH_BROWSER_UNAVAILABLE_CODE: "OAUTH_BROWSER_UNAVAILABLE",
  };
});
vi.mock("../../auth/callbackServer.js", async (importOriginal) => {
  class MockOAuthCallbackServer {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    waitForCallback = vi.fn(() => scenario.callback);
    stop = vi.fn(async () => {});
    constructor() { callbackServers.push(this); }
  }
  return {
    ...(await importOriginal<typeof import("../../auth/callbackServer.js")>()),
    OAuthCallbackServer: MockOAuthCallbackServer,
  };
});
vi.mock("../../clients/httpClient.js", async (importOriginal) => {
  class MockHttpMcpClient {
    connectWithOAuth = vi.fn(() => scenario.bootstrapConnects
      ? Promise.resolve()
      : new Promise<void>(() => {}));
    isAuthenticated = vi.fn(async () => true);
    finishOAuth = vi.fn(async () => {});
    healthCheck = vi.fn(async () => "ok" as const);
    close = vi.fn(async () => {});
    constructor() { attemptClients.push(this); }
  }
  return {
    ...(await importOriginal<typeof import("../../clients/httpClient.js")>()),
    HttpMcpClient: MockHttpMcpClient,
  };
});

const PACKAGE_ID = "browser-unavailable-test";
const MESSAGE = "Sign-in needs a web browser, and none could be opened. Check that a default browser is set, or sign in from a computer that has one, then try again.";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function startAuthentication() {
  const registry = {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID, name: PACKAGE_ID, transport: "http",
      base_url: "https://mcp.example.com/mcp", oauth: true,
    }),
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map(),
  };
  const completed = vi.fn();
  const promise = handleAuthenticate(
    { package_id: PACKAGE_ID, wait_for_completion: true },
    registry as unknown as PackageRegistry,
    { clearPackage: vi.fn() } as unknown as Catalog,
  );
  promise.then(completed);
  return { registry, completed, promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  callbackServers.length = 0;
  attemptClients.length = 0;
  scenario.bootstrapConnects = false;
  scenario.unavailable = new Promise(() => {});
  scenario.callback = new Promise(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("authenticate when no browser can be opened", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("ends the wait (bootstrap connects: %s, probe disabled: %s)", async (bootstrapConnects, probeDisabled) => {
    scenario.bootstrapConnects = bootstrapConnects;
    vi.stubEnv("SUPER_MCP_OAUTH_PROBE_DISABLE", probeDisabled ? "1" : "0");
    const unavailable = deferred<Error>();
    scenario.unavailable = unavailable.promise;
    const { registry, completed, promise } = startAuthentication();
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    if (bootstrapConnects) {
      // Bootstrap won the first race; the client is registered before the second await.
      await vi.waitFor(() => expect(attemptClients[0].healthCheck).toHaveBeenCalled());
      expect(registry.clients.get(PACKAGE_ID)).toBe(attemptClients[0]);
    }
    expect(completed).not.toHaveBeenCalled();

    unavailable.resolve(Object.assign(new Error("launcher failed"), { code: "OAUTH_BROWSER_UNAVAILABLE" }));
    await vi.waitFor(() => expect(completed).toHaveBeenCalled(), { timeout: 200 });
    const result = await promise;
    expect(JSON.parse(result.content[0].text)).toEqual({ package_id: PACKAGE_ID, status: "auth_required", message: MESSAGE });
    expect(result.isError).toBe(false);
    expect(callbackServers).toHaveLength(1);
    expect(callbackServers[0].stop).toHaveBeenCalledOnce();
    expect(attemptClients[0].close).toHaveBeenCalled();
    expect(attemptClients[0].finishOAuth).not.toHaveBeenCalled();
    expect(registry.clients.has(PACKAGE_ID)).toBe(false);
  });

  it.each([false, true])("keeps waiting when the browser launches, then uses the callback code (bootstrap connects: %s)", async (bootstrapConnects) => {
    scenario.bootstrapConnects = bootstrapConnects;
    const callback = deferred<string>();
    scenario.callback = callback.promise;
    const { completed, promise } = startAuthentication();
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    expect(callbackServers[0].waitForCallback).toHaveBeenCalledWith(OAUTH_CALLBACK_TIMEOUT_MS, "csrf-state");
    await vi.advanceTimersByTimeAsync(OAUTH_CALLBACK_TIMEOUT_MS - 1);
    expect(completed).not.toHaveBeenCalled();
    expect(attemptClients[0].finishOAuth).not.toHaveBeenCalled();

    callback.resolve("browser-auth-code");
    await vi.waitFor(() => expect(completed).toHaveBeenCalled());
    const result = await promise;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ package_id: PACKAGE_ID, status: "authenticated" });
    expect(attemptClients[0].finishOAuth).toHaveBeenCalledWith("browser-auth-code");
    expect(attemptClients[0].close).not.toHaveBeenCalled();
    expect(callbackServers[0].stop).toHaveBeenCalledOnce();
  });
});
