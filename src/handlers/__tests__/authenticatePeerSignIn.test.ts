import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
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
    redirects: true,
    callbacks: [] as Array<Promise<string>>,
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
    redirects = scenario.redirects;
    hasStartedRedirect = vi.fn(() => this.redirects);
    browserUnavailable = vi.fn(() => new Promise<Error>(() => {}));
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
    waitForCallback = vi.fn(() => scenario.callbacks.shift() ?? new Promise<string>(() => {}));
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const PACKAGE_ID = "peer-sign-in-test";

function makeRegistry() {
  return {
    getPackage: vi.fn((id: string) => ({
      id, name: id, transport: "http",
      base_url: "https://mcp.example.com/mcp", oauth: true,
    })),
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map(),
    notifyAuthOutcome: vi.fn(),
  };
}

function startAuthentication(
  registry: ReturnType<typeof makeRegistry>,
  input: { package_id: string; force?: boolean },
) {
  const completed = vi.fn();
  const promise = handleAuthenticate(
    { ...input, wait_for_completion: true },
    registry as unknown as PackageRegistry,
    { clearPackage: vi.fn() } as unknown as Catalog,
  );
  promise.then(completed);
  return { completed, promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  callbackServers.length = 0;
  attemptClients.length = 0;
  scenario.bootstrapConnects = false;
  scenario.redirects = true;
  scenario.callbacks = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("authenticate while another sign-in for the same connector finishes", () => {
  it.each([false, true])("stops waiting and reports signed in when the card's sign-in completes (bootstrap connects: %s)", async (bootstrapConnects) => {
    scenario.bootstrapConnects = bootstrapConnects;
    const agentCallback = deferred<string>();
    const cardCallback = deferred<string>();
    scenario.callbacks = [agentCallback.promise, cardCallback.promise];
    const registry = makeRegistry();
    const agent = startAuthentication(registry, { package_id: PACKAGE_ID });
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    if (bootstrapConnects) {
      await vi.waitFor(() => expect(attemptClients[0].healthCheck).toHaveBeenCalled());
    }

    // A connection that merely turns healthy is not a completed sign-in.
    registry.notifyAuthOutcome(PACKAGE_ID, "authenticated");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.completed).not.toHaveBeenCalled();

    // The sign-in card starts its own forced sign-in, which the person completes.
    const card = startAuthentication(registry, { package_id: PACKAGE_ID, force: true });
    await vi.waitFor(() => expect(callbackServers[1]?.waitForCallback).toHaveBeenCalled());
    cardCallback.resolve("card-code");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(agent.completed).toHaveBeenCalled(), { timeout: 200 });

    const agentResult = await agent.promise;
    expect(JSON.parse(agentResult.content[0].text)).toMatchObject({ package_id: PACKAGE_ID, status: "authenticated" });
    expect(agentResult.isError).toBe(false);
    expect(JSON.parse((await card.promise).content[0].text)).toMatchObject({ status: "authenticated" });
    expect(attemptClients[0].finishOAuth).not.toHaveBeenCalled();
    expect(attemptClients[0].close).toHaveBeenCalled();
    expect(attemptClients[1].finishOAuth).toHaveBeenCalledWith("card-code");
    expect(registry.clients.get(PACKAGE_ID)).toBe(attemptClients[1]);
    expect(callbackServers[0].stop).toHaveBeenCalledOnce();
  });

  it("keeps waiting when a different connector signs in", async () => {
    const agentCallback = deferred<string>();
    const otherCallback = deferred<string>();
    scenario.callbacks = [agentCallback.promise, otherCallback.promise];
    const registry = makeRegistry();
    const agent = startAuthentication(registry, { package_id: PACKAGE_ID });
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    const other = startAuthentication(registry, { package_id: "another-connector" });
    await vi.waitFor(() => expect(callbackServers[1]?.waitForCallback).toHaveBeenCalled());
    otherCallback.resolve("other-code");
    expect(JSON.parse((await other.promise).content[0].text)).toMatchObject({ status: "authenticated" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.completed).not.toHaveBeenCalled();
    agentCallback.resolve("agent-code");
    await agent.promise;
  });

  it("keeps waiting when another call only connects, without a sign-in", async () => {
    const agentCallback = deferred<string>();
    scenario.callbacks = [agentCallback.promise];
    const registry = makeRegistry();
    const agent = startAuthentication(registry, { package_id: PACKAGE_ID, force: true });
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    // The second call's bootstrap connects with no browser redirect.
    scenario.bootstrapConnects = true;
    scenario.redirects = false;
    const connectOnly = startAuthentication(registry, { package_id: PACKAGE_ID });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(connectOnly.completed).toHaveBeenCalled());
    expect(JSON.parse((await connectOnly.promise).content[0].text)).toMatchObject({ status: "authenticated" });
    expect(attemptClients[1].finishOAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.completed).not.toHaveBeenCalled();
    agentCallback.resolve("agent-code");
    expect(JSON.parse((await agent.promise).content[0].text)).toMatchObject({ status: "authenticated" });
    expect(attemptClients[0].finishOAuth).toHaveBeenCalledWith("agent-code");
  });

  it("uses its own code when its own sign-in completes", async () => {
    const callback = deferred<string>();
    scenario.callbacks = [callback.promise];
    const agent = startAuthentication(makeRegistry(), { package_id: PACKAGE_ID });
    await vi.waitFor(() => expect(callbackServers[0]?.waitForCallback).toHaveBeenCalled());
    callback.resolve("own-code");
    expect(JSON.parse((await agent.promise).content[0].text)).toMatchObject({ status: "authenticated" });
    expect(attemptClients[0].finishOAuth).toHaveBeenCalledWith("own-code");
  });
});
