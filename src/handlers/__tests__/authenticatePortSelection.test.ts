import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

// REBEL-7F9 Stage 2b (docs/plans/260803_rebel-7f9-swifteq-oauth-callback):
// handler-level coverage of the Part A port-selection branch
// (authenticate.ts), previously untested — existing tests mock
// getSavedClientPort → null. Pins: saved-port available → reused (candidate
// scan skipped); saved-port busy → candidate scan; fresh → candidate scan with
// the non-static order; static-cred connectors get the 5173-first order.

const {
  mockLogger,
  callbackServerInstances,
  providerInstances,
  httpClientInstances,
  getSavedClientPort,
  checkPortAvailable,
  findAvailablePort,
  findAvailablePortFromCandidates,
  getOAuthCallbackPortCandidates,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  callbackServerInstances: [] as Array<{
    setServiceId: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    waitForCallback: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  providerInstances: [] as Array<Record<string, unknown>>,
  httpClientInstances: [] as Array<Record<string, unknown>>,
  getSavedClientPort: vi.fn(),
  checkPortAvailable: vi.fn(),
  findAvailablePort: vi.fn(),
  findAvailablePortFromCandidates: vi.fn(),
  getOAuthCallbackPortCandidates: vi.fn(),
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../utils/portFinder.js", () => ({
  findAvailablePort,
  checkPortAvailable,
  findAvailablePortFromCandidates,
  getOAuthCallbackPortCandidates,
}));

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = getSavedClientPort;
    oauthPort: number;
    staticCredentials: unknown;
    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    state = vi.fn(async () => "csrf-state");
    invalidateCredentials = vi.fn(async () => {});
    setSkipAuthorizeProbe = vi.fn();
    consumeProbeVerdict = vi.fn(() => undefined);
    static hasPersistedAccessToken = vi.fn(async () => false);
    constructor(packageId: string, oauthPort: number, staticCredentials?: unknown) {
      this.oauthPort = oauthPort;
      this.staticCredentials = staticCredentials;
      providerInstances.push({ packageId, oauthPort, staticCredentials });
    }
  }
  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

vi.mock("../../auth/callbackServer.js", () => {
  class MockOAuthCallbackServer {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    waitForCallback = vi.fn(async () => "auth-code-123");
    stop = vi.fn(async () => {});
    constructor(public port: number) {
      callbackServerInstances.push(this);
    }
  }
  return { OAuthCallbackServer: MockOAuthCallbackServer };
});

vi.mock("../../clients/httpClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../clients/httpClient.js")>();
  class MockHttpMcpClient {
    options: unknown;
    connectWithOAuth = vi.fn(() => new Promise<never>(() => {}));
    finishOAuth = vi.fn(async () => {});
    healthCheck = vi.fn(async () => "ok" as const);
    close = vi.fn(async () => {});
    constructor(packageId: string, config: unknown, options?: unknown) {
      this.options = options;
      httpClientInstances.push({ packageId, config, options });
    }
  }
  return { ...actual, HttpMcpClient: MockHttpMcpClient };
});

const PACKAGE_ID = "Swifteq-test";

function createRegistry(pkgOverrides: Record<string, unknown> = {}): PackageRegistry {
  const registry = {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "http",
      base_url: "https://mcp.example.com/mcp",
      oauth: true,
      ...pkgOverrides,
    }),
    // Pre-check: no usable client — fall through to the OAuth setup path.
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map<string, unknown>(),
  };
  return registry as unknown as PackageRegistry;
}

function createCatalog(): Catalog {
  return { clearPackage: vi.fn() } as unknown as Catalog;
}

async function runAuthenticate(registry: PackageRegistry) {
  const result = await handleAuthenticate(
    { package_id: PACKAGE_ID, wait_for_completion: true },
    registry,
    createCatalog(),
  );
  const parsed = JSON.parse(result.content[0].text);
  // Sanity: the flow completed successfully so the port assertions below are
  // about a REAL attempt, not an early error return.
  expect(parsed.status).toBe("authenticated");
  return parsed;
}

describe("handleAuthenticate port selection (Part A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callbackServerInstances.length = 0;
    providerInstances.length = 0;
    httpClientInstances.length = 0;
    getOAuthCallbackPortCandidates.mockReturnValue([5173, 8080, 5174]);
    findAvailablePortFromCandidates.mockResolvedValue(5173);
    findAvailablePort.mockResolvedValue(5173);
    checkPortAvailable.mockResolvedValue(true);
  });

  it("saved port available → reused; candidate scan skipped entirely", async () => {
    getSavedClientPort.mockResolvedValue(8080);
    checkPortAvailable.mockResolvedValue(true);

    await runAuthenticate(createRegistry());

    expect(checkPortAvailable).toHaveBeenCalledWith(8080);
    expect(getOAuthCallbackPortCandidates).not.toHaveBeenCalled();
    expect(findAvailablePortFromCandidates).not.toHaveBeenCalled();
    expect(providerInstances[0]?.oauthPort).toBe(8080);
    expect((httpClientInstances[0]?.options as { oauthPort?: number })?.oauthPort).toBe(8080);
  });

  it("saved port busy → candidate scan picks the port", async () => {
    getSavedClientPort.mockResolvedValue(8080);
    checkPortAvailable.mockResolvedValue(false);
    findAvailablePortFromCandidates.mockResolvedValue(5174);

    await runAuthenticate(createRegistry());

    expect(getOAuthCallbackPortCandidates).toHaveBeenCalledWith({ staticCredentials: false });
    expect(findAvailablePortFromCandidates).toHaveBeenCalledWith([5173, 8080, 5174]);
    expect(providerInstances[0]?.oauthPort).toBe(5174);
  });

  it("no saved client → candidate scan with the fresh non-static order", async () => {
    getSavedClientPort.mockResolvedValue(undefined);

    await runAuthenticate(createRegistry());

    expect(getOAuthCallbackPortCandidates).toHaveBeenCalledWith({ staticCredentials: false });
    expect(findAvailablePortFromCandidates).toHaveBeenCalledWith([5173, 8080, 5174]);
    expect(providerInstances[0]?.oauthPort).toBe(5173);
  });

  it("static-credential connector → 5173-first candidate order", async () => {
    getSavedClientPort.mockResolvedValue(undefined);

    await runAuthenticate(
      createRegistry({ oauthClientId: "static-id", oauthClientSecret: "static-secret" }),
    );

    expect(getOAuthCallbackPortCandidates).toHaveBeenCalledWith({ staticCredentials: true });
    expect(providerInstances[0]?.staticCredentials).toEqual({
      clientId: "static-id",
      clientSecret: "static-secret",
    });
  });
});
