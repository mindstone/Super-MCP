import { mkdtempSync, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initLogger } from "../logging.js";

type LoggerInternals = { sanitizeData(data: unknown): unknown; logStream: WriteStream; logFile: string };

describe("logging redaction", () => {
  let home: string;
  let logger: LoggerInternals;

  beforeAll(() => {
    // Building the real logger creates its log file under the home folder and adds process handlers.
    home = mkdtempSync(join(tmpdir(), "super-mcp-logging-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const processOn = vi.spyOn(process, "on").mockReturnThis();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    logger = initLogger() as unknown as LoggerInternals;
    processOn.mockRestore();
    consoleError.mockRestore();
  });

  afterAll(async () => {
    await new Promise<void>(resolve => { logger.logStream.end(resolve); });
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes its log file inside the temporary home", () => {
    expect(logger.logFile.startsWith(home)).toBe(true);
  });

  it("keeps boolean credential flags while redacting credential strings", () => {
    expect(logger.sanitizeData({ has_access_token: true, has_refresh_token: false, access_token: "fictional-access", client_secret: "fictional-secret" }))
      .toEqual({ has_access_token: true, has_refresh_token: false, access_token: "[REDACTED]", client_secret: "[REDACTED]" });
  });
});
