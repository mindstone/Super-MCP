import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Host mode refuses renewal throughout startup; offers run after the transport starts.

const observed = vi.hoisted(() => ({ heldAtDiscovery: undefined as unknown, tokenFile: "", listening: false }));

vi.mock("../src/logging.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), setLevel: vi.fn() }),
}));
vi.mock("../src/registry.js", () => ({
  PackageRegistry: {
    fromConfigFiles: vi.fn(async () => ({ startIdleReaper: vi.fn(), getPackages: () => [], getPackage: () => undefined })),
  },
}));
vi.mock("../src/catalog.js", () => ({ Catalog: class {} }));
vi.mock("../src/catalogRefresher.js", () => ({
  CatalogRefresher: class {
    start(): void {
      observed.heldAtDiscovery = JSON.parse(fs.readFileSync(observed.tokenFile, "utf8")).__superMcpRenewalHeldByHost;
    }
    async dispose(): Promise<void> {}
  },
}));
vi.mock("../src/configWatcher.js", () => ({
  ConfigWatcher: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
  handleConfigurationChange: vi.fn(),
}));
vi.mock("express", async () => {
  const { EventEmitter } = await import("node:events");
  const express = () => ({
    use: vi.fn(), get: vi.fn(), post: vi.fn(), delete: vi.fn(),
    listen: (_port: number, _host: string, ready: () => void) => {
      const listener = new EventEmitter();
      queueMicrotask(() => {
        observed.listening = true;
        listener.emit("listening");
        ready();
      });
      return listener;
    },
  });
  return { default: Object.assign(express, { json: () => vi.fn() }) };
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start(): Promise<void> { observed.listening = true; }
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

import { startServer } from "../src/server.js";
import { SimpleOAuthProvider } from "../src/auth/providers/simple.js";

describe("startup renewal hold", () => {
  let tempDir: string;
  let stopIntervals: () => void;
  let removeSignalHandlers: () => void;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    stopIntervals = () => {
      for (const result of intervals.mock.results) {
        if (result.type === "return") clearInterval(result.value);
      }
    };
    const signals = ["SIGINT", "SIGTERM"] as const;
    const before = signals.map(signal => process.listeners(signal));
    removeSignalHandlers = () => signals.forEach((signal, index) => {
      for (const listener of process.listeners(signal)) {
        if (!before[index].includes(listener)) process.removeListener(signal, listener);
      }
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "super-mcp-startup-hold-"));
    observed.tokenFile = path.join(tempDir, "Acme-notes_tokens.json");
    fs.writeFileSync(
      observed.tokenFile,
      JSON.stringify({ access_token: "access-a", token_type: "Bearer", refresh_token: "refresh-r0" }),
    );
    process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tempDir;
    observed.listening = false;
    observed.heldAtDiscovery = undefined;
  });

  afterEach(() => {
    stopIntervals();
    removeSignalHandlers();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["stdio", "http"] as const)("offers after %s starts and before catalog discovery", async transport => {
    process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
    process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
    const write = SimpleOAuthProvider.prototype.atomicWriteTokens;
    const writes = vi.spyOn(SimpleOAuthProvider.prototype, "atomicWriteTokens").mockImplementation(async function (
      this: SimpleOAuthProvider, ...args
    ) {
      expect(observed.listening).toBe(true);
      return write.apply(this, args);
    });
    await startServer({ configPaths: [path.join(tempDir, "config.json")], transport });
    expect(observed.heldAtDiscovery).toBe(true);
    expect(writes).toHaveBeenCalled();
  });

  it("keeps listening and starts discovery when one token file cannot be prepared", async () => {
    // An unreadable token file (a directory) makes the hold itself fail.
    fs.mkdirSync(path.join(tempDir, "A-broken_tokens.json"));
    process.env.SUPER_MCP_HOST_GRANTS_DIR = path.join(tempDir, "pending");
    process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
    await expect(startServer({ configPaths: [path.join(tempDir, "config.json")], transport: "stdio" })).resolves.toBeUndefined();
    expect(observed.listening).toBe(true);
    expect(observed.heldAtDiscovery).toBe(true);
  });

  it("still rejects invalid grants-directory configuration before starting the transport", async () => {
    process.env.SUPER_MCP_HOST_GRANTS_DIR = "relative";
    process.env.MCP_HOST_BRIDGE_STATE = path.join(tempDir, "bridge.json");
    await expect(startServer({ configPaths: [path.join(tempDir, "config.json")], transport: "stdio" })).rejects.toThrow(/Absolute/);
    expect(observed.listening).toBe(false);
    expect(observed.heldAtDiscovery).toBeUndefined();
  });
});
