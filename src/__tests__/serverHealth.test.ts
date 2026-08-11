import { describe, expect, it, vi } from "vitest";
import type express from "express";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleMocks = vi.hoisted(() => ({
  createRequire: vi.fn(() => () => {
    throw Object.assign(new Error("package metadata is unavailable"), {
      code: "MODULE_NOT_FOUND",
    });
  }),
}));

// Packaged desktop ships dist/ without an adjacent package.json. Keep that
// metadata lookup unavailable throughout this suite so module evaluation fails
// if the runtime ever starts depending on it again.
vi.mock("node:module", () => ({
  createRequire: moduleMocks.createRequire,
}));

import {
  registerSuperMcpHealthRoute,
  SUPER_MCP_BUILD_VERSION,
  SUPER_MCP_HEALTH_SCHEMA_VERSION,
} from "../health.js";
import { GENERATED_SUPER_MCP_BUILD_VERSION } from "../buildVersion.generated.js";

describe("GET /health identity contract", () => {
  it("evaluates health identity without runtime package metadata", () => {
    expect(SUPER_MCP_BUILD_VERSION).toBe(GENERATED_SUPER_MCP_BUILD_VERSION);
    expect(moduleMocks.createRequire).not.toHaveBeenCalled();
  });

  it("evaluates the built health module when packaged with dist but no package.json", async () => {
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const stageRoot = mkdtempSync(path.join(packageRoot, ".packaged-health-test-"));
    const packagedRouterRoot = path.join(stageRoot, "super-mcp");
    const packagedDist = path.join(packagedRouterRoot, "dist");

    try {
      mkdirSync(packagedRouterRoot);
      cpSync(path.join(packageRoot, "dist"), packagedDist, { recursive: true });

      const packagedHealth = await import(
        `${pathToFileURL(path.join(packagedDist, "health.js")).href}?packaged-test=${Date.now()}`
      );

      expect(packagedHealth.SUPER_MCP_BUILD_VERSION).toBe(
        GENERATED_SUPER_MCP_BUILD_VERSION,
      );
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  });

  it("returns the versioned router owner, build, and diagnostic PID", () => {
    let healthHandler: express.RequestHandler | undefined;
    const app = {
      get: vi.fn((path: string, handler: express.RequestHandler) => {
        expect(path).toBe("/health");
        healthHandler = handler;
      }),
    } as unknown as express.Express;
    const ownerId = "123e4567-e89b-42d3-a456-426614174000";
    registerSuperMcpHealthRoute(app, ownerId);

    const json = vi.fn();
    expect(healthHandler).toBeDefined();
    healthHandler?.(
      {} as express.Request,
      { json } as unknown as express.Response,
      vi.fn()
    );

    expect(json).toHaveBeenCalledWith({
      status: "ok",
      transport: "http",
      healthSchemaVersion: SUPER_MCP_HEALTH_SCHEMA_VERSION,
      ownerId,
      buildVersion: SUPER_MCP_BUILD_VERSION,
      pid: process.pid,
    });
  });
});
