import { exec } from "child_process";
import fs from "node:fs";
import path from "node:path";
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

/**
 * The upstream filesystem server takes its allowed directories from argv (or the
 * MCP roots protocol, which this router does not implement). It reads no
 * environment variable for them — so `MCP_ALLOWED_SYMLINK_ROOTS`, which our own
 * connectors consume, is inert here. Spawned with neither, it denies EVERY path,
 * which is the defect this addresses: the reported symlinked-Space denial was a
 * symptom, not the cause.
 *
 * Identity is established from the command form rather than a catalog id: the
 * connector is typically hand-added and carries no catalog identity. Ambiguous
 * wrappers and npm aliases fail closed so roots never reach an unrelated process.
 */
const STOCK_FILESYSTEM_PACKAGE = "@modelcontextprotocol/server-filesystem";
const STOCK_FILESYSTEM_BINARY = "mcp-server-filesystem";
const REDACTED_FILESYSTEM_ROOT = "[filesystem root redacted]";
const MIN_REDACTABLE_FILESYSTEM_ROOT_LENGTH = 4;

type FilesystemCommandKind = "npx" | "node" | "stock-filesystem-binary" | "other";

type FilesystemInvocation =
  | {
      status: "recognized";
      commandKind: Exclude<FilesystemCommandKind, "other">;
      serverArgStart: number;
    }
  | {
      status: "ambiguous" | "other";
      commandKind: FilesystemCommandKind;
    };

type ParsedDeclaredRoots = {
  roots: string[];
  declaredCount: number;
  parseable: boolean;
};

function commandBasename(command: string): string {
  return command.split(/[\\/]/).pop() ?? "";
}

function commandNameMatches(command: string, expected: string): boolean {
  return process.platform === "win32"
    ? command.toLowerCase() === expected.toLowerCase()
    : command === expected;
}

function isBareCommand(command: string): boolean {
  return command === commandBasename(command);
}

function isNpxCommand(command: string): boolean {
  const basename = commandBasename(command);
  const hasNpxBasename = ["npx", "npx.cmd", "npx.exe"]
    .some((candidate) => commandNameMatches(basename, candidate));
  if (!hasNpxBasename) return false;
  if (isBareCommand(command)) return true;
  // Every other lane proves identity from the disk (the direct binary walks to a
  // package.json, a node command is realpath-compared to process.execPath). An
  // absolute path that does not exist would otherwise be recognised on its
  // basename alone, leaving this the one lane resting entirely on a string.
  return path.isAbsolute(command) && fs.existsSync(command);
}

function isNodeCommand(command: string, cwd: string | undefined): boolean {
  const basename = commandBasename(command);
  if (isBareCommand(command) && ["node", "node.exe"]
    .some((candidate) => commandNameMatches(basename, candidate))) {
    return true;
  }

  try {
    const absoluteCommand = path.isAbsolute(command)
      ? command
      : path.resolve(cwd ?? process.cwd(), command);
    return fs.realpathSync(absoluteCommand) === fs.realpathSync(process.execPath);
  } catch {
    return false;
  }
}

function isDirectFilesystemBinary(command: string): boolean {
  const basename = commandBasename(command);
  return [STOCK_FILESYSTEM_BINARY, `${STOCK_FILESYSTEM_BINARY}.cmd`, `${STOCK_FILESYSTEM_BINARY}.exe`]
    .some((candidate) => commandNameMatches(basename, candidate));
}

function looksLikeStockFilesystemToken(token: string): boolean {
  return token === STOCK_FILESYSTEM_PACKAGE ||
    token.startsWith(`${STOCK_FILESYSTEM_PACKAGE}@`) ||
    isDirectFilesystemBinary(token) ||
    token.replaceAll("\\", "/").includes(`/${STOCK_FILESYSTEM_PACKAGE}/`);
}

/** Exact package name, optionally followed by an npm version, tag, or range — never an alias/source. */
function isStockFilesystemPackageSpecifier(specifier: string): boolean {
  if (specifier === STOCK_FILESYSTEM_PACKAGE) return true;
  if (!specifier.startsWith(`${STOCK_FILESYSTEM_PACKAGE}@`)) return false;
  const requestedVersion = specifier.slice(STOCK_FILESYSTEM_PACKAGE.length + 1);
  return requestedVersion.length > 0 && /^[0-9A-Za-z*+._~^<>=|\-\s]+$/.test(requestedVersion);
}

function directoryHasStockFilesystemPackageIdentity(directory: string): boolean {
  const packageJsonPath = path.join(directory, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof parsed === "object" && parsed !== null &&
    "name" in parsed && parsed.name === STOCK_FILESYSTEM_PACKAGE;
}

function isEntrypointInsideStockFilesystemPackage(entrypoint: string, cwd: string | undefined): boolean {
  try {
    const absoluteEntrypoint = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.resolve(cwd ?? process.cwd(), entrypoint);
    const resolvedEntrypoint = fs.realpathSync(absoluteEntrypoint);
    let directory = path.dirname(resolvedEntrypoint);

    // npm installs Windows command shims as real files in node_modules/.bin,
    // rather than the package-pointing symlinks used on POSIX.
    if (commandNameMatches(path.basename(directory), ".bin")) {
      const nodeModulesDirectory = path.dirname(directory);
      if (commandNameMatches(path.basename(nodeModulesDirectory), "node_modules")) {
        const siblingPackageDirectory = path.join(
          nodeModulesDirectory,
          ...STOCK_FILESYSTEM_PACKAGE.split("/"),
        );
        if (directoryHasStockFilesystemPackageIdentity(siblingPackageDirectory)) return true;
      }
    }

    while (true) {
      if (fs.existsSync(path.join(directory, "package.json"))) {
        return directoryHasStockFilesystemPackageIdentity(directory);
      }
      const parent = path.dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  } catch {
    return false;
  }
}

function inspectNpxFilesystemInvocation(args: readonly string[]): FilesystemInvocation {
  let index = 0;
  while (args[index] === "-y" || args[index] === "--yes") index += 1;

  const packageOption = args[index];
  if (packageOption === "--package" || packageOption === "-p" ||
      packageOption?.startsWith("--package=") || packageOption?.startsWith("-p=")) {
    let packageSpecifier: string | undefined;
    if (packageOption === "--package" || packageOption === "-p") {
      packageSpecifier = args[index + 1];
      index += 2;
    } else {
      packageSpecifier = packageOption.slice(packageOption.indexOf("=") + 1);
      index += 1;
    }

    if (!packageSpecifier || !isStockFilesystemPackageSpecifier(packageSpecifier)) {
      return {
        status: packageSpecifier && looksLikeStockFilesystemToken(packageSpecifier) ? "ambiguous" : "other",
        commandKind: "npx",
      };
    }
    if (args[index] !== "--" || !isDirectFilesystemBinary(args[index + 1] ?? "")) {
      return { status: "ambiguous", commandKind: "npx" };
    }
    return { status: "recognized", commandKind: "npx", serverArgStart: index + 2 };
  }

  if (args[index] === "--") index += 1;
  const packageSpecifier = args[index];
  if (packageSpecifier && isStockFilesystemPackageSpecifier(packageSpecifier)) {
    const afterPackage = index + 1;
    return {
      status: "recognized",
      commandKind: "npx",
      serverArgStart: args[afterPackage] === "--" ? afterPackage + 1 : afterPackage,
    };
  }

  return {
    status: args.some(looksLikeStockFilesystemToken) ? "ambiguous" : "other",
    commandKind: "npx",
  };
}

function inspectFilesystemInvocation(config: PackageConfig): FilesystemInvocation {
  const command = config.command ?? "";
  const args = config.args ?? [];

  if (isNpxCommand(command)) return inspectNpxFilesystemInvocation(args);

  if (isDirectFilesystemBinary(command)) {
    const isBareBinary = isBareCommand(command);
    if (isBareBinary || isEntrypointInsideStockFilesystemPackage(command, config.cwd)) {
      return { status: "recognized", commandKind: "stock-filesystem-binary", serverArgStart: 0 };
    }
    return { status: "ambiguous", commandKind: "stock-filesystem-binary" };
  }

  if (isNodeCommand(command, config.cwd)) {
    const entrypointIndex = args[0] === "--" ? 1 : 0;
    const entrypoint = args[entrypointIndex];
    if (entrypoint && isEntrypointInsideStockFilesystemPackage(entrypoint, config.cwd)) {
      return { status: "recognized", commandKind: "node", serverArgStart: entrypointIndex + 1 };
    }
    return {
      status: args.some(looksLikeStockFilesystemToken) ? "ambiguous" : "other",
      commandKind: "node",
    };
  }

  return {
    status: looksLikeStockFilesystemToken(command) || args.some(looksLikeStockFilesystemToken)
      ? "ambiguous"
      : "other",
    commandKind: "other",
  };
}

function isUsableRoot(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\0") && path.isAbsolute(value);
}

function normalizeFilesystemRootForRedaction(root: string): string {
  let normalized = root.trim().replace(/^["']|["']$/g, "").trim();
  normalized = path.normalize(normalized);

  const pathRoot = path.parse(normalized).root;
  if (normalized.length > pathRoot.length) {
    normalized = normalized.replace(/[\\/]+$/, "");
  }
  if (/^[a-z]:/.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

function addFilesystemRootRedactionVariants(redactions: Set<string>, root: string): void {
  for (const candidate of [root, normalizeFilesystemRootForRedaction(root)]) {
    if (candidate.length >= MIN_REDACTABLE_FILESYSTEM_ROOT_LENGTH) {
      redactions.add(candidate);
    }
  }
}

function buildFilesystemRootRedactions(roots: readonly string[]): string[] {
  const redactions = new Set<string>();
  for (const root of roots) {
    // isUsableRoot tests path.isAbsolute on the RAW string, so a root carrying a
    // leading quote or leading whitespace would never reach the normalizer and
    // would pass through a diagnostic verbatim. Offer the normalized form as a
    // candidate too, and accept the root when EITHER shape is usable. Router-
    // supplied roots cannot take those forms — supply and redaction share this
    // gate — so this only widens coverage for directories a user typed. `~` is
    // deliberately not expanded: the child's HOME is not the router's, so any
    // expansion here would be a guess, and guessing is what this design refuses.
    const normalizedRoot = normalizeFilesystemRootForRedaction(root);
    if (!isUsableRoot(root) && !isUsableRoot(normalizedRoot)) continue;

    addFilesystemRootRedactionVariants(redactions, root);
    addFilesystemRootRedactionVariants(redactions, normalizedRoot);
    const absoluteRoot = path.resolve(
      isUsableRoot(root) ? root : normalizedRoot,
    );
    addFilesystemRootRedactionVariants(redactions, absoluteRoot);
    try {
      addFilesystemRootRedactionVariants(redactions, fs.realpathSync(absoluteRoot));
    } catch {
      // A configured root may not exist yet; the supplied and normalized forms
      // remain protected without preventing the child from receiving it.
    }
  }
  return [...redactions].sort((left, right) => right.length - left.length);
}

function diagnosticCommandLabel(command: string | undefined): string {
  const effectiveCommand = command || "echo";
  return commandBasename(effectiveCommand) || "configured executable";
}

/** Parse the roots the host serialises into REBEL_ALLOWED_SYMLINK_ROOTS. */
function parseDeclaredRoots(raw: string | undefined): ParsedDeclaredRoots {
  if (!raw?.trim()) return { roots: [], declaredCount: 0, parseable: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { roots: [], declaredCount: 0, parseable: false };
    }
    return {
      roots: parsed.filter(isUsableRoot),
      declaredCount: parsed.length,
      parseable: true,
    };
  } catch {
    return { roots: [], declaredCount: 0, parseable: false };
  }
}

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
  // Supplied, normalized, and canonical roots known to the stock filesystem
  // invocation, precomputed at spawn for narrow startup-diagnostic redaction.
  private filesystemSensitiveRoots: string[] = [];
  private warnedAboutAmbiguousFilesystemInvocation = false;

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
   * Supply the stock filesystem server the directories it needs, and only then.
   *
   * Rebel already computes both the workspace root and the resolved declared-Space
   * targets for this spawn; the package simply cannot read them from the env, so
   * they are passed as argv, which is the mechanism it does support. A user who
   * specified directories keeps exactly what they wrote — byte-identical, no
   * append, no reorder.
   */
  private resolveFilesystemArgs(
    invocation: FilesystemInvocation,
    workspacePath: string | undefined,
    rebelRootsTrimmed: string | undefined,
  ): string[] {
    const args = this.config.args ?? [];
    this.filesystemSensitiveRoots = [];

    if (invocation.status !== "recognized") {
      if (invocation.status === "ambiguous" && !this.warnedAboutAmbiguousFilesystemInvocation) {
        logger.warn(
          "filesystem connector: invocation not recognised; allowed roots were not supplied",
          {
            package_id: this.packageId,
            command_kind: invocation.commandKind,
            configured_argument_count: args.length,
          },
        );
        this.warnedAboutAmbiguousFilesystemInvocation = true;
      }
      return args;
    }

    const userDirs = args.slice(invocation.serverArgStart);
    if (userDirs.length > 0) {
      logger.info("filesystem connector: using user-specified directories unchanged", {
        package_id: this.packageId,
        user_directory_count: userDirs.length,
      });
      this.filesystemSensitiveRoots = buildFilesystemRootRedactions(userDirs);
      return args;
    }

    const parsedDeclaredRoots = parseDeclaredRoots(rebelRootsTrimmed);
    const workspaceRootCount = workspacePath === undefined ? 0 : 1;
    const usableWorkspaceRoots = isUsableRoot(workspacePath) ? [workspacePath] : [];
    const roots = [...usableWorkspaceRoots, ...parsedDeclaredRoots.roots];
    this.filesystemSensitiveRoots = buildFilesystemRootRedactions(roots);

    const droppedRoot = usableWorkspaceRoots.length !== workspaceRootCount ||
      !parsedDeclaredRoots.parseable ||
      parsedDeclaredRoots.roots.length !== parsedDeclaredRoots.declaredCount;
    if (droppedRoot) {
      logger.warn("filesystem connector: unusable default roots were ignored", {
        package_id: this.packageId,
        declared_root_count: parsedDeclaredRoots.declaredCount,
        usable_declared_root_count: parsedDeclaredRoots.roots.length,
        workspace_root_count: workspaceRootCount,
        usable_workspace_root_count: usableWorkspaceRoots.length,
        declared_roots_parseable: parsedDeclaredRoots.parseable,
      });
    }

    if (roots.length === 0) {
      throw new Error(
        `filesystem connector has no usable allowed directories ` +
        `(workspace ${usableWorkspaceRoots.length}/${workspaceRootCount}, ` +
        `declared ${parsedDeclaredRoots.roots.length}/${parsedDeclaredRoots.declaredCount})`,
      );
    }

    // Count only — the paths carry account and mount names and this log is not private.
    logger.info("filesystem connector: supplying allowed directories at spawn", {
      package_id: this.packageId,
      workspace_root_count: usableWorkspaceRoots.length,
      declared_space_root_count: parsedDeclaredRoots.roots.length,
    });
    return [...args, ...roots];
  }

  private redactFilesystemRoots(value: string | null): string | null {
    if (value === null) return null;
    return this.filesystemSensitiveRoots.reduce(
      (redacted, root) => redacted.split(root).join(REDACTED_FILESYSTEM_ROOT),
      value,
    );
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
    return this.redactFilesystemRoots(lines.join("\n"));
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

    // Declared-Space symlink roots have exactly two consumers. The openai-image
    // connector receives them through MCP_ALLOWED_SYMLINK_ROOTS; a positively
    // identified stock filesystem server receives validated roots through argv.
    // Nothing else receives them because the paths carry account/mount names.
    // The host serialises the roots into REBEL_ALLOWED_SYMLINK_ROOTS at
    // super-mcp spawn (same seam as REBEL_WORKSPACE_PATH). See
    // docs/plans/260724_openai-image-fence-timeout/PLAN.md Stage 4 (2).
    //
    // The `MCP_` prefix follows the OSS-connector convention noted above —
    // the connector reads `MCP_ALLOWED_SYMLINK_ROOTS`, never the parent
    // `REBEL_` name.
    const rebelRootsTrimmed = process.env.REBEL_ALLOWED_SYMLINK_ROOTS?.trim();
    if (rebelRootsTrimmed && this.config.catalogId === 'openai-image-generation') {
      mergedEnv = { ...(mergedEnv ?? {}), MCP_ALLOWED_SYMLINK_ROOTS: rebelRootsTrimmed };
    }

    const filesystemInvocation = inspectFilesystemInvocation(this.config);
    const commandLabel = diagnosticCommandLabel(this.config.command);

    logger.info("Connecting to stdio MCP", {
      package_id: this.packageId,
      command: commandLabel,
      command_kind: filesystemInvocation.commandKind,
      configured_argument_count: this.config.args?.length ?? 0,
      filesystem_identity: filesystemInvocation.status,
      filesystem_package: filesystemInvocation.status === "recognized"
        ? STOCK_FILESYSTEM_PACKAGE
        : undefined,
      workspace: workspacePath ? 'set' : 'unset',
      // Boolean only — never log the raw roots value (carries account/mount names).
      allowed_symlink_roots: rebelRootsTrimmed ? 'set' : 'unset',
    });

    logger.debug("stdio subprocess workspace env (debug only)", {
      package_id: this.packageId,
      workspace_path_set: Boolean(workspacePath),
      // Boolean only — values are sensitive (see SENSITIVE_ENV_KEY_EXACT).
      allowed_symlink_roots_set: Boolean(rebelRootsTrimmed),
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
      const spawnArgs = this.resolveFilesystemArgs(
        filesystemInvocation,
        workspacePath,
        rebelRootsTrimmed,
      );
      this.transport = new StdioClientTransport({
        command: this.config.command || "echo",
        args: spawnArgs,
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
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = this.redactFilesystemRoots(rawErrorMessage) ?? "Unknown connection error";

      // Per-call diagnostics (B1): give the next investigator enough to tell a
      // fresh-child death (stderr present, spawn observed) from a reused/closed
      // transport that fast-failed without a real spawn this call (no stderr).
      const stderrTail = this.getStderrTail();
      const childExitObserved = this.childClosedThisCall;
      const spawnObserved = this.spawnObservedThisCall;
      const spawnErrorMessage = this.redactFilesystemRoots(this.spawnErrorMessage);

      logger.error("Failed to connect to stdio MCP", {
        package_id: this.packageId,
        command: commandLabel,
        command_kind: filesystemInvocation.commandKind,
        configured_argument_count: this.config.args?.length ?? 0,
        filesystem_identity: filesystemInvocation.status,
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
        diagnosticMessage += `\n❌ Command not found: '${commandLabel}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Install or repair the configured MCP server`;
        diagnosticMessage += `\n  2. If using npx, ensure Node.js is installed`;
        diagnosticMessage += `\n  3. Check if the command path is correct`;
        if (filesystemInvocation.status === "recognized" &&
            filesystemInvocation.commandKind === "npx") {
          diagnosticMessage += `\n  4. Try installing the package: npm install -g ${STOCK_FILESYSTEM_PACKAGE}`;
        }
      } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission")) {
        diagnosticMessage += `\n❌ Permission denied for command: '${commandLabel}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Check the configured executable's file permissions`;
        diagnosticMessage += `\n  2. Ensure you have execute permissions`;
      } else if (errorMessage.includes("spawn")) {
        diagnosticMessage += `\n❌ Failed to spawn process`;
        diagnosticMessage += `\nCommand: ${commandLabel}`;
        diagnosticMessage += `\nCommand type: ${filesystemInvocation.commandKind}`;
        diagnosticMessage += `\nConfigured argument count: ${this.config.args?.length ?? 0}`;
        diagnosticMessage += `\nWorking directory configured: ${this.config.cwd ? "yes" : "no"}`;
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

    // Defensive: ensure args is an object before forwarding to the MCP SDK.
    // Some callers may pass a JSON string instead of a parsed object.
    let resolvedArgs = args;
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          resolvedArgs = parsed;
          logger.info("Coerced args from JSON string to object in callTool", {
            package_id: this.packageId,
            tool_name: name,
          });
        }
      } catch {
        // Not valid JSON — pass through and let the child server reject it
      }
    }

    logger.info("Calling tool on stdio MCP", {
      package_id: this.packageId,
      tool_name: name,
      args_keys: typeof resolvedArgs === "object" && resolvedArgs ? Object.keys(resolvedArgs) : [],
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.callTool({
          name,
          arguments: resolvedArgs || {},
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
