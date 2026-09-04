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
const registryImport = /^[ \t]*import\s+(type\s+)?((?:[$A-Z_a-z][$\w]*\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[$A-Z_a-z][$\w]*)|[$A-Z_a-z][$\w]*)\s+from\s+["'][^"'\r\n]*registry\.js["'][ \t]*;?/gm;
const violations = [];

function isTypeOnlyImport(match) {
  if (match[1]) return true;

  const importClause = match[2].trim();
  if (!importClause.startsWith("{") || !importClause.endsWith("}")) {
    return false;
  }

  const specifiers = importClause
    .slice(1, -1)
    .split(",")
    .map((specifier) =>
      specifier
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\r\n]*/g, "")
        .trim(),
    )
    .filter(Boolean);

  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => /^type\s+/.test(specifier))
  );
}

for (const entry of await readdir(handlersDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const source = await readFile(path.join(handlersDir, entry.name), "utf8");
  const hasRuntimeRegistryImport = Array.from(
    source.matchAll(registryImport),
  ).some((match) => !isTypeOnlyImport(match));
  if (!hasRuntimeRegistryImport) continue;
  if (explicitExecutionHandlers.has(entry.name)) continue;

  violations.push(`${entry.name}: registry import is not allowed`);
}

if (violations.length > 0) {
  console.error("Handler/registry boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}
