import type express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedTool, Catalog } from "../catalog.js";
import type { PackageRegistry } from "../registry.js";
import { registerHttpApiRoutes } from "../server.js";
import type { CatalogStatus, PackageConfig } from "../types.js";

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    setLevel: vi.fn(),
  },
}));

vi.mock("../logging.js", () => ({
  getLogger: () => logger,
}));

vi.mock("../security.js", () => ({
  getSecurityPolicy: () => ({
    getUserDisabledSummary: vi.fn().mockReturnValue({ totalDisabled: 0 }),
    getAdminDisabledSummary: vi.fn().mockReturnValue({ totalDisabled: 0 }),
    getUserDisabledHash: vi.fn().mockReturnValue("user"),
    getAdminDisabledHash: vi.fn().mockReturnValue("admin"),
  }),
}));

function makeTool(packageId: string, name: string): CachedTool {
  return {
    packageId,
    tool: { name, inputSchema: { type: "object" } },
    schemaHash: `sha256:${name}`,
  };
}

function makeRegistry(packageIds: readonly string[]): PackageRegistry {
  const packages = new Map<string, PackageConfig>(
    packageIds.map((id) => [
      id,
      { id, name: id, transport: "stdio", visibility: "default" },
    ]),
  );
  return {
    getPackage: vi.fn((packageId: string) => packages.get(packageId)),
  } as unknown as PackageRegistry;
}

function makeCatalog(
  status: CatalogStatus | "unknown",
  tools: readonly CachedTool[] = [],
): Catalog {
  return {
    getPackageStatus: vi.fn().mockReturnValue(status),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({
      retryAt: null,
      retryInMs: null,
      schedule: "none",
    }),
    getTool: vi.fn((packageId: string, toolId: string) =>
      tools.find(
        (entry) => entry.packageId === packageId && entry.tool.name === toolId,
      ),
    ),
    getPackageTools: vi.fn((packageId: string) =>
      tools.filter((entry) => entry.packageId === packageId),
    ),
  } as unknown as Catalog;
}

function registerResolveRoute(options: {
  registry: PackageRegistry;
  catalog: Catalog;
  dnsRebindingGuard?: express.RequestHandler;
}) {
  let handlers: express.RequestHandler[] | undefined;
  const app = {
    get: vi.fn((path: string, ...routeHandlers: express.RequestHandler[]) => {
      if (path === "/api/tools/resolve") handlers = routeHandlers;
    }),
  } as unknown as express.Express;

  registerHttpApiRoutes(app, {
    registry: options.registry,
    catalog: options.catalog,
    dnsRebindingGuard:
      options.dnsRebindingGuard ?? ((_req, _res, next) => next()),
  });
  expect(handlers).toHaveLength(2);

  return (query: Record<string, unknown>) => {
    let status = 200;
    let body: unknown;
    const response = {
      status: vi.fn((nextStatus: number) => {
        status = nextStatus;
        return response;
      }),
      json: vi.fn((nextBody: unknown) => {
        body = nextBody;
        return response;
      }),
    } as unknown as express.Response;
    const request = { query } as unknown as express.Request;
    const guard = handlers![0];
    const route = handlers![1];

    guard(request, response, () => {
      route(request, response, vi.fn());
    });
    return { status, body };
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/tools/resolve", () => {
  it.each([
    ["missing both parameters", {}],
    ["blank package_id", { package_id: " ", tool_id: "search" }],
    ["blank tool_id", { package_id: "P", tool_id: " " }],
  ])("returns 400 for %s", (_label, query) => {
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["P"]),
      catalog: makeCatalog("ready"),
    });

    expect(callRoute(query)).toEqual({
      status: 400,
      body: { error: "package_id and tool_id must be non-empty strings" },
    });
  });

  it("returns present for an exact live target", () => {
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["P"]),
      catalog: makeCatalog("ready", [makeTool("P", "search")]),
    });

    expect(callRoute({ package_id: "P", tool_id: "P__search" })).toEqual({
      status: 200,
      body: {
        package_id: "P",
        requested_tool_id: "P__search",
        namespaced_tool_id: "P__search",
        outcome: "present",
        reason: null,
        package_status: "ready",
        generated_at: expect.any(String),
      },
    });
  });

  it("returns absent with bare, sorted candidates capped at 24", () => {
    const candidateNames = Array.from(
      { length: 30 },
      (_, index) => `tool_${String(29 - index).padStart(2, "0")}`,
    );
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["P"]),
      catalog: makeCatalog(
        "ready",
        candidateNames.map((name, index) =>
          makeTool("P", index === 0 ? `P__${name}` : name),
        ),
      ),
    });

    const result = callRoute({ package_id: "P", tool_id: "missing" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      package_id: "P",
      requested_tool_id: "missing",
      namespaced_tool_id: "P__missing",
      outcome: "absent",
      reason: null,
      package_status: "ready",
    });
    const body = result.body as { candidates: string[] };
    expect(body.candidates).toEqual([...candidateNames].sort().slice(0, 24));
    expect(body.candidates).toHaveLength(24);
    expect(body.candidates.every((name) => !name.startsWith("P__"))).toBe(true);
  });

  it("returns unavailable/package_unknown as 200, never 404", () => {
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["GoogleWorkspace-account"]),
      catalog: makeCatalog("ready", [
        makeTool("GoogleWorkspace-account", "search_workspace_emails"),
      ]),
    });

    expect(
      callRoute({
        package_id: "GoogleWorkspace",
        tool_id: "search_workspace_emails",
      }),
    ).toEqual({
      status: 200,
      body: {
        package_id: "GoogleWorkspace",
        requested_tool_id: "search_workspace_emails",
        namespaced_tool_id: "GoogleWorkspace__search_workspace_emails",
        outcome: "unavailable",
        reason: "package_unknown",
        package_status: "unknown",
        generated_at: expect.any(String),
      },
    });
  });

  it("returns unavailable for a known non-ready package", () => {
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["P"]),
      catalog: makeCatalog("auth_required"),
    });

    expect(callRoute({ package_id: "P", tool_id: "search" })).toEqual({
      status: 200,
      body: {
        package_id: "P",
        requested_tool_id: "search",
        namespaced_tool_id: "P__search",
        outcome: "unavailable",
        reason: "auth_required",
        package_status: "auth_required",
        generated_at: expect.any(String),
      },
    });
  });

  it("returns 500 when resolution throws", () => {
    const registry = makeRegistry(["P"]);
    vi.mocked(registry.getPackage).mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const callRoute = registerResolveRoute({
      registry,
      catalog: makeCatalog("ready"),
    });

    expect(callRoute({ package_id: "P", tool_id: "search" })).toEqual({
      status: 500,
      body: { error: "Failed to resolve tool target" },
    });
  });

  it("is protected by the supplied DNS rebinding guard", () => {
    const callRoute = registerResolveRoute({
      registry: makeRegistry(["P"]),
      catalog: makeCatalog("ready"),
      dnsRebindingGuard: (_req, res) => {
        res.status(403).json({ error: "Forbidden - invalid host" });
      },
    });

    expect(callRoute({ package_id: "P", tool_id: "search" })).toEqual({
      status: 403,
      body: { error: "Forbidden - invalid host" },
    });
  });
});
