import crypto from "node:crypto";
import {
  ToolInfo,
  PackageConfig,
  CatalogStatus,
  type TransientConnectFailureClass,
} from "./types.js";
import { PackageRegistry } from "./registry.js";
import { argsSkeleton, summarizePackage, createSchemaHash } from "./summarize.js";
import { getLogger } from "./logging.js";

const logger = getLogger();
const LEGACY_ERROR_RETRY_INTERVAL_MS = 60_000;

/** Detect ECONNREFUSED errors, including Node.js fetch wrappers (.cause) and registry wrappers (.originalError). */
function isConnectionRefusedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes('econnrefused')) return true;
  if ((error as any).code === 'ECONNREFUSED') return true;
  // Node.js fetch wraps socket errors in TypeError('fetch failed') with .cause
  const cause = (error as any).cause;
  if (cause instanceof Error) {
    if (cause.message.toLowerCase().includes('econnrefused')) return true;
    if ((cause as any).code === 'ECONNREFUSED') return true;
  }
  // Registry wraps connection errors with .originalError containing the raw error
  const original = (error as any).originalError;
  if (original) return isConnectionRefusedError(original);
  return false;
}

/** Check whether a URL points to localhost (127.0.0.1 or localhost). */
function isLocalhostUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch { return false; }
}

export interface CachedTool {
  packageId: string;
  tool: any;
  summary?: string;
  argsSkeleton?: any;
  schemaHash: string;
}

interface PackageToolCache {
  packageId: string;
  tools: CachedTool[];
  lastUpdated: number;
  etag: string;
  status: CatalogStatus;
  lastError?: string;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  refreshInFlight: boolean;
  lastGoodAt: number | null;
  generation: number;
  nextAuthProbeAt: number | null;
  failureClass?: TransientConnectFailureClass | "permanent";
  packageIdentity: string;
}

export interface CatalogRetryHint {
  retryAt: number | null;
  retryInMs: number | null;
  schedule: "transient_backoff" | "auth_probe" | "event_driven" | "none";
}

export interface DegradedCatalogPackage {
  packageId: string;
  status: Exclude<CatalogStatus, "ready">;
  lastError?: string;
  retryHint: CatalogRetryHint;
  retainedToolCount: number;
  generation: number;
}

export interface CatalogRefreshRequest {
  forceReconnect?: boolean;
  reason?: "passive" | "explicit" | "authentication" | "restart" | "configuration";
}

export interface CatalogRefreshController extends CatalogRefreshScheduler {
  refreshNow(packageId: string, request?: CatalogRefreshRequest): Promise<void>;
}

export interface CatalogFailureState {
  status: "auth_required" | "setup_incomplete" | "error";
  lastError?: string;
  failureClass?: TransientConnectFailureClass | "permanent";
  nextRetryAt: number | null;
  nextAuthProbeAt: number | null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function packageIdentity(pkg: PackageConfig | undefined, packageId: string): string {
  if (!pkg) return digest({ id: packageId, removed: true });
  return digest({
    id: pkg.id,
    transport: pkg.transport,
    transportType: pkg.transportType,
    command: pkg.command,
    args: pkg.args,
    cwd: pkg.cwd,
    baseUrl: pkg.base_url,
  });
}

/** Read-only, synchronous view of an already-observed catalog snapshot. */
export interface CatalogView {
  countTools(packageId: string): number;
  computePackageEmbeddingHash(packageId: string): string;
  findToolByName(toolId: string): Array<{ packageId: string; toolId: string }>;
  paginate(
    packageId: string,
    pageSize?: number,
    pageToken?: string | null,
  ): { items: CachedTool[]; next: string | null };
  etag(): string;
  getPackageEtag(packageId: string): string;
  getPackageStatus(packageId: string): CatalogStatus | 'unknown';
  getPackageError(packageId: string): string | undefined;
  getRetryHint(packageId: string, now?: number): CatalogRetryHint;
  listDegraded(now?: number): DegradedCatalogPackage[];
  isSnapshotComplete(): boolean;
  getCacheStats(): { packageCount: number; totalTools: number };
  getPackageForResourceUri(uri: string): string | undefined;
  getKnownResourcePrefixes(): string[];
}

/** Package facts required to shape catalog responses without connecting. */
export type CatalogPackageMetadata = Pick<
  PackageConfig,
  'id' | 'name' | 'description' | 'transport' | 'visibility' | 'catalogId'
>;

export interface PackageMetadataView {
  getPackage(packageId: string): CatalogPackageMetadata | undefined;
  getPackages(): CatalogPackageMetadata[];
}

/** Mutation methods are deliberately excluded from CatalogView. */
export interface CatalogWriter {
  refreshPackage(packageId: string): Promise<void>;
  ensurePackageLoaded(packageId: string, request?: CatalogRefreshRequest): Promise<void>;
  clear(): void;
  clearPackage(packageId: string): void;
  registerResourceUris(packageId: string, tools: unknown[]): void;
  clearResourceUrisForPackage(packageId: string): void;
}

/**
 * Queue-only scheduling seam. Implementations append work and return without
 * synchronously entering refresh or connection code.
 */
export interface CatalogRefreshScheduler {
  scheduleRefresh(packageId: string): void;
}

export class Catalog implements CatalogView {
  private cache: Map<string, PackageToolCache> = new Map();
  private registry: PackageRegistry;
  private globalEtag: string = "";
  private resourceUriToPackage: Map<string, string> = new Map();
  private configurationGeneration = 1;
  private refreshController: CatalogRefreshController | null = null;

  constructor(registry: PackageRegistry) {
    this.registry = registry;
    this.updateGlobalEtag();
  }

  private updateGlobalEtag(): void {
    const packages = Array.from(this.cache.values())
      .map((cached) => ({
        packageId: cached.packageId,
        contentEtag: cached.etag,
        status: cached.status,
        lastError: cached.lastError ?? null,
        generation: cached.generation,
      }))
      .sort((left, right) => left.packageId.localeCompare(right.packageId));
    this.globalEtag = digest({
      generation: this.configurationGeneration,
      snapshotComplete: this.isSnapshotComplete(),
      packages,
    });
  }

  setRefreshController(controller: CatalogRefreshController | null): void {
    this.refreshController = controller;
  }

  getConfigurationGeneration(): number {
    return this.configurationGeneration;
  }

  beginRefresh(packageId: string): number {
    const existing = this.cache.get(packageId);
    const generation = this.configurationGeneration;
    if (existing) {
      existing.refreshInFlight = true;
      existing.generation = generation;
      if (existing.status === "connecting") {
        existing.lastUpdated = Date.now();
      }
    } else {
      this.cache.set(packageId, {
        packageId,
        tools: [],
        lastUpdated: Date.now(),
        etag: digest([]),
        status: "connecting",
        lastError: undefined,
        consecutiveFailures: 0,
        nextRetryAt: null,
        refreshInFlight: true,
        lastGoodAt: null,
        generation,
        nextAuthProbeAt: null,
        packageIdentity: packageIdentity(this.registry.getPackage(packageId), packageId),
      });
    }
    this.updateGlobalEtag();
    return generation;
  }

  finishRefreshWithoutChange(packageId: string, generation: number): void {
    const cached = this.cache.get(packageId);
    if (!cached || cached.generation !== generation) return;
    cached.refreshInFlight = false;
    this.updateGlobalEtag();
  }

  commitReady(
    packageId: string,
    tools: unknown[],
    generation: number,
  ): boolean {
    if (generation !== this.configurationGeneration) return false;

    const cachedTools: CachedTool[] = tools.map((toolValue) => {
      const tool = toolValue as Record<string, any>;
      return {
        packageId,
        tool,
        summary: tool.description || `${tool.name} tool`,
        argsSkeleton: argsSkeleton(tool.inputSchema),
        schemaHash: createSchemaHash(tool.inputSchema),
      };
    });
    const now = Date.now();
    const packageEtag = digest(cachedTools);

    this.clearResourceUrisForPackage(packageId);
    this.registerResourceUris(packageId, tools);
    this.cache.set(packageId, {
      packageId,
      tools: cachedTools,
      lastUpdated: now,
      etag: packageEtag,
      status: "ready",
      lastError: undefined,
      consecutiveFailures: 0,
      nextRetryAt: null,
      refreshInFlight: false,
      lastGoodAt: now,
      generation,
      nextAuthProbeAt: null,
      packageIdentity: packageIdentity(this.registry.getPackage(packageId), packageId),
    });
    this.updateGlobalEtag();

    logger.debug("Package catalog refreshed", {
      package_id: packageId,
      tool_count: tools.length,
      etag: packageEtag,
      generation,
    });
    return true;
  }

  commitFailure(
    packageId: string,
    generation: number,
    failure: CatalogFailureState,
  ): boolean {
    if (generation !== this.configurationGeneration) return false;

    const existing = this.cache.get(packageId);
    const retainedTools = existing?.tools ?? [];
    const lastGoodAt = existing?.lastGoodAt ?? null;
    this.cache.set(packageId, {
      packageId,
      tools: retainedTools,
      lastUpdated: Date.now(),
      etag: existing?.etag ?? digest([]),
      status: failure.status,
      lastError: failure.lastError,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      nextRetryAt: failure.nextRetryAt,
      refreshInFlight: false,
      lastGoodAt,
      generation,
      nextAuthProbeAt: failure.nextAuthProbeAt,
      failureClass: failure.failureClass,
      packageIdentity: packageIdentity(this.registry.getPackage(packageId), packageId),
    });
    this.updateGlobalEtag();

    logger.error("Failed to refresh package catalog", {
      package_id: packageId,
      status: failure.status,
      error: failure.lastError,
      retained_tool_count: retainedTools.length,
      generation,
      next_retry_at: failure.nextRetryAt,
      next_auth_probe_at: failure.nextAuthProbeAt,
    });
    return true;
  }

  getConsecutiveFailures(packageId: string): number {
    return this.cache.get(packageId)?.consecutiveFailures ?? 0;
  }

  getRefreshInFlight(packageId: string): boolean {
    return this.cache.get(packageId)?.refreshInFlight ?? false;
  }

  setRetrySchedule(
    packageId: string,
    schedule: { nextRetryAt?: number | null; nextAuthProbeAt?: number | null },
  ): void {
    const cached = this.cache.get(packageId);
    if (!cached) return;
    if (schedule.nextRetryAt !== undefined) cached.nextRetryAt = schedule.nextRetryAt;
    if (schedule.nextAuthProbeAt !== undefined) {
      cached.nextAuthProbeAt = schedule.nextAuthProbeAt;
    }
  }

  async refreshPackage(packageId: string): Promise<void> {
    if (this.refreshController) {
      await this.refreshController.refreshNow(packageId, { reason: "passive" });
      return;
    }

    const generation = this.beginRefresh(packageId);
    const setupStatus = this.registry.getPackage(packageId)?.setupStatus;
    if (setupStatus?.state === "blocked") {
      this.commitFailure(packageId, generation, {
        status: "setup_incomplete",
        lastError: setupStatus.reason,
        failureClass: "permanent",
        nextRetryAt: null,
        nextAuthProbeAt: null,
      });
      return;
    }

    try {
      const client = await this.registry.getClient(packageId);
      const health = await client.healthCheck?.();
      if (health === "needs_auth") {
        this.commitFailure(packageId, generation, {
          status: "auth_required",
          nextRetryAt: null,
          nextAuthProbeAt: null,
        });
        return;
      }
      const tools = await client.listTools();
      this.commitReady(packageId, tools, generation);
    } catch (error) {
      const categorized = this.categorizeError(packageId, error);
      this.commitFailure(packageId, generation, {
        ...categorized,
        nextRetryAt: null,
        nextAuthProbeAt: null,
      });
    }
  }

  async ensurePackageLoaded(
    packageId: string,
    request: CatalogRefreshRequest = { reason: "passive" },
  ): Promise<void> {
    const cached = this.cache.get(packageId);
    if (this.refreshController) {
      const needsRefresh =
        !cached ||
        request.forceReconnect === true ||
        (cached.status !== "ready" && this.isRetryDue(cached, Date.now()));
      if (needsRefresh) {
        await this.refreshController.refreshNow(packageId, request);
      }
      return;
    }

    if (!cached) {
      await this.refreshPackage(packageId);
      return;
    }
    const needsLegacyRetry =
      cached.status !== "ready" &&
      Date.now() - cached.lastUpdated > LEGACY_ERROR_RETRY_INTERVAL_MS;
    if (needsLegacyRetry) await this.refreshPackage(packageId);
  }

  async getPackageTools(packageId: string): Promise<CachedTool[]> {
    await this.ensurePackageLoaded(packageId);
    const cached = this.cache.get(packageId);
    return cached?.status === "ready" ? cached.tools : [];
  }

  countTools(packageId: string): number {
    const cached = this.cache.get(packageId);
    return cached?.status === "ready" ? cached.tools.length : 0;
  }

  computePackageEmbeddingHash(packageId: string): string {
    const cached = this.cache.get(packageId);
    if (!cached || cached.tools.length === 0) {
      return "";
    }

    const packageName = this.registry.getPackage(packageId)?.name || packageId;
    const entries = cached.tools.map((cachedTool) => {
      const schemaProperties =
        cachedTool.tool?.inputSchema &&
        typeof cachedTool.tool.inputSchema === "object" &&
        !Array.isArray(cachedTool.tool.inputSchema) &&
        cachedTool.tool.inputSchema.properties &&
        typeof cachedTool.tool.inputSchema.properties === "object"
          ? cachedTool.tool.inputSchema.properties
          : undefined;

      const paramNames = schemaProperties
        ? Object.keys(schemaProperties).sort().join(",")
        : "";

      return [
        packageId,
        packageName,
        cachedTool.tool?.name || "",
        cachedTool.summary || cachedTool.tool?.description || "",
        paramNames,
      ].join(":");
    }).sort();

    return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
  }

  async getTool(packageId: string, toolId: string): Promise<CachedTool | undefined> {
    await this.ensurePackageLoaded(packageId);
    const cached = this.cache.get(packageId);
    if (cached?.status !== "ready") return undefined;
    return cached.tools.find(t => t.tool.name === toolId);
  }

  async getToolSchema(packageId: string, toolId: string): Promise<any> {
    const tool = await this.getTool(packageId, toolId);
    return tool?.tool.inputSchema;
  }

  /**
   * Search every cached package for a tool registered under the bare name `toolId`.
   *
   * Used by useTool's R5 bare-tool-name resolver: when the agent omits both
   * `package_id` and the `Package__` prefix, super-mcp tries to recover by
   * searching all loaded catalogs. The caller picks the unique match (and
   * emits a telemetry breadcrumb) or surfaces an `AMBIGUOUS_TOOL` error
   * listing every candidate.
   *
   * Only iterates the in-memory cache — does not force-load other packages.
   * Match is exact (case-sensitive) on `tool.name`.
   */
  findToolByName(toolId: string): Array<{ packageId: string; toolId: string }> {
    if (!toolId) return [];
    const matches: Array<{ packageId: string; toolId: string }> = [];
    for (const cached of this.cache.values()) {
      if (cached.status !== "ready") continue;
      for (const t of cached.tools) {
        if (t.tool.name === toolId) {
          matches.push({ packageId: cached.packageId, toolId: t.tool.name });
        }
      }
    }
    return matches;
  }

  paginate(
    packageId: string,
    pageSize: number = 20,
    pageToken?: string | null
  ): { items: CachedTool[]; next: string | null } {
    const cached = this.cache.get(packageId);
    if (!cached || cached.status !== "ready") {
      return { items: [], next: null };
    }

    const tools = cached.tools;
    let startIndex = 0;

    if (pageToken) {
      try {
        const decoded = Buffer.from(pageToken, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        startIndex = parsed.index || 0;
      } catch (error) {
        logger.warn("Invalid page token", {
          package_id: packageId,
          page_token: pageToken,
        });
        startIndex = 0;
      }
    }

    const endIndex = startIndex + pageSize;
    const items = tools.slice(startIndex, endIndex);
    
    let nextToken: string | null = null;
    if (endIndex < tools.length) {
      nextToken = Buffer.from(JSON.stringify({ index: endIndex })).toString('base64');
    }

    return { items, next: nextToken };
  }

  etag(): string {
    return this.globalEtag;
  }

  getPackageEtag(packageId: string): string {
    const cached = this.cache.get(packageId);
    return cached?.etag || "";
  }

  async buildPackageSummary(packageConfig: PackageConfig): Promise<string> {
    try {
      await this.ensurePackageLoaded(packageConfig.id);
      const cached = this.cache.get(packageConfig.id);
      if (cached?.status !== "ready") {
        const retained = Boolean(cached?.tools.length);
        if (cached?.status === "auth_required") {
          return retained
            ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; authentication required)`
            : `${packageConfig.transport} MCP package (authentication required)`;
        }
        if (cached?.status === "setup_incomplete") {
          return retained
            ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; setup incomplete)`
            : `${packageConfig.transport} MCP package (setup incomplete)`;
        }
        if (cached?.status === "error") {
          const reason = cached.lastError ? `: ${cached.lastError}` : "";
          return retained
            ? `${packageConfig.transport} MCP package (degraded — showing last-known-good tools; unavailable${reason})`
            : `${packageConfig.transport} MCP package (unavailable${reason})`;
        }
        return `${packageConfig.transport} MCP package (connecting)`;
      }

      const tools = cached.tools;
      if (tools.length === 0) {
        return `${packageConfig.transport} MCP package (no tools available)`;
      }

      const toolsForSummary = tools.map(ct => ct.tool);
      return summarizePackage(packageConfig, toolsForSummary);
    } catch (error) {
      logger.debug("Failed to build package summary", {
        package_id: packageConfig.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return `${packageConfig.transport} MCP package`;
    }
  }

  async buildToolInfos(
    packageId: string,
    options: {
      summarize?: boolean;
      include_schemas?: boolean;
      include_descriptions?: boolean;
    } = {}
  ): Promise<ToolInfo[]> {
    const tools = await this.getPackageTools(packageId);

    return tools.map(cachedTool => {
      // Add namespace prefix to ensure global uniqueness across all packages
      // This prevents tool name collisions when multiple packages have identically named tools
      const namespacedId = `${packageId}__${cachedTool.tool.name}`;

      return {
        package_id: packageId,
        tool_id: namespacedId,
        name: namespacedId,
        description: options.include_descriptions ? cachedTool.tool.description : undefined,
        summary: options.summarize ? cachedTool.summary : undefined,
        args_skeleton: options.summarize ? cachedTool.argsSkeleton : undefined,
        schema_hash: cachedTool.schemaHash,
        schema: options.include_schemas ? cachedTool.tool.inputSchema : undefined,
        ...(cachedTool.tool?.annotations ? { annotations: cachedTool.tool.annotations } : {}),
      };
    });
  }

  clear(): void {
    logger.debug("Clearing catalog cache");
    this.resourceUriToPackage.clear();
    this.cache.clear();
    this.updateGlobalEtag();
  }

  clearPackage(packageId: string): void {
    logger.debug("Clearing package cache", { package_id: packageId });
    const pkg = this.registry.getPackage(packageId);
    const existing = this.cache.get(packageId);
    const identity = packageIdentity(pkg, packageId);
    if (pkg) {
      const retain = existing !== undefined && existing.packageIdentity === identity;
      if (!retain) this.clearResourceUrisForPackage(packageId);
      this.cache.set(packageId, {
        packageId,
        tools: retain ? existing.tools : [],
        lastUpdated: Date.now(),
        etag: retain ? existing.etag : digest([]),
        status: "connecting",
        lastError: undefined,
        consecutiveFailures: retain ? existing.consecutiveFailures : 0,
        nextRetryAt: null,
        refreshInFlight: false,
        lastGoodAt: retain ? existing.lastGoodAt : null,
        generation: this.configurationGeneration,
        nextAuthProbeAt: null,
        packageIdentity: identity,
      });
    } else {
      this.clearResourceUrisForPackage(packageId);
      this.cache.delete(packageId);
    }
    this.updateGlobalEtag();
  }

  setConfigurationGeneration(
    generation: number,
    changedPackageIds: readonly string[],
  ): void {
    if (generation <= this.configurationGeneration) return;
    const changed = new Set(changedPackageIds);
    const configured = new Set(this.registry.getPackages().map((pkg) => pkg.id));

    for (const [packageId, cached] of this.cache.entries()) {
      if (!configured.has(packageId)) {
        this.clearResourceUrisForPackage(packageId);
        this.cache.delete(packageId);
        continue;
      }
      if (changed.has(packageId)) {
        this.clearResourceUrisForPackage(packageId);
        const pkg = this.registry.getPackage(packageId);
        this.cache.set(packageId, {
          packageId,
          tools: [],
          lastUpdated: Date.now(),
          etag: digest([]),
          status: "connecting",
          lastError: undefined,
          consecutiveFailures: 0,
          nextRetryAt: null,
          refreshInFlight: false,
          lastGoodAt: null,
          generation,
          nextAuthProbeAt: null,
          packageIdentity: packageIdentity(pkg, packageId),
        });
      } else {
        cached.generation = generation;
      }
    }

    this.configurationGeneration = generation;
    this.updateGlobalEtag();
    logger.info("Catalog configuration generation advanced", {
      generation,
      changed_packages: Array.from(changed).sort(),
    });
  }

  reconcileConfiguration(): { generation: number; changedPackageIds: string[] } {
    const configuredPackages = this.registry.getPackages();
    const configuredIds = new Set(configuredPackages.map((pkg) => pkg.id));
    const changedPackageIds = configuredPackages
      .filter((pkg) => {
        const cached = this.cache.get(pkg.id);
        return cached === undefined || cached.packageIdentity !== packageIdentity(pkg, pkg.id);
      })
      .map((pkg) => pkg.id);
    for (const packageId of this.cache.keys()) {
      if (!configuredIds.has(packageId)) changedPackageIds.push(packageId);
    }
    const generation = this.configurationGeneration + 1;
    this.setConfigurationGeneration(generation, changedPackageIds);
    return { generation, changedPackageIds };
  }

  getPackageStatus(packageId: string): CatalogStatus | "unknown" {
    const cached = this.cache.get(packageId);
    return cached?.status ?? "unknown";
  }

  getPackageError(packageId: string): string | undefined {
    return this.cache.get(packageId)?.lastError;
  }

  getRetryHint(packageId: string, now: number = Date.now()): CatalogRetryHint {
    const cached = this.cache.get(packageId);
    if (!cached) {
      return { retryAt: now, retryInMs: 0, schedule: "transient_backoff" };
    }
    if (cached.status === "auth_required") {
      const retryAt = cached.nextAuthProbeAt ?? null;
      return {
        retryAt,
        retryInMs: retryAt === null ? null : Math.max(0, retryAt - now),
        schedule: retryAt === null ? "event_driven" : "auth_probe",
      };
    }
    if (cached.status === "error") {
      const retryAt = cached.nextRetryAt ?? null;
      return {
        retryAt,
        retryInMs: retryAt === null ? null : Math.max(0, retryAt - now),
        schedule: retryAt === null ? "none" : "transient_backoff",
      };
    }
    if (cached.status === "connecting") {
      return {
        retryAt: now,
        retryInMs: 0,
        schedule: "transient_backoff",
      };
    }
    return { retryAt: null, retryInMs: null, schedule: "none" };
  }

  listDegraded(now: number = Date.now()): DegradedCatalogPackage[] {
    return Array.from(this.cache.values())
      .filter((cached): cached is PackageToolCache & {
        status: Exclude<CatalogStatus, "ready">;
      } => cached.status !== "ready")
      .map((cached) => ({
        packageId: cached.packageId,
        status: cached.status,
        lastError: cached.lastError,
        retryHint: this.getRetryHint(cached.packageId, now),
        retainedToolCount: cached.tools.length,
        generation: cached.generation,
      }))
      .sort((left, right) => left.packageId.localeCompare(right.packageId));
  }

  isSnapshotComplete(): boolean {
    return this.registry.getPackages().every((pkg) => {
      const cached = this.cache.get(pkg.id);
      return Boolean(
        cached &&
        cached.generation === this.configurationGeneration &&
        cached.status !== "connecting",
      );
    });
  }

  getCacheStats(): { packageCount: number; totalTools: number } {
    let totalTools = 0;
    for (const cached of this.cache.values()) {
      totalTools += cached.tools.length;
    }

    return {
      packageCount: this.cache.size,
      totalTools,
    };
  }

  categorizeError(packageId: string, error: unknown): {
    status: "auth_required" | "error";
    lastError?: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isAuthError(error)) {
      logger.info("Package requires authentication, retaining last-known-good catalog", {
        package_id: packageId,
      });
      return {
        status: "auth_required",
      };
    }

    // Check for connection refused on localhost URLs (desktop app not running)
    const pkg = this.registry.getPackage(packageId);
    if (pkg && isLocalhostUrl(pkg.base_url) && isConnectionRefusedError(error)) {
      const friendlyMessage = pkg.name
        ? `${pkg.name} isn't running. Open ${pkg.name} on your computer and try again.`
        : "A local app isn't running. Check that the required app is open on your computer and try again.";
      return {
        status: "error",
        lastError: friendlyMessage,
      };
    }

    return {
      status: "error",
      lastError: message,
    };
  }

  private isRetryDue(cached: PackageToolCache, now: number): boolean {
    if (cached.status === "auth_required") {
      return cached.nextAuthProbeAt !== null && cached.nextAuthProbeAt <= now;
    }
    if (cached.status === "error") {
      return cached.nextRetryAt !== null && cached.nextRetryAt <= now;
    }
    return cached.status === "connecting";
  }

  private isAuthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      error.name === "UnauthorizedError" ||
      message.includes("oauth") ||
      message.includes("401") ||
      message.includes("unauthorized") ||
      message.includes("invalid_token") ||
      message.includes("authorization")
    );
  }

  // Resource URI mapping for MCP Apps support

  /**
   * Register resource URIs from tool metadata.
   * Called when loading tools for a package to build the uri -> package mapping.
   */
  registerResourceUris(packageId: string, tools: unknown[]): void {
    for (const toolValue of tools) {
      const tool = toolValue as { _meta?: { ui?: { resourceUri?: unknown } } };
      const resourceUri = tool._meta?.ui?.resourceUri;
      if (resourceUri && typeof resourceUri === "string") {
        const prefix = this.extractUriPrefix(resourceUri);
        if (prefix) {
          this.resourceUriToPackage.set(prefix, packageId);
          logger.debug("Registered resource URI prefix", {
            package_id: packageId,
            prefix,
            full_uri: resourceUri,
          });
        }
      }
    }
  }

  /**
   * Look up which package owns a resource URI.
   * Returns the package ID if found in the mapping, undefined otherwise.
   */
  getPackageForResourceUri(uri: string): string | undefined {
    const prefix = this.extractUriPrefix(uri);
    if (!prefix) return undefined;
    
    const packageId = this.resourceUriToPackage.get(prefix);
    const cached = packageId ? this.cache.get(packageId) : undefined;
    if (
      cached &&
      (cached.status !== "ready" || cached.generation !== this.configurationGeneration)
    ) {
      return undefined;
    }
    if (packageId) {
      logger.debug("Found package for resource URI", {
        uri,
        prefix,
        package_id: packageId,
      });
    }
    return packageId;
  }

  /**
   * Get all known resource URI prefixes for error messages.
   */
  getKnownResourcePrefixes(): string[] {
    return Array.from(this.resourceUriToPackage.entries())
      .filter(([, packageId]) => {
        const cached = this.cache.get(packageId);
        return !cached || (
          cached.status === "ready" &&
          cached.generation === this.configurationGeneration
        );
      })
      .map(([prefix]) => prefix);
  }

  /**
   * Clear resource URI mappings for a specific package.
   * Called when a package is restarted or removed.
   */
  clearResourceUrisForPackage(packageId: string): void {
    for (const [prefix, pkgId] of this.resourceUriToPackage.entries()) {
      if (pkgId === packageId) {
        this.resourceUriToPackage.delete(prefix);
        logger.debug("Cleared resource URI prefix", { package_id: packageId, prefix });
      }
    }
  }

  /**
   * Extract the URI prefix (scheme + authority) from a resource URI.
   * e.g., "ui://viewer/app.html" -> "ui://viewer"
   */
  private extractUriPrefix(uri: string): string | null {
    try {
      // Handle ui:// scheme URIs
      const match = uri.match(/^(ui:\/\/[^/]+)/);
      if (match) {
        return match[1];
      }
      // Handle other schemes (file://, etc.)
      const url = new URL(uri);
      return `${url.protocol}//${url.host}`;
    } catch {
      // Invalid URI
      return null;
    }
  }
}
