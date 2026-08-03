import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { handleGetToolDetails } from "../src/handlers/getToolDetails.js";
import { handleListToolPackages } from "../src/handlers/listToolPackages.js";
import { handleListTools } from "../src/handlers/listTools.js";
import { PackageRegistry } from "../src/registry.js";

const packageId = "GoogleWorkspace-example-com";

function createBlockedPackage(): { registry: PackageRegistry; catalog: Catalog } {
  const registry = new PackageRegistry({
    mcpServers: {
      [packageId]: {
        command: process.execPath,
        args: ["this-file-must-never-be-spawned.mjs"],
        name: "Google Workspace",
        setupStatus: {
          state: "blocked",
          reason: "missing_managed_credentials",
        },
      },
    },
  });
  return { registry, catalog: new Catalog(registry) };
}

describe("setup_incomplete package carrier", () => {
  it("does not spawn a blocked package and reports its reason from list_tool_packages", async () => {
    const { registry, catalog } = createBlockedPackage();

    const result = await handleListToolPackages({}, registry, catalog);
    const body = JSON.parse(result.content[0].text);

    expect(body.packages).toEqual([
      expect.objectContaining({
        package_id: packageId,
        health: "unavailable",
        tool_count: 0,
        catalog_status: "setup_incomplete",
        catalog_error: "missing_managed_credentials",
      }),
    ]);
    expect(registry.getChildStats()).toEqual([
      expect.objectContaining({ package_id: packageId, spawn_count: 0, connected: false }),
    ]);
  });

  it("surfaces setup_incomplete and the reason from get_tool_details", async () => {
    const { registry, catalog } = createBlockedPackage();

    const result = await handleGetToolDetails(
      { tool_ids: [`${packageId}__search_emails`] },
      catalog,
      registry,
    );
    const body = JSON.parse(result.content[0].text);

    expect(body.tools).toEqual([
      expect.objectContaining({
        package_id: packageId,
        error: "setup_incomplete",
        status: "setup_incomplete",
        reason: "missing_managed_credentials",
      }),
    ]);
    expect(body.tools[0].description).toContain("Signing in again will not fix it");
    expect(registry.getChildStats()[0]).toMatchObject({ spawn_count: 0, connected: false });
  });

  it("returns a structured setup_incomplete package error from list_tools without spawning", async () => {
    const { registry, catalog } = createBlockedPackage();

    await expect(handleListTools({ package_id: packageId }, catalog, null, registry)).rejects.toMatchObject({
      code: -33004,
      data: {
        package_id: packageId,
        status: "setup_incomplete",
        reason: "missing_managed_credentials",
      },
    });
    expect(registry.getChildStats()[0]).toMatchObject({ spawn_count: 0, connected: false });
  });
});
