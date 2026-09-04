import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const checkerPath = path.join(projectRoot, "scripts", "check-handler-registry-imports.mjs");
const fixturesDir = path.join(testDir, "fixtures", "handler-registry-imports");

async function runChecker(fixtureName: string, expectedFileCount: number) {
  const fixtureDir = path.join(fixturesDir, fixtureName);
  const fixtureFiles = (await readdir(fixtureDir, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".ts"),
  );
  expect(fixtureFiles, `${fixtureName} fixture files`).toHaveLength(expectedFileCount);

  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const errors: string[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => errors.push(args.join(" ")));

  process.argv[2] = fixtureDir;
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
    const result = await runChecker("type-only", 2);

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("rejects a value import outside the execution-handler allow-list", async () => {
    const result = await runChecker("value-import", 1);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
  });

  it("allows a value import from an explicitly allowed execution handler", async () => {
    const result = await runChecker("allow-listed", 1);

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("rejects an import with mixed type and value specifiers", async () => {
    const result = await runChecker("mixed-import", 1);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
  });

  it("rejects a value re-export outside the execution-handler allow-list", async () => {
    const result = await runChecker("export-value", 2);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
    expect(result.stderr).toContain("starHandler.ts: registry import is not allowed");
  });

  it("allows a type-only re-export", async () => {
    const result = await runChecker("export-type", 1);

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("rejects a value import whose imported binding is named type", async () => {
    const result = await runChecker("value-named-type", 1);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ordinaryHandler.ts: registry import is not allowed");
  });
});
