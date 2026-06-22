import { exec } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import PQueue from "p-queue";
import { McpClient, PackageConfig, ReadResourceResult } from "../types.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

// Maximum recursion depth for process tree traversal (prevents runaway in pathological cases)
const MAX_PROCESS_TREE_DEPTH = 20;

/**
 * Kill a process tree to ensure all child/grandchild processes are terminated.
 * This is critical for MCP servers launched via wrappers like `npm run dev` or `npx`,
 * where the actual MCP server is a grandchild process.
 * 
 * On Windows: uses taskkill /t to kill the entire tree (recursive)
 * On Unix/macOS: recursively finds all descendants via pgrep and kills them leaf-first
 * 
 * IMPORTANT: Must be called BEFORE the parent process is killed, otherwise on Unix
 * the children get reparented to PID 1 and we can't find them via PPID.
 */
const killProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    // taskkill /pid <pid> /t /f
    // /t = kill process tree (all child processes) - this IS recursive
    // /f = force kill (don't wait for graceful shutdown)
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /t /f`, (error) => {
        if (error) {
          // Error codes 128 and 1 mean "no process found" which is fine (already dead)
          if ((error as any).code !== 128 && (error as any).code !== 1) {
            logger.debug("taskkill failed (process may already be dead)", { pid, error: error.message });
          }
        }
        resolve();
      });
    });
  } else {
    // On Unix/macOS: recursively find all descendants and kill them leaf-first
    // This ensures children don't get reparented before we can kill them
    const getAllDescendants = (parentPid: number, depth = 0): Promise<number[]> => {
      // Depth limit prevents infinite recursion in pathological cases
      if (depth >= MAX_PROCESS_TREE_DEPTH) {
        logger.warn("Process tree depth limit reached", { parentPid, depth, max: MAX_PROCESS_TREE_DEPTH });
        return Promise.resolve([]);
      }
      
      return new Promise((resolve) => {
        // pgrep -P finds direct children; we recursively gather all descendants
        exec(`pgrep -P ${parentPid} 2>/dev/null`, async (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve([]);
            return;
          }
          const directChildren = stdout.trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p));
          
          // Recursively get grandchildren in parallel (reduces race window for PID reparenting)
          const grandchildrenArrays = await Promise.all(
            directChildren.map(childPid => getAllDescendants(childPid, depth + 1))
          );
          
          // Flatten grandchildren arrays, then append direct children
          // Result order: deepest descendants first, then work up to direct children
          const allDescendants: number[] = [];
          for (const arr of grandchildrenArrays) {
            allDescendants.push(...arr);
          }
          allDescendants.push(...directChildren);
          resolve(allDescendants);
        });
      });
    };
    
    try {
      // Get all descendants (leaves first)
      const descendants = await getAllDescendants(pid);
      
      // Kill all descendants (leaves first, then work up to direct children)
      for (const descendantPid of descendants) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Process may already be dead
        }
      }
      
      // Finally kill the root process
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may already be dead
      }
    } catch {
      // Best effort - if anything fails, still try to kill the root
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore
      }
    }
  }
};

// STDIO transport uses a single stdin/stdout pipe, so requests must be serialized
// to avoid race conditions and "stream busy" errors documented in:
// - https://github.com/modelcontextprotocol/csharp-sdk/issues/88
// - https://github.com/modelcontextprotocol/python-sdk/issues/824
// - https://github.com/jlowin/fastmcp/issues/1625
const STDIO_CONCURRENCY = 1;

// Bounded ring-buffer caps for captured child stderr. We keep the LAST N lines
// AND a total byte cap (whichever bound is hit first), so a chatty or hostile
// connector child cannot grow unbounded memory while we still retain the most
// recent (most diagnostic) output for the connect-failure surface.
const STDERR_MAX_LINES = 50;
const STDERR_MAX_BYTES = 16 * 1024; // 16 KiB

export class StdioMcpClient implements McpClient {
  private client: Client;
  private transport: StdioClientTransport;
  private packageId: string;
  private config: PackageConfig;
  private requestQueue: PQueue;

  // --- Per-package connect diagnostics (B1) ---
  // Bounded ring buffer of the connector child's most recent stderr lines.
  private stderrRing: string[] = [];
  // Pending (not-yet-newline-terminated) stderr fragment.
  private stderrPartial = "";
  // Running byte total across the ring + partial, to enforce STDERR_MAX_BYTES.
  private stderrBytes = 0;
  // Whether the child was OBSERVED to emit any stderr / start during THIS connect
  // attempt. Distinguishes a fresh child that spawned then died (stderr likely
  // present) from a reused/already-closed transport that fast-fails with no real
  // spawn this call (no stderr — the ~81ms transport-reuse race case).
  private spawnObservedThisCall = false;
  // Spawn-level 'error' event message (e.g. ENOENT), if the SDK surfaced one via
  // transport.onerror during this connect attempt.
  private spawnErrorMessage: string | null = null;
  // Whether the child process was observed to close during this connect attempt.
  // NOTE: the installed @modelcontextprotocol/sdk (1.28.0) drops the child's exit
  // CODE in its onclose handler (`(_code) => ...`), so the numeric exit code is
  // NOT reachable through the public SDK API — we can only observe THAT it closed.
  private childClosedThisCall = false;

  constructor(packageId: string, config: PackageConfig) {
    this.packageId = packageId;
    this.config = config;
    
    // Request queue to serialize concurrent calls to this STDIO client
    this.requestQueue = new PQueue({ concurrency: STDIO_CONCURRENCY });
    
    logger.info("Created STDIO MCP client with request queue", {
      package_id: packageId,
      queue_concurrency: STDIO_CONCURRENCY,
    });
    
    // We'll initialize the client and transport in connect()
    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
    
    // Placeholder transport - will be replaced in connect()
    // Let the SDK handle environment variable merging with safe defaults
    this.transport = new StdioClientTransport({
      command: config.command || "echo",
      args: config.args || [],
      env: config.env,
      cwd: config.cwd,
    });
  }

  /**
   * Reset all per-call connect diagnostics. Called at the start of each connect
   * attempt and after a SUCCESSFUL connect (so a later failure on a re-connect
   * reflects only that attempt's output, not stale data).
   */
  private resetConnectDiagnostics(): void {
    this.stderrRing = [];
    this.stderrPartial = "";
    this.stderrBytes = 0;
    this.spawnObservedThisCall = false;
    this.spawnErrorMessage = null;
    this.childClosedThisCall = false;
  }

  /**
   * Append a chunk of child stderr into the bounded ring buffer. Splits on
   * newlines, keeps at most STDERR_MAX_LINES lines, and trims from the front
   * once the total retained bytes exceed STDERR_MAX_BYTES (whichever bound is
   * hit first).
   */
  private appendStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) return;
    this.spawnObservedThisCall = true;

    const combined = this.stderrPartial + text;
    const parts = combined.split("\n");
    // The last element is the (possibly empty) not-yet-terminated partial line.
    this.stderrPartial = parts.pop() ?? "";

    for (const line of parts) {
      this.stderrRing.push(line);
      this.stderrBytes += Buffer.byteLength(line, "utf8") + 1; // + newline
    }

    // Enforce line cap (drop oldest first).
    while (this.stderrRing.length > STDERR_MAX_LINES) {
      const dropped = this.stderrRing.shift();
      if (dropped !== undefined) {
        this.stderrBytes -= Buffer.byteLength(dropped, "utf8") + 1;
      }
    }
    // Enforce byte cap (drop oldest first), but always keep at least one line so
    // a single huge line still yields something diagnostic.
    while (this.stderrBytes > STDERR_MAX_BYTES && this.stderrRing.length > 1) {
      const dropped = this.stderrRing.shift();
      if (dropped !== undefined) {
        this.stderrBytes -= Buffer.byteLength(dropped, "utf8") + 1;
      }
    }
  }

  /**
   * Return the captured stderr tail (most recent lines + any trailing partial
   * line) from the most recent connect attempt, or null if nothing was captured.
   */
  getStderrTail(): string | null {
    const lines = [...this.stderrRing];
    if (this.stderrPartial.length > 0) lines.push(this.stderrPartial);
    if (lines.length === 0) return null;
    return lines.join("\n");
  }

  async connect(): Promise<void> {
    // Workspace propagation contract for stdio MCP subprocesses.
    // Super-mcp owns the MCP_WORKSPACE_PATH key on this router boundary, in
    // line with the OSS connector convention (see
    // docs/project/MCP_SERVER_STANDARD.md, which forbids OSS connectors from
    // reading REBEL_WORKSPACE_PATH). Rebel-branded connectors (openai-image)
    // already set REBEL_WORKSPACE_PATH via their catalog env at
    // bundledMcpManager.ts; this router does not touch that key, so their
    // payload passes through unchanged. The read-side accepts either parent
    // env name (REBEL_ or MCP_) so the eventual D1 parent-env rename is
    // transparent AT THIS CALL SITE ONLY — other super-mcp code that still
    // reads REBEL_WORKSPACE_PATH (e.g. handlers/useTool.ts materialization
    // path) will need separate migration under D1.
    //
    // Precedence: first non-empty trimmed value wins. `||` (not `??`) is
    // deliberate so that an empty REBEL_WORKSPACE_PATH (set by
    // superMcpHttpManager.ts and cloud-service/src/bootstrap.ts when
    // coreDirectory is unset) falls through to MCP_WORKSPACE_PATH rather
    // than short-circuiting.
    const rebelTrimmed = process.env.REBEL_WORKSPACE_PATH?.trim();
    const mcpTrimmed = process.env.MCP_WORKSPACE_PATH?.trim();
    const workspacePath = rebelTrimmed || mcpTrimmed || undefined;

    let mergedEnv: Record<string, string> | undefined = this.config.env;
    if (workspacePath) {
      if (
        this.config.env?.MCP_WORKSPACE_PATH &&
        this.config.env.MCP_WORKSPACE_PATH !== workspacePath
      ) {
        logger.warn("catalog env MCP_WORKSPACE_PATH overridden by router", {
          package_id: this.packageId,
          had_catalog_value: true,
        });
      }
      mergedEnv = { ...(this.config.env ?? {}), MCP_WORKSPACE_PATH: workspacePath };
    }

    logger.info("Connecting to stdio MCP", {
      package_id: this.packageId,
      command: this.config.command,
      args: this.config.args,
      workspace: workspacePath ? 'set' : 'unset',
    });

    logger.debug("stdio subprocess workspace env (debug only)", {
      package_id: this.packageId,
      workspace_path: workspacePath ?? null,
    });

    // Workaround: MCP SDK gates windowsHide on isElectron() which checks
    // 'type' in process. Super-MCP runs as plain Node.js (not Electron),
    // so child processes get visible console windows on Windows.
    // Temporarily set process.type so the SDK sets windowsHide: true.
    // TODO: Remove when @modelcontextprotocol/sdk exposes windowsHide as a parameter
    // or unconditionally sets it on Windows. Tracked upstream.
    const needsWindowsHideFix = process.platform === 'win32' && !('type' in process);
    if (needsWindowsHideFix) {
      (process as any).type = 'utility';
    }

    // Reset per-call diagnostics so a failure reflects only THIS attempt.
    this.resetConnectDiagnostics();

    try {
      // Create the transport.
      // `stderr: 'pipe'` makes the SDK expose `transport.stderr` as a readable
      // PassThrough IMMEDIATELY (before start()), so we can attach a listener
      // before client.connect() and not lose early child error output (B1).
      // Let the SDK handle environment variable merging with safe defaults.
      this.transport = new StdioClientTransport({
        command: this.config.command || "echo",
        args: this.config.args || [],
        env: mergedEnv,
        cwd: this.config.cwd,
        stderr: "pipe",
      });

      // Attach the stderr listener BEFORE connecting so we capture any output
      // emitted during the spawn/handshake window.
      const stderrStream = this.transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", (chunk: Buffer | string) => {
          this.appendStderr(chunk);
        });
      }

      // Capture spawn-level errors (e.g. ENOENT) and child close, which the
      // raw thrown error often doesn't carry cleanly. The SDK invokes onerror
      // for spawn failures and onclose when the child exits; note the SDK drops
      // the exit code, so we can record THAT it closed but not the code.
      this.transport.onerror = (err: Error) => {
        this.spawnObservedThisCall = true;
        this.spawnErrorMessage = err instanceof Error ? err.message : String(err);
      };
      this.transport.onclose = () => {
        this.childClosedThisCall = true;
      };

      // Connect the client to the transport
      await this.client.connect(this.transport);

      // Successful connect: a real child spawned and handshook. Clear the
      // captured diagnostics so they can't leak into a later failure.
      this.resetConnectDiagnostics();

      logger.info("Successfully connected to stdio MCP", {
        package_id: this.packageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Per-call diagnostics (B1): give the next investigator enough to tell a
      // fresh-child death (stderr present, spawn observed) from a reused/closed
      // transport that fast-failed without a real spawn this call (no stderr).
      const stderrTail = this.getStderrTail();
      const childExitObserved = this.childClosedThisCall;
      const spawnObserved = this.spawnObservedThisCall;
      const spawnErrorMessage = this.spawnErrorMessage;

      logger.error("Failed to connect to stdio MCP", {
        package_id: this.packageId,
        command: this.config.command,
        args: this.config.args,
        error: errorMessage,
        // B1 diagnostics:
        stderr_tail: stderrTail,
        spawn_observed_this_call: spawnObserved,
        spawn_error: spawnErrorMessage,
        child_close_observed: childExitObserved,
        // Exit CODE is not reachable via the installed SDK (it drops _code in
        // onclose); we surface only whether the child was observed to close.
        child_exit_code: null,
      });

      // Provide detailed diagnostic information
      let diagnosticMessage = `Failed to connect to MCP server '${this.packageId}'.\n`;
      
      // Check common issues
      if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
        diagnosticMessage += `\n❌ Command not found: '${this.config.command}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Install the MCP server: npm install -g ${this.config.command}`;
        diagnosticMessage += `\n  2. If using npx, ensure Node.js is installed`;
        diagnosticMessage += `\n  3. Check if the command path is correct`;
        if (this.config.command === "npx" && this.config.args?.[0]) {
          diagnosticMessage += `\n  4. Try installing the package: npm install -g ${this.config.args[0]}`;
        }
      } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission")) {
        diagnosticMessage += `\n❌ Permission denied for command: '${this.config.command}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Check file permissions: chmod +x ${this.config.command}`;
        diagnosticMessage += `\n  2. Ensure you have execute permissions`;
      } else if (errorMessage.includes("spawn")) {
        diagnosticMessage += `\n❌ Failed to spawn process`;
        diagnosticMessage += `\nCommand: ${this.config.command} ${this.config.args?.join(" ") || ""}`;
        diagnosticMessage += `\nWorking directory: ${this.config.cwd || process.cwd()}`;
      } else {
        diagnosticMessage += `\n❌ ${errorMessage}`;
      }
      
      // Check environment variables
      if (this.config.env) {
        const missingEnvVars = Object.entries(this.config.env)
          .filter(([_, value]) => !value || value === "")
          .map(([key]) => key);
        
        if (missingEnvVars.length > 0) {
          diagnosticMessage += `\n\n⚠️ Empty environment variables detected:`;
          missingEnvVars.forEach(key => {
            diagnosticMessage += `\n  - ${key}: Not set or empty`;
          });
        }
      }
      
      // Surface the per-call diagnostics to the Rebel boundary (which shows the
      // connect-failure error to users/logs) — not just inside super-mcp's log.
      // The "spawn-observed-this-call" marker is the key disambiguator for the
      // -32000 transport-reuse race: no spawn observed + no stderr + fast fail
      // => the reused/already-closed-transport case, NOT a connector boot crash.
      diagnosticMessage += `\n\n— Connect diagnostics —`;
      diagnosticMessage += `\nChild spawn observed this attempt: ${spawnObserved ? "yes" : "no"}`;
      diagnosticMessage += `\nChild close observed this attempt: ${childExitObserved ? "yes" : "no"}`;
      if (spawnErrorMessage) {
        diagnosticMessage += `\nSpawn error: ${spawnErrorMessage}`;
      }
      if (stderrTail) {
        diagnosticMessage += `\nChild stderr (tail):\n${stderrTail}`;
      } else {
        diagnosticMessage += `\nChild stderr: (none captured)`;
      }

      const enhancedError = new Error(diagnosticMessage);
      enhancedError.name = "MCPConnectionError";
      (enhancedError as any).originalError = error;
      (enhancedError as any).packageId = this.packageId;
      // Structured diagnostics for any consumer that reads error.data rather
      // than parsing the message string.
      (enhancedError as any).data = {
        packageId: this.packageId,
        stderrTail,
        spawnObservedThisCall: spawnObserved,
        spawnError: spawnErrorMessage,
        childCloseObserved: childExitObserved,
        // Not reachable via the installed SDK — see field comment above.
        childExitCode: null,
      };
      throw enhancedError;
    } finally {
      if (needsWindowsHideFix) {
        delete (process as any).type;
      }
    }
  }

  async listTools(): Promise<any[]> {
    const timeout = parseInt(process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT || '10000');

    logger.info("Listing tools from stdio MCP", {
      package_id: this.packageId,
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.listTools(undefined, { timeout });
        
        logger.info("Retrieved tools from stdio MCP", {
          package_id: this.packageId,
          tool_count: response.tools?.length || 0,
        });

        return response.tools || [];
      } catch (error) {
        logger.error("Failed to list tools from stdio MCP", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<any[]>;
  }

  async callTool(name: string, args: any): Promise<any> {
    // 4h sentinel — aligned with httpClient.ts and Rebel Core's TOOL_CALL_TIMEOUT
    // so long-running tools (deep research, Rebel Browser pair waiting, large data
    // queries) are never killed by the upstream layer before the outer timers fire.
    // The agent-turn watchdog (Layer 2) is the real effective ceiling. RebelAppBridge
    // is stdio-only, so raising the stdio default is required for rebel_bridge_wait_pair_event's
    // 10min window to be honored end-to-end.
    const timeout = this.config.timeout ||
                    parseInt(process.env.SUPER_MCP_TOOL_TIMEOUT || '14400000');

    logger.info("Calling tool on stdio MCP", {
      package_id: this.packageId,
      tool_name: name,
      args_keys: typeof args === "object" && args ? Object.keys(args) : [],
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.callTool({
          name,
          arguments: args || {},
        }, undefined, {
          timeout,
          resetTimeoutOnProgress: true, // Reset timeout when progress notifications are received
        });

        logger.info("Tool call completed", {
          package_id: this.packageId,
          tool_name: name,
          has_content: !!(response && response.content),
        });

        // MCP client returns { content: [...] } directly
        return response;
      } catch (error) {
        logger.error("Tool call failed", {
          package_id: this.packageId,
          tool_name: name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    // Get PID before closing (SDK exposes it via transport.pid)
    const pid = this.transport.pid;
    
    logger.info("Closing stdio MCP client", {
      package_id: this.packageId,
      pid,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    try {
      // Clear any pending requests in the queue
      this.requestQueue.clear();
      
      // IMPORTANT: Kill the process tree BEFORE SDK close, while PPID linkage is still valid.
      // The SDK's close() kills the spawned process, which causes children to be reparented
      // to PID 1 on Unix, making pkill -P ineffective. We must kill descendants first.
      if (pid) {
        logger.debug("Killing process tree before SDK close (while PPID linkage is valid)", { package_id: this.packageId, pid });
        await killProcessTree(pid);
      }
      
      // Now let the SDK clean up (will detect process already exited)
      await this.client.close();

      logger.info("Stdio MCP client closed", {
        package_id: this.packageId,
      });
    } catch (error) {
      logger.error("Error closing stdio MCP client", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async healthCheck(): Promise<"ok" | "error"> {
    try {
      // Try to list tools as a health check
      await this.listTools();
      return "ok";
    } catch (error) {
      logger.warn("Health check failed for stdio MCP", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "error";
    }
  }

  async requiresAuth(): Promise<boolean> {
    // Stdio MCPs use environment variables for auth, handled at startup
    return false;
  }

  async isAuthenticated(): Promise<boolean> {
    // Stdio MCPs are authenticated via environment variables at startup
    return true;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    logger.info("Reading resource from stdio MCP", {
      package_id: this.packageId,
      uri,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.readResource({ uri });
        return { contents: response.contents || [] };
      } catch (error) {
        logger.error("Failed to read resource from stdio MCP", {
          package_id: this.packageId,
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<ReadResourceResult>;
  }

  supportsResources(): boolean {
    // Optimistically assume resources are supported; let the request fail if not
    return true;
  }

  hasPendingRequests(): boolean {
    return this.requestQueue.pending > 0 || this.requestQueue.size > 0;
  }

  /**
   * Stage 6: report whether the underlying child process is gone.
   *
   * The SDK's `StdioClientTransport` exposes `pid`, which is `null` before the
   * child is spawned and after it exits/closes. We use it as the liveness
   * signal for the pre-send re-establish in `PackageRegistry.callTool`: a
   * closed transport (`pid == null`) means no live child, so a fresh client
   * must be created before dispatching. Same field the SDK uses in `close()`
   * (see `this.transport.pid` above) and in registry `getChildStats()`.
   */
  isTransportClosed(): boolean {
    return this.transport.pid == null;
  }
}