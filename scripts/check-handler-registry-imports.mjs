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

const defaultHandlersDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/handlers",
);
const handlersDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultHandlersDir;
const registryImport = /from\s+["'][^"']*registry\.js["']/g;
const violations = [];

for (const entry of await readdir(handlersDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const source = await readFile(path.join(handlersDir, entry.name), "utf8");
  if (!registryImport.test(source)) continue;
  registryImport.lastIndex = 0;
  if (explicitExecutionHandlers.has(entry.name)) continue;

  violations.push(`${entry.name}: registry import is not allowed`);
}

if (violations.length > 0) {
  console.error("Handler/registry boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}
