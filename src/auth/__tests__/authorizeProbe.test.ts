import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  AUTHORIZE_PROBE_TIMEOUT_MS,
  OAUTH_REDIRECT_URI_REJECTED_CODE,
  REDIRECT_URI_MISMATCH_MESSAGE_BASE,
  buildRedirectUriRejectedError,
  classifyProbeResponse,
  isAuthorizeProbeDisabled,
  probeAuthorizeUrl,
} from "../authorizeProbe.js";
import { isAuthLikeErrorMessageText } from "../../clients/httpClient.js";

vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Verbatim Auth0 403 body captured live from auth.swifteq.com on 2026-08-03
// (REBEL-7F9; tracking id 24f908f054d9bd449edd). This is the exact page the
// reported user's browser showed — the classification fixture the whole stage
// exists to fast-fail on.
const AUTH0_403_BODY = fs.readFileSync(
  path.join(__dirname, "fixtures", "auth0-403-callback-url-mismatch.html"),
  "utf8",
);

describe("classifyProbeResponse", () => {
  it("classifies the verbatim Auth0 403 'Callback URL mismatch' page as a rejection", () => {
    const verdict = classifyProbeResponse({ status: 403, body: AUTH0_403_BODY });
    expect(verdict.outcome).toBe("rejected");
    expect(verdict.matchedPhrase).toBeTruthy();
  });

  it("classifies Keycloak's 'Invalid parameter: redirect_uri' 400 as a rejection", () => {
    const verdict = classifyProbeResponse({
      status: 400,
      body: "Invalid parameter: redirect_uri",
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("classifies 'redirect_uri does not match' phrasing as a rejection", () => {
    const verdict = classifyProbeResponse({
      status: 400,
      body: "The redirect_uri does not match any registered callback.",
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("classifies a 302 whose Location carries an error= parameter as a rejection (Okta/Keycloak shape)", () => {
    const verdict = classifyProbeResponse({
      status: 302,
      location: "https://login.example.com/error?error=invalid_request&error_description=redirect_uri+mismatch",
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("classifies a 302 to an invalid_request error page as a rejection", () => {
    const verdict = classifyProbeResponse({
      status: 302,
      location: "/oauth/error?error=invalid_request&error_description=redirect_uri%20not%20registered",
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("accepts Auth0's real /login 302 even though its Location carries redirect_uri (live 8080-accepted shape)", () => {
    // Verbatim Location captured live from auth.swifteq.com 2026-08-03 for the
    // ACCEPTED http://localhost:8080/oauth/callback authorize request — the
    // redirect_uri query param is a continuation parameter, NOT an error.
    const verdict = classifyProbeResponse({
      status: 302,
      location:
        "/login?state=hKFo2SAzNEFPSE9Qa0FmWnJ0SFU0ak1WTDhqRmxWTEpmYmpSRKFupWxvZ2luo3RpZNk&client=pglNl9dRatAnsoaxZzc76aKwH8NDffAg&protocol=oauth2&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Foauth%2Fcallback&scope=openid%20profile%20email%20offline_access",
    });
    expect(verdict.outcome).toBe("accepted");
  });

  it("accepts a clean 302 to a login page (the happy path — Auth0 /login)", () => {
    const verdict = classifyProbeResponse({
      status: 302,
      location: "/login?state=abc123&client=xyz&protocol=oauth2",
    });
    expect(verdict.outcome).toBe("accepted");
  });

  it("accepts any 2xx even when the body mentions redirect_uri (error-text-in-200 fails open)", () => {
    const verdict = classifyProbeResponse({
      status: 200,
      body: "<html>Sign in. We never share your redirect_uri with third parties.</html>",
    });
    expect(verdict.outcome).toBe("accepted");
  });

  it("fails open on a login page (200) that happens to mention redirect_uri", () => {
    const verdict = classifyProbeResponse({
      status: 200,
      body: "<html><form>Log in to continue to redirect_uri settings</form></html>",
    });
    expect(verdict.outcome).toBe("accepted");
  });

  it("fails open on a WAF 403 without a mismatch-specific phrase", () => {
    const verdict = classifyProbeResponse({
      status: 403,
      body: "<html><title>Access Denied</title>Request blocked by Web Application Firewall. Reference #18.abc</html>",
    });
    expect(verdict.outcome).toBe("inconclusive");
  });

  it("fails open on a generic 401 challenge", () => {
    const verdict = classifyProbeResponse({
      status: 401,
      body: "Unauthorized: authentication required to access this resource",
    });
    expect(verdict.outcome).toBe("inconclusive");
  });

  it("fails open on unexpected statuses (500, 404, ...)", () => {
    expect(classifyProbeResponse({ status: 500, body: "Callback URL mismatch" }).outcome).toBe(
      "inconclusive",
    );
    expect(classifyProbeResponse({ status: 404 }).outcome).toBe("inconclusive");
  });

  it("a loose token mention in a 403 body is NEVER sufficient (phrase required)", () => {
    const verdict = classifyProbeResponse({
      status: 403,
      body: "Forbidden. Your callback url policy violates section 4. Contact support.",
    });
    expect(verdict.outcome).toBe("inconclusive");
  });
});

describe("rejection error vocabulary carve-out (recall#2 F2(c))", () => {
  it("the constructed rejection message does NOT match isAuthLikeErrorMessage", () => {
    const verdict = classifyProbeResponse({ status: 403, body: AUTH0_403_BODY });
    const error = buildRedirectUriRejectedError(verdict);
    expect(isAuthLikeErrorMessageText(error.message)).toBe(false);
  });

  it("carries the machine code and never leaks the numeric status into the message", () => {
    // A 401-classified rejection interpolated into the message would trip the
    // "401" token in isAuthLikeErrorMessage and be swallowed as auth-like.
    const verdict = classifyProbeResponse({
      status: 401,
      body: "redirect_uri not allowed for this client",
    });
    expect(verdict.outcome).toBe("rejected");
    const error = buildRedirectUriRejectedError(verdict);
    expect((error as NodeJS.ErrnoException).code).toBe(OAUTH_REDIRECT_URI_REJECTED_CODE);
    expect(error.message).not.toContain("401");
    expect(isAuthLikeErrorMessageText(error.message)).toBe(false);
  });

  it("the verbatim Auth0 body WOULD match isAuthLikeErrorMessage — pinning why the body must never become the message", () => {
    expect(AUTH0_403_BODY).toContain("unauthorized_client");
    expect(isAuthLikeErrorMessageText(AUTH0_403_BODY)).toBe(true);
    expect(buildRedirectUriRejectedError({ outcome: "rejected", status: 403 }).message).toContain(
      REDIRECT_URI_MISMATCH_MESSAGE_BASE,
    );
  });
});

describe("probeAuthorizeUrl", () => {
  it("fails open on network error (today's behavior)", async () => {
    const verdict = await probeAuthorizeUrl("https://auth.example.com/authorize", {
      fetchFn: vi.fn(async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.error).toBeTruthy();
  });

  it("fails open on timeout", async () => {
    const verdict = await probeAuthorizeUrl("https://auth.example.com/authorize", {
      timeoutMs: 25,
      fetchFn: vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted", "AbortError")),
            );
          }),
      ) as unknown as typeof fetch,
    });
    expect(verdict.outcome).toBe("inconclusive");
  });

  it("issues a manual-redirect GET with a browser UA and no cookies", async () => {
    const fetchFn = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("Found", {
          status: 302,
          headers: { location: "/login?state=abc" },
        }),
    );
    const verdict = await probeAuthorizeUrl("https://auth.example.com/authorize?x=1", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(verdict.outcome).toBe("accepted");
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toMatch(/Mozilla\/5\.0/);
    expect(headers.get("cookie")).toBeNull();
  });

  it("classifies a rejected verdict from a live-shaped 403 response", async () => {
    const verdict = await probeAuthorizeUrl("https://auth.example.com/authorize", {
      fetchFn: vi.fn(
        async () => new Response(AUTH0_403_BODY, { status: 403 }),
      ) as unknown as typeof fetch,
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("bounds the body read (a phrase past the cap is not matched — fail open)", async () => {
    const padding = "x".repeat(200_000);
    const verdict = await probeAuthorizeUrl("https://auth.example.com/authorize", {
      fetchFn: vi.fn(
        async () => new Response(padding + " Callback URL mismatch.", { status: 403 }),
      ) as unknown as typeof fetch,
    });
    expect(verdict.outcome).toBe("inconclusive");
  });
});

describe("kill-switch", () => {
  it("SUPER_MCP_OAUTH_PROBE_DISABLE=1 disables the probe", () => {
    expect(isAuthorizeProbeDisabled({ SUPER_MCP_OAUTH_PROBE_DISABLE: "1" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
    expect(isAuthorizeProbeDisabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isAuthorizeProbeDisabled({ SUPER_MCP_OAUTH_PROBE_DISABLE: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("probe timeout is the named ~3s constant the budget invariant sums", () => {
    expect(AUTHORIZE_PROBE_TIMEOUT_MS).toBe(3_000);
  });
});
