import { describe, expect, it, vi } from "vitest";
import type express from "express";
import {
  registerSuperMcpHealthRoute,
  SUPER_MCP_BUILD_VERSION,
  SUPER_MCP_HEALTH_SCHEMA_VERSION,
} from "../health.js";

describe("GET /health identity contract", () => {
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
