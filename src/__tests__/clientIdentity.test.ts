import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMcpClientInfo, getOAuthClientIdentity } from "../clientIdentity.js";
import { SimpleOAuthProvider } from "../auth/providers/simple.js";

vi.mock("../logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const KEYS = ["SUPER_MCP_APP_NAME", "SUPER_MCP_APP_URL", "SUPER_MCP_APP_LOGO_URL"] as const;

describe("client identity", () => {
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
