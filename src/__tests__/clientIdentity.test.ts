import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMcpClientInfo, getOAuthClientIdentity } from "../clientIdentity.js";
import { SimpleOAuthProvider } from "../auth/providers/simple.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { RefreshOnlyOAuthProvider } from "../auth/providers/refreshOnly.js";

vi.mock("../logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const KEYS = ["SUPER_MCP_APP_NAME", "SUPER_MCP_APP_URL", "SUPER_MCP_APP_LOGO_URL"] as const;

describe("client identity", () => {
  function discovery(methods?: string[]): OAuthDiscoveryState {
    return { authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        issuer: "https://auth.example.test", response_types_supported: ["code"],
        authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token",
        ...(methods === undefined ? {} : { token_endpoint_auth_methods_supported: methods }),
      } };
  }

  it.each([undefined, [], ["client_secret_basic"]])("replaces the public preference when later discovery omits none: %s", async (methods) => {
    const provider: OAuthClientProvider = new SimpleOAuthProvider("fictional-discovery", 5173);
    expect(provider.saveDiscoveryState).toBeTypeOf("function");
    await provider.saveDiscoveryState?.(discovery(["none", "client_secret_basic"]));
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
    await provider.saveDiscoveryState?.(discovery(methods));
    expect(provider.clientMetadata).not.toHaveProperty("token_endpoint_auth_method");
    await provider.saveDiscoveryState?.(discovery(["none"]));
    await provider.saveDiscoveryState?.({ authorizationServerUrl: "https://auth.example.test" });
    expect(provider.clientMetadata).not.toHaveProperty("token_endpoint_auth_method");
  });

  it("does not change configured static registration metadata, even if its saved issuer differs", async () => {
    const provider = new SimpleOAuthProvider("fictional-static", 5173, {
      clientId: "fictional-configured-client", clientSecret: "fictional-configured-secret",
    });
    await provider.saveClientInformation({ issuer: "https://old.example.test" });
    const metadata = provider.clientMetadata;
    const sdkProvider: OAuthClientProvider = provider;
    expect(sdkProvider.saveDiscoveryState).toBeTypeOf("function");
    await sdkProvider.saveDiscoveryState?.(discovery(["none"]));
    expect(provider.clientMetadata).toEqual(metadata);
    expect(await provider.clientInformation()).toMatchObject({ client_id: "fictional-configured-client", client_secret: "fictional-configured-secret" });
  });

  it("refresh-only discovery replaces the delegate preference without permitting redirects", async () => {
    const delegate = new SimpleOAuthProvider("fictional-refresh-only", 5173);
    const adapter: OAuthClientProvider = new RefreshOnlyOAuthProvider(delegate);
    expect(adapter.saveDiscoveryState).toBeTypeOf("function");
    await adapter.saveDiscoveryState?.(discovery(["none"]));
    expect(adapter.clientMetadata.token_endpoint_auth_method).toBe("none");
    await adapter.saveDiscoveryState?.(discovery());
    expect(adapter.clientMetadata).not.toHaveProperty("token_endpoint_auth_method");
    await expect(adapter.redirectToAuthorization(new URL("https://auth.example.test/authorize")))
      .rejects.toMatchObject({ name: "RefreshOnlyAuthenticationRequiredError" });
  });

  it("declares both grants for new registrations", () => {
    expect(new SimpleOAuthProvider("fictional-notebook", 5173).clientMetadata.grant_types)
      .toEqual(["authorization_code", "refresh_token"]);
  });

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("keeps the package's own name when the host sets nothing", () => {
    expect(getMcpClientInfo()).toEqual({ name: "super-mcp-router", version: "0.1.0" });
    expect(getOAuthClientIdentity()).toEqual({ client_name: "super-mcp-router" });
  });

  it("treats a blank name as unset", () => {
    process.env.SUPER_MCP_APP_NAME = "   ";
    expect(getMcpClientInfo().name).toBe("super-mcp-router");
  });

  it("uses the host's name, site and logo for the MCP client and the OAuth registration", () => {
    process.env.SUPER_MCP_APP_NAME = "Rebel";
    process.env.SUPER_MCP_APP_URL = "https://rebel.example.com";
    process.env.SUPER_MCP_APP_LOGO_URL = "https://rebel.example.com/logo.png";

    expect(getMcpClientInfo().name).toBe("Rebel");

    const provider = new SimpleOAuthProvider("identity-test", 5173);
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Rebel",
      name: "Rebel",
      client_uri: "https://rebel.example.com",
      logo_uri: "https://rebel.example.com/logo.png",
      redirect_uris: ["http://localhost:5173/oauth/callback"],
    });
  });

  it("registers without site or logo fields when only the name is set", () => {
    process.env.SUPER_MCP_APP_NAME = "Rebel";
    const metadata = new SimpleOAuthProvider("identity-test", 5173).clientMetadata;
    expect(metadata.client_name).toBe("Rebel");
    expect(metadata).not.toHaveProperty("client_uri");
    expect(metadata).not.toHaveProperty("logo_uri");
  });
});
