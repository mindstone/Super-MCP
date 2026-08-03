import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// REBEL-7F9 Stage 4a: the OAuth diagnostics payload that rides the error
// message via attachOAuthDiscoveryTrace. Beyond the discovery-trace entries
// it must record the chosen callback port, the redirect_uris sent at DCR,
// the exact redirect_uri on the authorize URL, and per-attempt probe
// verdicts (outcome/status/hint) — token/secret-free BY CONSTRUCTION (raw
// Location values, state, PKCE, and codes never enter the payload).

const { mockLogger, probeAuthorizeUrlMock, spawnMock } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  probeAuthorizeUrlMock: vi.fn(),
  spawnMock: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

vi.mock("../../auth/authorizeProbe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/authorizeProbe.js")>();
  return { ...actual, probeAuthorizeUrl: probeAuthorizeUrlMock };
});

vi.mock("child_process", () => ({ spawn: spawnMock }));

import { HttpMcpClient, OAUTH_DISCOVERY_TRACE_ERROR_MARKER } from "../httpClient.js";
import { SimpleOAuthProvider } from "../../auth/providers/simple.js";
import { OAUTH_REDIRECT_URI_REJECTED_CODE } from "../../auth/authorizeProbe.js";
import type { PackageConfig } from "../../types.js";

const PACKAGE_ID = "diag-trace-test";
// The authorize URL carries state + PKCE + a client_id — the payload must
// never leak any of them; only the redirect_uri is recorded.
const AUTH_URL = new URL(
  "https://auth.example.com/authorize" +
    "?client_id=abc" +
    "&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Foauth%2Fcallback" +
    "&state=SECRETSTATE123" +
    "&code_challenge=PKCECHALLENGE456",
);

let tokenDir: string;

function makeClient(staticCreds = false): HttpMcpClient {
  const config: PackageConfig = {
    id: PACKAGE_ID,
    name: PACKAGE_ID,
    transport: "http",
    base_url: "https://mcp.example.com/mcp",
    oauth: true,
    visibility: "default",
    ...(staticCreds
      ? { oauthClientId: "static-id", oauthClientSecret: "static-secret" }
      : {}),
  } as PackageConfig;
  return new HttpMcpClient(PACKAGE_ID, config, { oauthPort: 8080 });
}

async function wireProvider(client: HttpMcpClient): Promise<SimpleOAuthProvider> {
  await (client as any).initializeOAuthIfNeeded(true);
  return (client as any).simpleOAuthProvider as SimpleOAuthProvider;
}

function parseSuffix(error: Error): { base: string; payload: any } {
  const idx = error.message.lastIndexOf(OAUTH_DISCOVERY_TRACE_ERROR_MARKER);
  expect(idx).toBeGreaterThan(-1);
  return {
    base: error.message.slice(0, idx),
    payload: JSON.parse(error.message.slice(idx + OAUTH_DISCOVERY_TRACE_ERROR_MARKER.length)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-trace-test-"));
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
});

afterEach(() => {
  fs.rmSync(tokenDir, { recursive: true, force: true });
  delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

describe("attachOAuthDiscoveryTrace diagnostics payload (REBEL-7F9 Stage 4a)", () => {
  it("records port, DCR redirect_uris, authorize redirect_uri, and the probe verdict — token/secret-free", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({
      outcome: "rejected",
      status: 403,
      matchedPhrase: "Callback URL mismatch",
      // AS-controlled values that must NEVER enter the payload (the raw
      // Location stays at info-level logs per the Stage 3 refinement).
      location: "https://auth.example.com/error?error=unauthorized_client&leak=LEAKME",
    });
    const client = makeClient();
    const provider = await wireProvider(client);

    const thrown = await provider.redirectToAuthorization(AUTH_URL).catch((e) => e);
    expect(thrown.code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);

    const err = client.attachOAuthDiscoveryTrace(thrown);
    const { payload } = parseSuffix(err);

    expect(payload.callbackPort).toBe(8080);
    expect(payload.dcrRedirectUris).toEqual(["http://localhost:8080/oauth/callback"]);
    expect(payload.authorizeRedirectUri).toBe("http://localhost:8080/oauth/callback");
    expect(payload.probeVerdicts).toEqual([
      { port: 8080, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
    ]);
    expect(Array.isArray(payload.entries)).toBe(true);

    // Token/secret-free by construction: no state, no PKCE, no raw Location
    // or AS-controlled query content anywhere in the serialized payload.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("SECRETSTATE123");
    expect(raw).not.toContain("PKCECHALLENGE456");
    expect(raw).not.toContain("LEAKME");
    expect(raw).not.toContain("unauthorized_client");
    expect(raw).not.toContain("location");
  });

  it("accepted attempt: verdict rides the payload even after classification consumed the consume-once slot", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "accepted", status: 302 });
    const client = makeClient();
    const provider = await wireProvider(client);

    await provider.redirectToAuthorization(AUTH_URL);
    expect(spawnMock).toHaveBeenCalled(); // browser opened — the redirect started

    // The retry loop's classification drains the consume-once verdict slot;
    // the trace view is a DISTINCT non-consuming channel.
    expect(provider.consumeProbeVerdict()).toBeDefined();

    // This is the "redirect started, callback never arrived" shape: the only
    // error that exists is the callback-wait timeout.
    const err = client.attachOAuthDiscoveryTrace(new Error("OAuth callback timeout"));
    const { base, payload } = parseSuffix(err);

    expect(base).toBe("OAuth callback timeout");
    expect(payload.callbackPort).toBe(8080);
    expect(payload.authorizeRedirectUri).toBe("http://localhost:8080/oauth/callback");
    expect(payload.probeVerdicts).toEqual([{ port: 8080, outcome: "accepted", status: 302 }]);
  });

  it("prior attempts' probe verdicts fold into the payload ahead of the client's own", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({
      outcome: "rejected",
      status: 403,
      matchedPhrase: "Callback URL mismatch",
    });
    const client = makeClient();
    const provider = await wireProvider(client);
    await provider.redirectToAuthorization(AUTH_URL).catch(() => {});

    const err = client.attachOAuthDiscoveryTrace(new Error("OAuth callback timeout"), {
      priorProbeVerdicts: [
        { port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
      ],
    });
    const { payload } = parseSuffix(err);

    expect(payload.probeVerdicts).toEqual([
      { port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
      { port: 8080, outcome: "rejected", status: 403, hint: "Callback URL mismatch" },
    ]);
  });

  it("static-credential connector: no DCR happens, so no redirect_uris-sent claim", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({
      outcome: "rejected",
      status: 403,
      matchedPhrase: "Callback URL mismatch",
    });
    const client = makeClient(true);
    const provider = await wireProvider(client);
    await provider.redirectToAuthorization(AUTH_URL).catch(() => {});

    const err = client.attachOAuthDiscoveryTrace(new Error("rejected"));
    const { payload } = parseSuffix(err);

    expect("dcrRedirectUris" in payload).toBe(false);
    expect(payload.callbackPort).toBe(8080);
  });

  it("attaching twice does not stack markers (base message preserved once)", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "accepted", status: 200 });
    const client = makeClient();
    await wireProvider(client);

    const err = new Error("boom");
    client.attachOAuthDiscoveryTrace(err);
    client.attachOAuthDiscoveryTrace(err);

    const first = err.message.indexOf(OAUTH_DISCOVERY_TRACE_ERROR_MARKER);
    const last = err.message.lastIndexOf(OAUTH_DISCOVERY_TRACE_ERROR_MARKER);
    expect(first).toBe(last);
    expect(err.message.startsWith("boom")).toBe(true);
  });

  it("getOAuthDiagnosticsSuffix exposes the same payload for non-error carriers (auth_required message)", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "accepted", status: 200 });
    const client = makeClient();
    const provider = await wireProvider(client);
    await provider.redirectToAuthorization(AUTH_URL);

    const suffix = client.getOAuthDiagnosticsSuffix({
      priorProbeVerdicts: [{ port: 5173, outcome: "rejected", status: 403, hint: "Callback URL mismatch" }],
    });
    expect(suffix.startsWith(OAUTH_DISCOVERY_TRACE_ERROR_MARKER)).toBe(true);
    const payload = JSON.parse(suffix.slice(OAUTH_DISCOVERY_TRACE_ERROR_MARKER.length));
    expect(payload.callbackPort).toBe(8080);
    expect(payload.probeVerdicts).toHaveLength(2);
  });
});
