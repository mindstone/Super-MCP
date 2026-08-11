import type express from "express";
import { GENERATED_SUPER_MCP_BUILD_VERSION } from "./buildVersion.generated.js";

export const SUPER_MCP_HEALTH_SCHEMA_VERSION = 1 as const;

// Keep malformed generated metadata non-fatal at runtime. The build generator
// rejects it before compilation, while this guard ensures health metadata can
// never stop the router during module evaluation in a packaged installation.
export const SUPER_MCP_BUILD_VERSION =
  typeof GENERATED_SUPER_MCP_BUILD_VERSION === "string" &&
  GENERATED_SUPER_MCP_BUILD_VERSION.length > 0
    ? GENERATED_SUPER_MCP_BUILD_VERSION
    : null;

export function buildSuperMcpHealthResponse(ownerId?: string) {
  return {
    status: "ok" as const,
    transport: "http" as const,
    healthSchemaVersion: SUPER_MCP_HEALTH_SCHEMA_VERSION,
    ownerId: ownerId ?? null,
    buildVersion: SUPER_MCP_BUILD_VERSION,
    pid: process.pid,
  };
}

export function registerSuperMcpHealthRoute(
  app: express.Express,
  ownerId?: string
): void {
  app.get("/health", (_req, res) => {
    res.json(buildSuperMcpHealthResponse(ownerId));
  });
}
