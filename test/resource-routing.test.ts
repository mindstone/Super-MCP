import { describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import { handleReadResource } from "../src/handlers/readResource.js";
import type { PackageRegistry } from "../src/registry.js";
import type { McpClient, PackageConfig } from "../src/types.js";

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PACKAGE: PackageConfig = {
  id: "documents-account-a",
  name: "Documents account A",
  transport: "http",
  base_url: "https://documents.example.test/mcp",
  visibility: "default",
};

const RESOURCE_URI = "ui://documents-account-a/viewer.html";
const TOOL = {
  name: "open_document",
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: RESOURCE_URI } },
};

function client(options: {
  tools?: unknown[];
  listError?: Error;
  resourceText?: string;
}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn(async () => {
      if (options.listError) throw options.listError;
      return options.tools ?? [];
    }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue("ok"),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ uri: RESOURCE_URI, text: options.resourceText ?? "document" }],
    }),
  };
}

function registryStub(getClient: () => Promise<McpClient>): PackageRegistry {
  return {
    getPackages: vi.fn().mockReturnValue([PACKAGE]),
    getPackage: vi.fn().mockReturnValue(PACKAGE),
    getClient: vi.fn(getClient),
  } as unknown as PackageRegistry;
}

describe("resource routing from catalog snapshots", () => {
  it("R14: retained URI ownership never routes while degraded or across a configuration generation", async () => {
    let currentClient = client({ tools: [TOOL] });
    const registry = registryStub(async () => currentClient);
    const catalog = new Catalog(registry);
    await catalog.refreshPackage(PACKAGE.id);

    currentClient = client({ listError: new Error("temporary failure") });
    await catalog.refreshPackage(PACKAGE.id);

    expect(catalog.getPackageStatus(PACKAGE.id)).toBe("error");
    expect(catalog.getPackageForResourceUri(RESOURCE_URI)).toBeUndefined();
    const retainedUriOwners = (catalog as unknown as {
      resourceUriToPackage: Map<string, string>;
    }).resourceUriToPackage;
    expect(retainedUriOwners.get("ui://documents-account-a")).toBe(PACKAGE.id);

    const writer = catalog as unknown as {
      setConfigurationGeneration(
        generation: number,
        changedPackageIds: readonly string[],
      ): void;
    };
    writer.setConfigurationGeneration(2, [PACKAGE.id]);
    expect(retainedUriOwners.get("ui://documents-account-a")).toBeUndefined();
  });

  it("R14 preservation: read_resource fetches healthy multi-instance content end to end", async () => {
    const healthyClient = client({ tools: [TOOL], resourceText: "hello from account A" });
    const registry = registryStub(async () => healthyClient);
    const catalog = new Catalog(registry);
    await catalog.refreshPackage(PACKAGE.id);

    const result = await handleReadResource({ uri: RESOURCE_URI }, registry, catalog);

    expect(healthyClient.readResource).toHaveBeenCalledWith(RESOURCE_URI);
    expect(result).toMatchObject({
      contents: [{ uri: RESOURCE_URI, text: "hello from account A" }],
    });
  });
});
