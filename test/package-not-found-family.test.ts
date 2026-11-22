// FOX-10918 (Sentry REBEL-62C): the model asks for `<Family>-<email-slug>`
// package ids that aren't registered (an account that isn't connected, is
// switched off, or failed to load). The answer used to be a bare
// "Package not found: X", so the model couldn't tell the person what was true.
// The not-found answer now names the connected accounts of the same family, or
// says the account is switched off / couldn't be loaded, and never routes the
// request to a different account.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleListTools } from "../src/handlers/listTools.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import { describePackageNotFound } from "../src/utils/packageResolution.js";
import type { Catalog } from "../src/catalog.js";
import type { PackageRegistry } from "../src/registry.js";
import type { PackageConfig } from "../src/types.js";
import { ERROR_CODES } from "../src/types.js";

vi.mock("../src/security.js", () => ({
  getSecurityPolicy: () => ({
    isToolBlocked: vi.fn().mockReturnValue({ blocked: false }),
    isPackageBlocked: vi.fn().mockReturnValue({ blocked: false }),
    isUserDisabled: vi.fn().mockReturnValue(false),
    isAdminDisabled: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

function pkg(id: string): PackageConfig {
  return { id, name: id, transport: "stdio", visibility: "default" };
}

/** Registry with the real exact/alias lookup semantics over the given ids. */
function createRegistry(
  ids: string[],
  opts: { disabled?: string[]; skipped?: string[] } = {},
): PackageRegistry {
  const packages = ids.map(pkg);
  return {
    getPackage: vi.fn((id: string) => packages.find((p) => p.id === id)),
    findPackagesByAlias: vi.fn((alias: string) => {
      const lower = alias.toLowerCase();
      const exact = packages.find((p) => p.id.toLowerCase() === lower);
      if (exact) return [exact];
      return packages.filter((p) => p.id.toLowerCase().startsWith(`${lower}-`));
    }),
    getDisabledPackageIds: vi.fn(() => opts.disabled ?? []),
    getSkippedPackages: vi.fn(() =>
      (opts.skipped ?? []).map((id) => ({ id, reason: "invalid config" })),
    ),
  } as unknown as PackageRegistry;
}

function createCatalog(): Catalog {
  return {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null }),
    getPackageTools: vi.fn().mockReturnValue([]),
  } as unknown as Catalog;
}

async function listToolsError(registry: PackageRegistry, packageId: string): Promise<any> {
  const catalog = createCatalog();
  let thrown: any;
  await handleListTools({ package_id: packageId }, catalog, null, registry).catch((error: unknown) => {
    thrown = error;
  });
  expect(thrown).toBeTruthy();
  // Never routed: no tools were read for any package.
  expect(catalog.getPackageTools).not.toHaveBeenCalled();
  return thrown;
}

describe("list_tools — not-found package ids explain what is connected (FOX-10918)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the connected accounts of the same family, without routing to them", async () => {
    const thrown = await listToolsError(
      createRegistry(["GoogleWorkspace-jane-example-com", "filesystem"]),
      "GoogleWorkspace-john-example-com",
    );

    expect(thrown.code).toBe(ERROR_CODES.PACKAGE_NOT_FOUND);
    expect(thrown.message).toContain("Package not found: GoogleWorkspace-john-example-com");
    expect(thrown.message).toContain("'GoogleWorkspace-jane-example-com'");
    expect(thrown.data).toEqual({
      package_id: "GoogleWorkspace-john-example-com",
      family: "GoogleWorkspace",
      registered_candidates: [
        { package_id: "GoogleWorkspace-jane-example-com", name: "GoogleWorkspace-jane-example-com" },
      ],
    });
  });

  it("lists every connected account when the family has several", async () => {
    const thrown = await listToolsError(
      createRegistry(["Microsoft365Calendar-a-example-com", "Microsoft365Calendar-b-example-com"]),
      "Microsoft365Calendar-c-example-com",
    );

    expect(thrown.data.registered_candidates.map((c: { package_id: string }) => c.package_id)).toEqual([
      "Microsoft365Calendar-a-example-com",
      "Microsoft365Calendar-b-example-com",
    ]);
  });

  it("says the account is switched off when the person disabled it", async () => {
    const thrown = await listToolsError(
      createRegistry(["GoogleWorkspace-jane-example-com"], { disabled: ["GoogleWorkspace-john-example-com"] }),
      "GoogleWorkspace-john-example-com",
    );

    expect(thrown.code).toBe(ERROR_CODES.PACKAGE_NOT_FOUND);
    expect(thrown.message).toContain("switched off");
    expect(thrown.data).toEqual({ package_id: "GoogleWorkspace-john-example-com", status: "disabled" });
  });

  it("says the account couldn't be loaded when its config was skipped", async () => {
    const thrown = await listToolsError(
      createRegistry([], { skipped: ["Salesforce-jane-example-com"] }),
      "Salesforce-jane-example-com",
    );

    expect(thrown.message).toContain("couldn't be loaded");
    expect(thrown.data).toEqual({ package_id: "Salesforce-jane-example-com", status: "load_failed" });
  });

  it("keeps the plain not-found answer when nothing of that family is connected", async () => {
    const thrown = await listToolsError(createRegistry(["filesystem"]), "Fathom-jane-example-com");

    expect(thrown.message).toBe("Package not found: Fathom-jane-example-com");
    expect(thrown.data).toEqual({ package_id: "Fathom-jane-example-com" });
  });
});

describe("use_tool — not-found package ids (FOX-10918)", () => {
  it("names the connected account and does not call it", async () => {
    const registry = createRegistry(["GoogleWorkspace-jane-example-com"]);
    const callTool = vi.fn();
    Object.assign(registry, { callTool, getClient: vi.fn(), notifyActivity: vi.fn() });
    const catalog = Object.assign(createCatalog(), {
      getTool: vi.fn(),
      getToolSchema: vi.fn(),
      findToolByName: vi.fn().mockReturnValue([]),
    });

    await expect(
      handleUseTool(
        { package_id: "GoogleWorkspace-john-example-com", tool_id: "search_workspace_emails", args: {} },
        registry,
        catalog,
        { validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] }) } as never,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      data: { family: "GoogleWorkspace" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("describePackageNotFound", () => {
  it("works with a registry that can't report disabled or skipped packages", () => {
    const registry = {
      getPackage: () => undefined,
      findPackagesByAlias: () => [pkg("Fathom")],
    };

    const result = describePackageNotFound(registry, "Fathom-jane-example-com");

    expect(result.data.registered_candidates).toEqual([{ package_id: "Fathom", name: "Fathom" }]);
  });

  it("lists the bare family package and its suffixed accounts together", () => {
    const registry = Object.assign(
      createRegistry(["GoogleWorkspace", "GoogleWorkspace-jane-example-com", "GoogleWorkspaceAdmin"]),
      {
        getPackages: () =>
          ["GoogleWorkspace", "GoogleWorkspace-jane-example-com", "GoogleWorkspaceAdmin"].map(pkg),
      },
    );

    const result = describePackageNotFound(registry, "GoogleWorkspace-john-example-com");

    expect(result.data.registered_candidates?.map((c) => c.package_id)).toEqual([
      "GoogleWorkspace",
      "GoogleWorkspace-jane-example-com",
    ]);
  });

  it("leaves a bare unknown name alone", () => {
    const result = describePackageNotFound(createRegistry(["filesystem"]), "Browserbase");

    expect(result).toEqual({
      message: "Package not found: Browserbase",
      data: { package_id: "Browserbase" },
    });
  });
});
