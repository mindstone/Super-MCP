import { beforeEach, describe, expect, it, vi } from "vitest";

import { PackageRegistry } from "../registry.js";
import type { PackageConfig, SuperMcpConfig } from "../types.js";

// REBEL-7F9 Stage 2c (docs/plans/260803_rebel-7f9-swifteq-oauth-callback,
// arbitrator recall#1 F9): ambient HttpMcpClient construction used to default
// blind to OAuth callback port 5173 even when the connector's persisted DCR
// client lives on another port (the 8080 population grows with Stage 2b).
// Inert today (ambient clients are refresh-only and redirect-blocked), but the
// construction now resolves getSavedClientPort(packageId) and passes it
// through as coherence hardening.

const { getSavedClientPort, httpClientInstances } = vi.hoisted(() => ({
  getSavedClientPort: vi.fn(),
  httpClientInstances: [] as Array<{
    packageId: string;
    config: unknown;
    options: any;
  }>,
}));

vi.mock("../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../clients/httpClient.js", () => ({
  HttpMcpClient: class MockHttpMcpClient {
    connect = vi.fn(async () => {});
    constructor(packageId: string, config: unknown, options?: unknown) {
      httpClientInstances.push({ packageId, config, options });
    }
  },
}));

vi.mock("../auth/providers/simple.js", () => ({
  SimpleOAuthProvider: class {
    static getSavedClientPort = getSavedClientPort;
  },
}));

function createRegistry(): PackageRegistry {
  const config: SuperMcpConfig = { mcpServers: {} };
  return new PackageRegistry(config);
}

function httpPackage(id: string, oauth: boolean): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    base_url: "https://mcp.example.com/mcp",
    oauth,
    visibility: "default",
  } as PackageConfig;
}

describe("PackageRegistry ambient OAuth port coherence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    httpClientInstances.length = 0;
  });

  it("ambient HTTP client for an OAuth connector is constructed with the saved callback port", async () => {
    getSavedClientPort.mockResolvedValue(8080);
    const registry = createRegistry();
    const pkg = httpPackage("Swifteq-test", true);

    await (registry as any).createAndConnectClient(pkg.id, pkg);

    expect(getSavedClientPort).toHaveBeenCalledWith("Swifteq-test");
    expect(httpClientInstances).toHaveLength(1);
    expect(httpClientInstances[0].options).toEqual({ oauthPort: 8080 });
  });

  it("no saved client → constructed without an explicit port (default preserved)", async () => {
    getSavedClientPort.mockResolvedValue(undefined);
    const registry = createRegistry();
    const pkg = httpPackage("Fresh-test", true);

    await (registry as any).createAndConnectClient(pkg.id, pkg);

    expect(httpClientInstances).toHaveLength(1);
    expect(httpClientInstances[0].options?.oauthPort).toBeUndefined();
  });

  it("non-OAuth connectors never consult the saved client registration", async () => {
    const registry = createRegistry();
    const pkg = httpPackage("Plain-test", false);

    await (registry as any).createAndConnectClient(pkg.id, pkg);

    expect(getSavedClientPort).not.toHaveBeenCalled();
    expect(httpClientInstances).toHaveLength(1);
    expect(httpClientInstances[0].options?.oauthPort).toBeUndefined();
  });
});
