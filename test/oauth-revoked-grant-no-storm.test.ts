import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import http from "node:http";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import { HttpMcpClient } from "../src/clients/httpClient.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";
import type { PackageConfig } from "../src/types.js";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({ getLogger: () => mockLogger }));

const ENV_KEY = "SUPER_MCP_OAUTH_TOKEN_DIR";
const REVOKED_ACCESS_TOKEN = "revoked-but-still-in-date";
const REFRESH_TOKEN = "revoked-refresh";

async function startRevokedGrantServer(allowInitialize = false) {
  const counts: Record<string, number> = {};
  let baseUrl: string;
  let metadata: AuthorizationServerMetadata;
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url!, baseUrl).pathname;
    const key = `${req.method} ${requestPath}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && (
      requestPath === "/.well-known/oauth-protected-resource" ||
      requestPath === "/.well-known/oauth-protected-resource/mcp"
    )) {
      json(200, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
      return;
    }
    if (req.method === "GET" && requestPath === "/.well-known/oauth-authorization-server") {
      json(200, metadata);
      return;
    }
    if (req.method === "POST" && (requestPath === "/token" || (allowInitialize && requestPath === "/mcp"))) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (requestPath === "/token") {
          const form = new URLSearchParams(body);
          json(400, form.get("grant_type") === "refresh_token"
            ? { error: "invalid_grant", error_description: "The refresh token was revoked." }
            : { error: "unsupported_grant_type" });
          return;
        }
        // The QA shape: POSTs succeed, but the optional GET stream refuses auth.
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          json(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: {},
              serverInfo: { name: "revoked-grant-test", version: "1.0.0" },
            },
          }, { "mcp-session-id": "revoked-grant-session" });
        } else if (message.method === "notifications/initialized") {
          res.writeHead(202).end();
        } else {
          json(400, { error: "unexpected_method" });
        }
      });
      return;
    }
    if (requestPath === "/mcp") {
      json(401, { error: "invalid_token" }, {
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
  metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
  return {
    baseUrl,
    metadata,
    counts,
    count: (method: string, requestPath: string) => counts[`${method} ${requestPath}`] ?? 0,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function config(id: string, baseUrl: string): PackageConfig {
  return { id, name: id, base_url: `${baseUrl}/mcp`, transport: "http", oauth: true, visibility: "default" };
}

async function seedProvider(id: string): Promise<SimpleOAuthProvider> {
  const provider = new SimpleOAuthProvider(id, 5173);
  await provider.initialize();
  await provider.saveClientInformation({
    client_id: "public-client",
    redirect_uris: [provider.redirectUrl],
  });
  await provider.saveTokens({
    access_token: REVOKED_ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
  });
  return provider;
}

async function wrappedFetchFor(client: HttpMcpClient): Promise<typeof fetch> {
  const internals = client as unknown as {
    initializeOAuthIfNeeded(force: boolean): Promise<void>;
    getTransportOptions(): { fetch: typeof fetch };
  };
  await internals.initializeOAuthIfNeeded(false);
  return internals.getTransportOptions().fetch;
}

describe("FOX-5952: a refused in-date token cannot hide a revoked grant", () => {
  let tempDir: string;
  let previousTokenDir: string | undefined;
  let server: Awaited<ReturnType<typeof startRevokedGrantServer>> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousTokenDir = process.env[ENV_KEY];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-revoked-grant-"));
    process.env[ENV_KEY] = tempDir;
    server = undefined;
  });

  afterEach(async () => {
    await server?.close();
    if (previousTokenDir === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousTokenDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function markerExists(id: string): Promise<boolean> {
    return fs.access(path.join(tempDir, `${id}_needsReconnect.json`)).then(() => true, () => false);
  }

  it("POST connect refreshes once and marks the revoked grant dead", async () => {
    const id = "revoked-post";
    server = await startRevokedGrantServer();
    await seedProvider(id);
    const client = new HttpMcpClient(id, config(id, server.baseUrl));
    try {
      await expect(client.connect()).rejects.toThrow();
      const marker = await markerExists(id);
      expect.soft(server.count("POST", "/token"), JSON.stringify(server.counts)).toBe(1);
      expect.soft(marker).toBe(true);
      expect(server.count("POST", "/mcp") + server.count("GET", "/mcp")).toBeLessThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("GET stream stops after one real refresh through transport discovery and blocked redirect", async () => {
    const id = "revoked-get";
    server = await startRevokedGrantServer(true);
    await seedProvider(id);
    const client = new HttpMcpClient(id, config(id, server.baseUrl));
    try {
      await client.connect();
      await vi.waitFor(async () => {
        expect(await markerExists(id)).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith(
          "OAuth browser redirect blocked (refresh-only mode)", expect.any(Object),
        );
      }, { timeout: 5000, interval: 50 });
      expect.soft(server.count("GET", "/mcp"), JSON.stringify(server.counts)).toBeGreaterThan(0);
      expect.soft(server.count("GET", "/mcp"), JSON.stringify(server.counts)).toBeLessThanOrEqual(3);
      expect.soft(server.count("POST", "/token"), JSON.stringify(server.counts)).toBe(1);
    } finally {
      // Abort the real transport so even the unfixed recursive GET cannot escape.
      await client.close();
    }
  });

  it("records a lowercase bearer from record-shaped headers through the wrapper", async () => {
    const id = "revoked-record-headers";
    server = await startRevokedGrantServer();
    const provider = await seedProvider(id);
    const client = new HttpMcpClient(id, config(id, server.baseUrl), { oauthProvider: provider });
    try {
      const wrappedFetch = await wrappedFetchFor(client);
      const refused = await wrappedFetch(`${server.baseUrl}/mcp`, {
        headers: { authorization: `bearer ${REVOKED_ACCESS_TOKEN}` },
      });
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
      await expect(refreshAuthorization(server.baseUrl, {
        metadata: server.metadata,
        clientInformation: { client_id: "public-client" },
        refreshToken: REFRESH_TOKEN,
        fetchFn: wrappedFetch,
      })).rejects.toThrow();
      expect(server.count("POST", "/token")).toBe(1);
      expect(await markerExists(id)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reuses peer token B after the same wrapper observed token A's rejection", async () => {
    const id = "revoked-peer-reuse";
    server = await startRevokedGrantServer();
    const provider = await seedProvider(id);
    const client = new HttpMcpClient(id, config(id, server.baseUrl), { oauthProvider: provider });
    try {
      const wrappedFetch = await wrappedFetchFor(client);
      const refused = await wrappedFetch(`${server.baseUrl}/mcp`, {
        headers: new Headers({ Authorization: `Bearer ${REVOKED_ACCESS_TOKEN}` }),
      });
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
      const peer = new SimpleOAuthProvider(id, 5173);
      await peer.initialize();
      await peer.saveTokens({
        access_token: "fresh-peer-access-B",
        refresh_token: "fresh-peer-refresh-B",
        expires_in: 3600,
        token_type: "Bearer",
      });
      const tokens = await refreshAuthorization(server.baseUrl, {
        metadata: server.metadata,
        clientInformation: { client_id: "public-client" },
        refreshToken: REFRESH_TOKEN,
        fetchFn: wrappedFetch,
      });
      expect(tokens.access_token).toBe("fresh-peer-access-B");
      expect(tokens.refresh_token).toBe("fresh-peer-refresh-B");
      expect(server.count("POST", "/token")).toBe(0);
      expect(await markerExists(id)).toBe(false);
    } finally {
      await client.close();
    }
  });
});
