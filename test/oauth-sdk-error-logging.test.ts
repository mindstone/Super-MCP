import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { exchangeAuthorization, parseErrorResponse, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { handleAuthenticate } from "../src/handlers/authenticate.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import { oauthErrorLogFields, oauthErrorLogText } from "../src/auth/oauthErrorLogging.js";
import type { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";
import type { PackageConfig } from "../src/types.js";

const logger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock("../src/logging.js", () => ({ getLogger: () => logger }));
vi.mock("../src/utils/portFinder.js", () => ({
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
  getOAuthCallbackPortCandidates: vi.fn(() => [5173]),
  getOAuthCallbackRetryCandidates: vi.fn(() => []),
}));
vi.mock("../src/auth/callbackServer.js", () => ({
  OAuthCallbackServer: class {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    waitForCallback = vi.fn(async () => "authorization-code");
    stop = vi.fn(async () => {});
  },
}));

const SENTINEL = "oauth-provider-description-sentinel";
const config: PackageConfig = {
  id: "Acme-log-safety", name: "Acme", transport: "http",
  base_url: "https://mcp.example.com/mcp", oauth: true, visibility: "default",
};

function errorResponse(error: string): Response {
  return new Response(JSON.stringify({ error, error_description: SENTINEL }), {
    status: 400, headers: { "Content-Type": "application/json" },
  });
}

function expectSafeLogs(): void {
  expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls)))
    .not.toContain(SENTINEL);
}

function registry(): PackageRegistry {
  return {
    getPackage: vi.fn(() => config),
    getClient: vi.fn().mockRejectedValue(new Error("not connected")),
    clients: new Map(),
  } as unknown as PackageRegistry;
}

describe("SDK OAuth error logging", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-oauth-log-"));
    vi.stubEnv("SUPER_MCP_OAUTH_TOKEN_DIR", tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("logs only the code when the SDK authorization-code exchange fails", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => errorResponse("invalid_grant"));
    vi.spyOn(HttpMcpClient.prototype, "connectWithOAuth").mockImplementation(async function (this: HttpMcpClient) {
      // Keep finishOAuth and the handler real; replace the transport's I/O only.
      (this as unknown as { transport: { finishAuth: (code: string) => Promise<unknown> } }).transport = {
        finishAuth: (authorizationCode) => exchangeAuthorization("https://oauth.example.com", {
          clientInformation: { client_id: "acme-client" },
          authorizationCode, codeVerifier: "verifier", redirectUri: "http://localhost:5173/callback",
          fetchFn,
        }),
      };
    });

    await handleAuthenticate({ package_id: config.id, wait_for_completion: true }, registry(), {} as Catalog);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain("grant_type=authorization_code");
    expect(logger.error).toHaveBeenCalledWith("OAuth failed", expect.objectContaining({ error: "invalid_grant" }));
    expectSafeLogs();
  });

  it("preserves the SDK error in the authentication result while redacting the outer catch log", async () => {
    const error = await parseErrorResponse(errorResponse("invalid_grant"));
    vi.spyOn(SimpleOAuthProvider, "getSavedClientPort").mockRejectedValue(error);

    const result = await handleAuthenticate(
      { package_id: config.id, wait_for_completion: true }, registry(), {} as Catalog,
    );

    expect(JSON.parse(result.content[0].text).error).toBe(SENTINEL);
    expect(error.message).toBe(SENTINEL);
    expect(logger.error).toHaveBeenCalledWith("Authentication failed", {
      package_id: config.id, error: "invalid_grant",
    });
    expectSafeLogs();
  });

  it("logs only the code when an SDK refresh failure propagates through both connect catches", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => errorResponse("invalid_scope"));
    vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {
      await refreshAuthorization("https://oauth.example.com", {
        clientInformation: { client_id: "acme-client" }, refreshToken: "refresh-token", fetchFn,
      });
    });
    const client = new HttpMcpClient(config.id, config);

    await expect(client.connectWithOAuth()).rejects.toMatchObject({
      errorCode: "invalid_scope", message: expect.stringContaining(SENTINEL),
    });

    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain("grant_type=refresh_token");
    for (const message of ["Failed to connect to MCP server", "Unexpected error during OAuth connect"]) {
      expect(logger.error).toHaveBeenCalledWith(message, { package_id: config.id, error: "invalid_scope" });
    }
    expectSafeLogs();
  });

  it.each(["http", "sse"] as const)("redacts both SDK errors in %s transport fallback logs", async (transportType) => {
    const original = await parseErrorResponse(errorResponse("invalid_request"));
    original.message = `HTTP 404 ${SENTINEL}`;
    const fallback = await parseErrorResponse(errorResponse("invalid_scope"));
    vi.spyOn(Client.prototype, "connect")
      .mockRejectedValueOnce(original).mockRejectedValueOnce(fallback);
    const client = new HttpMcpClient(config.id, { ...config, transportType });

    await expect(client.connect()).rejects.toThrow("Transport negotiation failed");

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("fallback also failed"), {
      package_id: config.id, original_error: "invalid_request", fallback_error: "invalid_scope",
    });
    expectSafeLogs();
  });

  it("bounds unknown codes and raw bodies, and preserves non-OAuth text", async () => {
    for (const body of [errorResponse(SENTINEL), new Response(SENTINEL, { status: 500 })]) {
      const error = await parseErrorResponse(body);
      expect(error.message).toContain(SENTINEL);
      expect(oauthErrorLogText(error, error.message)).toBe("unrecognized");
      expect(error.message).toContain(SENTINEL);
    }
    expect(oauthErrorLogFields({ error: SENTINEL, error_description: SENTINEL })).toEqual({ error: "unrecognized" });
    expect(oauthErrorLogText(new Error("ordinary error"), "ordinary error")).toBe("ordinary error");
    expect(oauthErrorLogText({ message: "structured error" }, "structured error")).toBe("structured error");
  });
});
