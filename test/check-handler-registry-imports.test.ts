import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const checkerPath = path.join(projectRoot, "scripts", "check-handler-registry-imports.mjs");
const fixturesDir = path.join(testDir, "fixtures", "handler-registry-imports");

async function runChecker(fixtureName: string) {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const errors: string[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => errors.push(args.join(" ")));

  process.argv[2] = path.join(fixturesDir, fixtureName);
  process.exitCode = undefined;

  try {
    await import(
      /* @vite-ignore */ `${pathToFileURL(checkerPath).href}?fixture=${fixtureName}`
    );
    return { exitCode: process.exitCode ?? 0, stderr: errors.join("\n") };
  } finally {
    consoleError.mockRestore();
    process.argv.splice(0, process.argv.length, ...originalArgv);
    process.exitCode = originalExitCode;
  }
}

describe("handler/registry boundary checker", () => {
  it("allows imports that are entirely type-only", async () => {
    const result = await runChecker("type-only");

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("rejects a value import outside the execution-handler allow-list", async () => {
    const result = await runChecker("value-import");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
  });

  it("allows a value import from an explicitly allowed execution handler", async () => {
    const result = await runChecker("allow-listed");

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("rejects an import with mixed type and value specifiers", async () => {
    const result = await runChecker("mixed-import");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
  });
});
