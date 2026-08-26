import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import type { PackageRegistry } from "../../registry.js";

const {
  mockLogger,
  readNeedsReconnectMarkerState,
  findAvailablePortFromCandidates,
  getSavedClientPort,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  readNeedsReconnectMarkerState: vi.fn(),
  findAvailablePortFromCandidates: vi.fn(),
  getSavedClientPort: vi.fn(),
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../utils/portFinder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/portFinder.js")>();
  return {
    ...actual,
    findAvailablePortFromCandidates,
  };
});

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static readNeedsReconnectMarkerState = readNeedsReconnectMarkerState;
    static getSavedClientPort = getSavedClientPort;
    static hasPersistedAccessToken = vi.fn(async () => false);

    initialize = vi.fn(async () => {});
    invalidateCredentials = vi.fn(async () => {});
  }

  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

const PACKAGE_ID = "remote-connector-test";

function createRegistry() {
  const client = {
    healthCheck: vi.fn(async () => "ok" as const),
    listTools: vi.fn(async () => [{ name: "list_messages" }]),
    close: vi.fn(async () => {}),
  };
  const registry = {
    getPackage: vi.fn().mockReturnValue({
      id: PACKAGE_ID,
      name: PACKAGE_ID,
      transport: "http",
      base_url: "https://mcp.example.test/api",
      oauth: true,
    }),
    getClient: vi.fn().mockResolvedValue(client),
    clients: new Map([[PACKAGE_ID, client]]),
  };

  return {
    client,
    registry: registry as unknown as PackageRegistry,
  };
}

function createCatalog(): Catalog {
  return { clearPackage: vi.fn() } as unknown as Catalog;
}

function parseResult(result: any): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("handleAuthenticate reconnect marker pre-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readNeedsReconnectMarkerState.mockResolvedValue({ state: "absent" });
    getSavedClientPort.mockResolvedValue(undefined);
    findAvailablePortFromCandidates.mockRejectedValue(new Error("no test callback port"));
  });

  it("does not report already_authenticated when a reconnect marker is present despite healthy cached tool access", async () => {
    readNeedsReconnectMarkerState.mockResolvedValue({ state: "present" });
    const { client, registry } = createRegistry();

    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID },
      registry,
      createCatalog(),
    );
    const parsed = parseResult(result);

    expect(parsed.status).not.toBe("already_authenticated");
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(findAvailablePortFromCandidates).toHaveBeenCalledTimes(1);
  });

  it("preserves already_authenticated when the reconnect marker is absent", async () => {
    const { client, registry } = createRegistry();

    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID },
      registry,
      createCatalog(),
    );

    expect(parseResult(result).status).toBe("already_authenticated");
    expect(client.healthCheck).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(findAvailablePortFromCandidates).not.toHaveBeenCalled();
  });

  it("returns an honest error and logs only errno when the marker state cannot be read", async () => {
    readNeedsReconnectMarkerState.mockResolvedValue({
      state: "read-error",
      code: "EACCES",
    });
    const { client, registry } = createRegistry();

    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID },
      registry,
      createCatalog(),
    );
    const parsed = parseResult(result);

    expect(parsed).toEqual({
      package_id: PACKAGE_ID,
      status: "error",
      error: "Could not verify the package's authentication state. Please try again.",
    });
    expect(result.isError).toBe(true);
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.listTools).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Could not read OAuth reconnect marker",
      { code: "EACCES" },
    );
  });

  it("leaves explicit force authentication unchanged and skips the marker read", async () => {
    const { client, registry } = createRegistry();

    const result = await handleAuthenticate(
      { package_id: PACKAGE_ID, force: true },
      registry,
      createCatalog(),
    );

    expect(parseResult(result).status).toBe("error");
    expect(readNeedsReconnectMarkerState).not.toHaveBeenCalled();
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(findAvailablePortFromCandidates).toHaveBeenCalledTimes(1);
  });
});
