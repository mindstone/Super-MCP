import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { HttpMcpClient } from "../src/clients/httpClient.js";
import { StdioMcpClient } from "../src/clients/stdioClient.js";
import { handleGetHelp } from "../src/handlers/getHelp.js";
import { handleHealthCheckAll } from "../src/handlers/healthCheck.js";
import { handleListToolPackages } from "../src/handlers/listToolPackages.js";
import { handleSearchTools } from "../src/handlers/searchTools.js";
import { redactConnectorSecrets, redactConnectorSecretsDeep } from "../src/connectorLabels.js";
import { PackageRegistry } from "../src/registry.js";
import type { PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// A made-up key placed everywhere a person might put one in a connector's address or command.
const KEY = "sk-live-FOX7695madeUpKey";
const httpPackage: PackageConfig = {
  id: "keyed-http",
  name: "Keyed HTTP",
  transport: "http",
  base_url: `https://user:${KEY}@mcp.example.test:8443/v1/${KEY}/mcp?api_key=${KEY}#${KEY}`,
  visibility: "default",
};
const stdioPackage: PackageConfig = {
  id: "keyed-stdio",
  name: "Keyed stdio",
  transport: "stdio",
  command: `/opt/${KEY}/bin/keyed-server`,
  args: ["--api-key", KEY],
  env: { SERVICE_TOKEN: `env-${KEY}` },
  visibility: "default",
};

// A working connector, so search_tools has tools to index.
const healthyPackage: PackageConfig = {
  id: "healthy-http",
  name: "Healthy HTTP",
  transport: "http",
  base_url: "https://healthy.example.test/mcp",
  visibility: "default",
};
const healthyTools = ["read_notes", "write_notes", "list_folders"].map((name) => ({
  name,
  description: `${name.replace("_", " ")} in the notebook`,
  inputSchema: { type: "object", properties: {} },
}));

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("a failed connector's error text carries no secret from its address or command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the key out of catalog_error, unavailable_packages, health_check_all and get_help", async () => {
    vi.spyOn(HttpMcpClient.prototype, "connect").mockImplementation(async function (this: HttpMcpClient) {
      if ((this as unknown as { packageId: string }).packageId === healthyPackage.id) return;
      // Node's own errors quote the whole address, as undici does for a URL with credentials.
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${httpPackage.base_url}`);
    });
    vi.spyOn(HttpMcpClient.prototype, "listTools").mockResolvedValue(healthyTools);
    vi.spyOn(HttpMcpClient.prototype, "healthCheck").mockResolvedValue("ok");
    vi.spyOn(HttpMcpClient.prototype, "close").mockResolvedValue(undefined);
    // A spawn error quotes the full path, and a crashing server may echo its arguments and environment.
    const stdioFailure = Object.assign(
      new Error(`Spawn error: spawn ${stdioPackage.command} ENOENT\nChild stderr (tail):\nstarting with --api-key ${KEY} token=env-${KEY}`),
      { name: "MCPConnectionError" },
    );
    vi.spyOn(StdioMcpClient.prototype, "connect").mockRejectedValue(stdioFailure);
    vi.spyOn(StdioMcpClient.prototype, "close").mockResolvedValue(undefined);

    const registry = new PackageRegistry({ packages: [healthyPackage, httpPackage, stdioPackage] });
    const catalog = new Catalog(registry);
    try {
      await catalog.refreshPackage(healthyPackage.id);
      await catalog.refreshPackage(httpPackage.id);
      await catalog.refreshPackage(stdioPackage.id);

      const listText = textOf(await handleListToolPackages({}, registry, catalog));
      const searchText = textOf(await handleSearchTools({ query: "notes" }, registry, catalog));
      const healthText = textOf(await handleHealthCheckAll({ detailed: true }, registry, catalog));
      const helpText = textOf(await handleGetHelp({ package_id: httpPackage.id }, registry, catalog));
      const packages = JSON.parse(listText).packages as Array<Record<string, string>>;
      const unavailable = JSON.parse(searchText).unavailable_packages as Array<Record<string, string>>;

      for (const pkg of [httpPackage, stdioPackage]) {
        const listed = packages.find((entry) => entry.package_id === pkg.id)!;
        // The failure is still there, and still says which connector failed.
        expect(listed.catalog_error).toContain(`Failed to connect to MCP package '${pkg.id}'`);
        expect(unavailable.find((entry) => entry.package_id === pkg.id)?.reason)
          .toContain(`'${pkg.id}'`);
      }
      expect(packages.find((entry) => entry.package_id === httpPackage.id)!.catalog_error)
        .toContain("URL: https://mcp.example.test:8443");
      expect(packages.find((entry) => entry.package_id === stdioPackage.id)!.catalog_error)
        .toContain("Command: keyed-server");

      expect(helpText).toContain("https://mcp.example.test:8443");
      for (const text of [listText, searchText, healthText, helpText]) {
        expect(text).not.toContain(KEY);
      }
    } finally {
      await registry.closeAll();
    }
  });

  it("does not echo an invalid base_url back in the configuration error", () => {
    const validate = (PackageRegistry as unknown as {
      validatePackageFields: (pkg: PackageConfig) => string | null;
    }).validatePackageFields;
    const error = validate({ ...httpPackage, base_url: `not a url ${KEY}` });
    expect(error).toBe("base_url must be a valid URL");
  });

  it("keeps the connector's id readable when its address path contains it", () => {
    const config: PackageConfig = {
      ...httpPackage,
      id: "notion-connector",
      name: "Notion connector",
      base_url: `https://mcp.example.test/notion-connector/${KEY}`,
    };
    const text = redactConnectorSecrets(
      `Failed to connect to MCP package 'notion-connector' at ${config.base_url}/sse`,
      config,
    );
    expect(text).toBe("Failed to connect to MCP package 'notion-connector' at https://mcp.example.test/sse");
  });

  it("removes a different secret from each place in the configuration, alone or inside a value", () => {
    const secret = (where: string) => `${where}-FOX7695-secret`;
    const config: PackageConfig = {
      id: "many-secrets",
      name: "Many secrets",
      transport: "http",
      base_url: `https://${secret("user")}:pw42@mcp.example.test/${secret("path")}?key=${secret("query")}#${secret("fragment")}`,
      command: `/opt/${secret("dir")}/bin/server`,
      args: [`--api-key=${secret("arg")}`],
      env: { TOKEN: secret("env") },
      extra_headers: { Authorization: `Bearer ${secret("header")}` },
      oauthClientSecret: secret("oauth"),
      visibility: "default",
    };
    const places = ["user", "path", "query", "fragment", "dir", "arg", "env", "header", "oauth"];
    // Each secret quoted on its own, as a server's own message might.
    const text = places.map((where) => `Invalid token ${secret(where)}`).join("\n") + "\npassword pw42 refused";
    const redacted = redactConnectorSecrets(text, config);
    for (const where of places) expect(redacted).not.toContain(secret(where));
    expect(redacted).not.toContain("pw42");
    // An address that cannot be decoded still gives up its query.
    const undecodable = { ...config, base_url: `https://mcp.example.test/%ZZ?key=${secret("query")}` };
    expect(redactConnectorSecrets(`bad ${secret("query")}`, undecodable)).toBe("bad [redacted]");
    // One malformed escape does not stop the rest of the path being decoded.
    const mixed = { ...config, base_url: "https://mcp.example.test/%ZZ/sk%2Dabcdefghijk" };
    expect(redactConnectorSecrets("bad sk-abcdefghijk", mixed)).toBe("bad [redacted]");
    // A piece of a password is removed too.
    const pieced = { ...config, base_url: "https://user:prefix%3Aabcdefghijk@mcp.example.test/" };
    expect(redactConnectorSecrets("bad abcdefghijk", pieced)).toBe("bad [redacted]");
  });

  it("redacts every string in a thrown error object, against every connector", () => {
    const error = {
      code: -32003,
      message: `Tool failed at ${httpPackage.base_url}`,
      data: { original_error: `spawn ${stdioPackage.command} ENOENT`, args_provided: ["query"], duration_ms: 12 },
    };
    const redacted = redactConnectorSecretsDeep(error, [httpPackage, stdioPackage]);
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted.message).toBe("Tool failed at https://mcp.example.test:8443");
    expect(redacted.data.original_error).toBe("spawn keyed-server ENOENT");
    expect(redacted.data.duration_ms).toBe(12);
  });
});
