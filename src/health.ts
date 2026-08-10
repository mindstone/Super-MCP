import type express from "express";
import { createRequire } from "node:module";

export const SUPER_MCP_HEALTH_SCHEMA_VERSION = 1 as const;

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  version?: unknown;
};
if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("super-mcp package version is missing");
}
export const SUPER_MCP_BUILD_VERSION = packageMetadata.version;

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
