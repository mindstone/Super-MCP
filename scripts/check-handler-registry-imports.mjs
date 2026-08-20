import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const explicitExecutionHandlers = new Set([
  "authenticate.ts",
  "bulkExport.ts",
  "healthCheck.ts",
  "healthCheckPackage.ts",
  "readResource.ts",
  "restartPackage.ts",
  "useTool.ts",
]);

// Stage 6 removes these legacy imports. Until then, pin their current narrow
// method surface so the still-live discovery path cannot accrete a direct
// getClient/connect/call seam.
const legacyDiscoveryMethods = new Map([
  ["getHelp.ts", new Set(["getPackage"])],
  ["getToolDetails.ts", new Set(["getPackage"])],
  ["listToolPackages.ts", new Set(["getPackages", "healthCheck"])],
  ["listTools.ts", new Set(["getPackage"])],
  ["searchTools.ts", new Set(["getPackage", "getPackages"])],
]);

const defaultHandlersDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/handlers",
);
const handlersDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultHandlersDir;
const registryImport = /from\s+["'][^"']*registry\.js["']/g;
const registryMethod = /\bregistry\.([A-Za-z_$][\w$]*)/g;
const violations = [];

for (const entry of await readdir(handlersDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const source = await readFile(path.join(handlersDir, entry.name), "utf8");
  if (!registryImport.test(source)) continue;
  registryImport.lastIndex = 0;
  if (explicitExecutionHandlers.has(entry.name)) continue;

  const allowedMethods = legacyDiscoveryMethods.get(entry.name);
  if (!allowedMethods) {
    violations.push(`${entry.name}: registry import is not allowed`);
    continue;
  }
  const sourceWithoutRegistryImports = source.replace(registryImport, "");
  registryImport.lastIndex = 0;
  for (const match of sourceWithoutRegistryImports.matchAll(registryMethod)) {
    if (!allowedMethods.has(match[1])) {
      violations.push(`${entry.name}: registry.${match[1]} is not allowed on discovery paths`);
    }
  }
}

if (violations.length > 0) {
  console.error("Handler/registry boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}
