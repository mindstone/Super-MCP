import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { OAUTH_REDIRECT_URI_REJECTED_CODE, type AuthorizeProbeVerdict } from "../authorizeProbe.js";

// Probe hook contract on SimpleOAuthProvider (REBEL-7F9 Stage 3, recall#2 F2):
// redirectToAuthorization runs the pre-flight probe BEFORE opening the browser,
// records the verdict on a DISTINCT consume-once channel (NOT lastOAuthError,
// which invalidateCredentials drains), throws the coded rejection error on a
// classified rejection, and sets redirectStarted only AFTER the verdict.

const { mockLogger, probeAuthorizeUrlMock, spawnMock } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  probeAuthorizeUrlMock: vi.fn(),
  spawnMock: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

vi.mock("../authorizeProbe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../authorizeProbe.js")>();
  return { ...actual, probeAuthorizeUrl: probeAuthorizeUrlMock };
});

vi.mock("child_process", () => ({ spawn: spawnMock }));

import { SimpleOAuthProvider } from "../providers/simple.js";

const PACKAGE_ID = "probe-hook-test";
const AUTH_URL = new URL(
  "https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Foauth%2Fcallback",
);

let tokenDir: string;

function makeProvider(staticCreds?: { clientId: string; clientSecret?: string }) {
  return new SimpleOAuthProvider(PACKAGE_ID, 5173, staticCreds);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-hook-test-"));
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
});

afterEach(() => {
  fs.rmSync(tokenDir, { recursive: true, force: true });
  delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  delete process.env.SUPER_MCP_OAUTH_PROBE_DISABLE;
});

describe("redirectToAuthorization probe hook", () => {
  it("classified rejection: throws the coded error, never opens the browser, records the verdict", async () => {
    const verdict: AuthorizeProbeVerdict = {
      outcome: "rejected",
      status: 403,
      matchedPhrase: "Callback URL mismatch",
    };
    probeAuthorizeUrlMock.mockResolvedValue(verdict);
    const provider = makeProvider();
    await provider.initialize();

    await expect(provider.redirectToAuthorization(AUTH_URL)).rejects.toMatchObject({
      code: OAUTH_REDIRECT_URI_REJECTED_CODE,
    });

    // Browser must NOT open on a classified rejection.
    expect(spawnMock).not.toHaveBeenCalled();
    // Verdict recorded on the distinct channel, consume-once.
    expect(provider.consumeProbeVerdict()).toEqual(verdict);
    expect(provider.consumeProbeVerdict()).toBeUndefined();
    // redirectStarted is set only AFTER the verdict exists — the transport
    // fallback guards keying off hasStartedRedirect() see the settled outcome.
    expect(provider.hasStartedRedirect()).toBe(true);
  });

  it("rejection message avoids the auth-like vocabulary (would otherwise be swallowed)", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "rejected", status: 403 });
    const provider = makeProvider();
    await provider.initialize();
    const error = await provider.redirectToAuthorization(AUTH_URL).catch((e) => e);
    expect(error.message.toLowerCase()).not.toContain("unauthorized");
    expect(error.message).not.toContain("401");
    expect(error.message.toLowerCase()).not.toContain("invalid_token");
  });

  it("accepted verdict: opens the browser, records an accepted verdict", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "accepted", status: 302 });
    const provider = makeProvider();
    await provider.initialize();

    await provider.redirectToAuthorization(AUTH_URL);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(provider.consumeProbeVerdict()?.outcome).toBe("accepted");
    expect(provider.hasStartedRedirect()).toBe(true);
  });

  it("inconclusive verdict: fails open to the browser (today's behavior)", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "inconclusive", error: "fetch failed" });
    const provider = makeProvider();
    await provider.initialize();

    await provider.redirectToAuthorization(AUTH_URL);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(provider.consumeProbeVerdict()?.outcome).toBe("inconclusive");
  });

  it("kill-switch SUPER_MCP_OAUTH_PROBE_DISABLE=1: probe never runs, browser opens (byte-identical to today)", async () => {
    process.env.SUPER_MCP_OAUTH_PROBE_DISABLE = "1";
    const provider = makeProvider();
    await provider.initialize();

    await provider.redirectToAuthorization(AUTH_URL);

    expect(probeAuthorizeUrlMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(provider.consumeProbeVerdict()).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("probe disabled"),
      expect.anything(),
    );
  });

  it("skip flag (saved-port reuse with prior tokens): probe skipped, browser opens", async () => {
    const provider = makeProvider();
    await provider.initialize();
    provider.setSkipAuthorizeProbe(true);

    await provider.redirectToAuthorization(AUTH_URL);

    expect(probeAuthorizeUrlMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("the probe verdict channel is DISTINCT from the consume-once lastOAuthError slot", async () => {
    probeAuthorizeUrlMock.mockResolvedValue({ outcome: "rejected", status: 403 });
    const provider = makeProvider();
    await provider.initialize();
    provider.setLastOAuthError({ error: "access_denied" });

    await expect(provider.redirectToAuthorization(AUTH_URL)).rejects.toMatchObject({
      code: OAUTH_REDIRECT_URI_REJECTED_CODE,
    });

    // Draining lastOAuthError (what invalidateCredentials does) must not touch
    // the probe verdict — the retry loop classifies from the verdict channel.
    expect(provider.consumeLastOAuthError()).toEqual({ error: "access_denied" });
    expect(provider.consumeProbeVerdict()?.outcome).toBe("rejected");
  });
});

describe("hasPersistedAccessToken (probe-skip predicate)", () => {
  it("true only when the tokens file holds a parseable access_token", async () => {
    expect(await SimpleOAuthProvider.hasPersistedAccessToken(PACKAGE_ID)).toBe(false);
    fs.writeFileSync(path.join(tokenDir, `${PACKAGE_ID}_tokens.json`), JSON.stringify({ access_token: "tok" }));
    expect(await SimpleOAuthProvider.hasPersistedAccessToken(PACKAGE_ID)).toBe(true);
    fs.writeFileSync(path.join(tokenDir, `${PACKAGE_ID}_tokens.json`), "not json");
    expect(await SimpleOAuthProvider.hasPersistedAccessToken(PACKAGE_ID)).toBe(false);
    fs.writeFileSync(path.join(tokenDir, `${PACKAGE_ID}_tokens.json`), JSON.stringify({ refresh_token: "r" }));
    expect(await SimpleOAuthProvider.hasPersistedAccessToken(PACKAGE_ID)).toBe(false);
  });
});
