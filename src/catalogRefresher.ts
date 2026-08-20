import {
  Catalog,
  type CatalogFailureState,
  type CatalogRefreshRequest,
} from "./catalog.js";
import {
  PackageRegistry,
  type RegistryLifecycleEvent,
} from "./registry.js";
import {
  type ConnectOutcome,
  type TransientConnectFailureClass,
} from "./types.js";
import { getLogger } from "./logging.js";

const logger = getLogger();

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_REFRESH_TIMEOUT_MS = 65_000;
const DEFAULT_AUTH_PROBE_INTERVAL_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 300_000, 1_800_000] as const;
const RETRY_JITTER_FRACTION = 0.2;

export const TRANSIENT_CONNECT_FAILURE_CLASSES = [
  "timeout",
  "connection_refused",
  "connection_reset",
  "transport_error",
  "unknown",
] as const satisfies readonly TransientConnectFailureClass[];

export function calculateRetryDelayMs(input: {
  failureClass: TransientConnectFailureClass;
  consecutiveFailures: number;
  random: () => number;
}): number {
  const failureIndex = Math.max(0, input.consecutiveFailures - 1);
  const baseDelay = RETRY_DELAYS_MS[Math.min(failureIndex, RETRY_DELAYS_MS.length - 1)];
  const normalizedRandom = Math.min(1, Math.max(0, input.random()));
  const jitterMultiplier = 1 - RETRY_JITTER_FRACTION +
    normalizedRandom * RETRY_JITTER_FRACTION * 2;
  return Math.round(baseDelay * jitterMultiplier);
}

function envNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn("Invalid catalog refresher environment value; using default", {
      env_name: name,
      value: raw,
      default_ms: fallback,
    });
    return fallback;
  }
  return parsed;
}

function timeoutError(timeoutMs: number): Error & { code: "ETIMEDOUT" } {
  return Object.assign(
    new Error(`Catalog refresh timed out after ${timeoutMs}ms`),
    { code: "ETIMEDOUT" as const },
  );
}

function classifyTransientFailure(error: unknown): TransientConnectFailureClass {
  const code = error instanceof Error
    ? (error as Error & { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (code === "ETIMEDOUT" || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (code === "ECONNREFUSED" || message.includes("econnrefused") || message.includes("connection refused")) {
    return "connection_refused";
  }
  if (code === "ECONNRESET" || message.includes("econnreset") || message.includes("connection reset")) {
    return "connection_reset";
  }
  return error instanceof Error ? "transport_error" : "unknown";
}

interface QueuedRefresh {
  forceReconnect: boolean;
  reason: NonNullable<CatalogRefreshRequest["reason"]> | "half_open" | "registry" | "startup";
  waiters: Array<() => void>;
}

interface InFlightRefresh {
  promise: Promise<void>;
  forceReconnect: boolean;
}

interface CatalogRegistrySeam {
  connectForCatalog?(
    packageId: string,
    options?: { forceReconnect?: boolean },
  ): Promise<ConnectOutcome>;
  subscribeLifecycle?(
    listener: (event: RegistryLifecycleEvent) => void,
  ): () => void;
}

export interface CatalogRefresherOptions {
  concurrency?: number;
  refreshTimeoutMs?: number;
  authProbeIntervalMs?: number;
  now?: () => number;
  random?: () => number;
}

export class CatalogRefresher {
  private readonly catalog: Catalog;
  private readonly registry: PackageRegistry;
  private readonly concurrency: number;
  private readonly refreshTimeoutMs: number;
  private readonly authProbeIntervalMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly queue = new Map<string, QueuedRefresh>();
  private readonly inFlight = new Map<string, InFlightRefresh>();
  private activeCount = 0;
  private started = false;
  private disposed = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  private disposeAttempts = new Set<() => void>();
  private readinessGeneration: number;
  private readinessPromise: Promise<void>;
  private resolveReadiness: () => void = () => undefined;
  private readinessResolved = false;

  constructor(
    catalog: Catalog,
    registry: PackageRegistry,
    options: CatalogRefresherOptions = {},
  ) {
    this.catalog = catalog;
    this.registry = registry;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.refreshTimeoutMs = Math.max(1, Math.floor(
      options.refreshTimeoutMs ??
      envNonNegativeInteger("SUPER_MCP_CATALOG_REFRESH_TIMEOUT_MS", DEFAULT_REFRESH_TIMEOUT_MS),
    ));
    this.authProbeIntervalMs = Math.max(0, Math.floor(
      options.authProbeIntervalMs ??
      envNonNegativeInteger("SUPER_MCP_AUTH_PROBE_INTERVAL_MS", DEFAULT_AUTH_PROBE_INTERVAL_MS),
    ));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.readinessGeneration = catalog.getConfigurationGeneration();
    this.readinessPromise = this.createReadinessPromise();
    catalog.setRefreshController(this);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    const registrySeam = this.registry as PackageRegistry & CatalogRegistrySeam;
    this.unsubscribeRegistry = registrySeam.subscribeLifecycle?.((event) => {
      this.handleRegistryEvent(event);
    }) ?? null;

    for (const pkg of this.registry.getPackages()) {
      const status = this.catalog.getPackageStatus(pkg.id);
      if (status === "auth_required") {
        this.ensureAuthProbeScheduled(pkg.id);
      } else if (status !== "ready") {
        this.enqueue(pkg.id, { forceReconnect: false, reason: "startup" });
      }
    }
    this.drainQueue();
    this.armWakeTimer();
    this.updateReadiness();

    logger.info("Catalog refresher started", {
      package_count: this.registry.getPackages().length,
      concurrency: this.concurrency,
      refresh_timeout_ms: this.refreshTimeoutMs,
      auth_probe_interval_ms: this.authProbeIntervalMs,
    });
  }

  scheduleRefresh(packageId: string): void {
    if (this.disposed) return;
    const refresh = this.getDueRefresh(packageId);
    if (!refresh) {
      this.armWakeTimer();
      return;
    }
    this.enqueue(packageId, refresh);
    this.drainQueue();
  }

  refreshNow(
    packageId: string,
    request: CatalogRefreshRequest = { reason: "passive" },
  ): Promise<void> {
    if (this.disposed || !this.registry.getPackage(packageId)) return Promise.resolve();
    const forceByIntent = request.reason === "authentication" ||
      request.reason === "restart" ||
      request.reason === "configuration";
    const forceReconnect = request.forceReconnect === true || forceByIntent;
    const running = this.inFlight.get(packageId);
    if (running) {
      if (!forceReconnect || running.forceReconnect) return running.promise;
      return this.enqueueAndWait(packageId, {
        forceReconnect: true,
        reason: request.reason ?? "explicit",
      });
    }

    const refresh = forceReconnect
      ? {
          forceReconnect: true,
          reason: request.reason ?? "explicit",
        }
      : this.getDueRefresh(packageId, request.reason ?? "passive");
    if (!refresh) return Promise.resolve();
    return this.enqueueAndWait(packageId, refresh);
  }

  notify(
    packageId: string,
    reason: "authentication" | "configuration" | "restart" | "explicit" | "registry",
  ): void {
    if (this.disposed || !this.registry.getPackage(packageId)) return;
    if (reason === "configuration") {
      this.configurationChanged();
      return;
    }
    const forceReconnect = reason !== "registry";
    const running = this.inFlight.get(packageId);
    if (running && (!forceReconnect || running.forceReconnect)) return;
    this.enqueue(packageId, { forceReconnect, reason });
    this.drainQueue();
  }

  configurationChanged(): void {
    if (this.disposed) return;
    const interruptedPackageIds = new Set(this.inFlight.keys());
    for (const pkg of this.registry.getPackages()) {
      if (this.catalog.getPackageStatus(pkg.id) === "connecting") {
        interruptedPackageIds.add(pkg.id);
      }
    }
    const { changedPackageIds } = this.catalog.reconcileConfiguration();
    this.resetReadinessForCurrentGeneration();
    const changed = new Set(changedPackageIds);
    for (const packageId of [...changed, ...interruptedPackageIds]) {
      if (this.registry.getPackage(packageId)) {
        this.enqueue(packageId, {
          forceReconnect: changed.has(packageId),
          reason: "configuration",
        });
      }
    }
    this.drainQueue();
    this.updateReadiness();
  }

  async whenCurrentGenerationReady(): Promise<void> {
    while (!this.disposed) {
      this.updateReadiness();
      const generation = this.readinessGeneration;
      const readiness = this.readinessPromise;
      await readiness;
      if (
        generation === this.catalog.getConfigurationGeneration() &&
        this.catalog.isSnapshotComplete()
      ) {
        return;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.catalog.setRefreshController(null);
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    for (const refresh of this.queue.values()) {
      for (const resolve of refresh.waiters) resolve();
    }
    this.queue.clear();
    for (const disposeAttempt of this.disposeAttempts) disposeAttempt();
    this.disposeAttempts.clear();
    this.resolveReadiness();
    logger.info("Catalog refresher disposed", {
      refreshes_in_flight: this.inFlight.size,
    });
  }

  private enqueue(
    packageId: string,
    refresh: Omit<QueuedRefresh, "waiters">,
    waiter?: () => void,
  ): void {
    if (this.disposed || !this.registry.getPackage(packageId)) return;
    const queued = this.queue.get(packageId);
    this.queue.set(packageId, {
      forceReconnect: Boolean(queued?.forceReconnect || refresh.forceReconnect),
      reason: refresh.forceReconnect || !queued ? refresh.reason : queued.reason,
      waiters: [...(queued?.waiters ?? []), ...(waiter ? [waiter] : [])],
    });
  }

  private enqueueAndWait(
    packageId: string,
    refresh: Omit<QueuedRefresh, "waiters">,
  ): Promise<void> {
    const promise = new Promise<void>((resolve) => {
      this.enqueue(packageId, refresh, resolve);
    });
    this.drainQueue();
    return promise;
  }

  private getDueRefresh(
    packageId: string,
    reason: NonNullable<CatalogRefreshRequest["reason"]> = "passive",
  ): Omit<QueuedRefresh, "waiters"> | null {
    const status = this.catalog.getPackageStatus(packageId);
    if (status === "ready") return null;
    if (status === "auth_required") this.ensureAuthProbeScheduled(packageId);

    const now = this.now();
    const retryHint = this.catalog.getRetryHint(packageId, now);
    if (retryHint.retryAt === null || retryHint.retryAt > now) return null;
    return {
      forceReconnect: status === "auth_required",
      reason: status === "auth_required" ? "half_open" : reason,
    };
  }

  private drainQueue(): void {
    if (!this.started || this.disposed) return;
    while (this.activeCount < this.concurrency && this.queue.size > 0) {
      const next = Array.from(this.queue.entries()).find(
        ([packageId]) => !this.inFlight.has(packageId),
      );
      if (!next) break;
      const [packageId, refresh] = next;
      this.queue.delete(packageId);

      this.activeCount += 1;
      const refreshPromise = Promise.resolve()
        .then(() => this.runRefresh(packageId, refresh))
        .catch((error: unknown) => {
          logger.error("Unexpected catalog refresher failure", {
            package_id: packageId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.activeCount -= 1;
          this.inFlight.delete(packageId);
          for (const resolve of refresh.waiters) resolve();
          this.updateReadiness();
          this.armWakeTimer();
          this.drainQueue();
        });
      this.inFlight.set(packageId, {
        promise: refreshPromise,
        forceReconnect: refresh.forceReconnect,
      });
    }
  }

  private async runRefresh(packageId: string, refresh: QueuedRefresh): Promise<void> {
    const generation = this.catalog.beginRefresh(packageId, refresh.reason);
    let attemptActive = true;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let disposeAttempt: (() => void) | null = null;

    const operation = this.performRefresh(packageId, refresh, generation, () =>
      attemptActive && !this.disposed && generation === this.catalog.getConfigurationGeneration());
    operation.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError(this.refreshTimeoutMs)), this.refreshTimeoutMs);
    });
    const disposed = new Promise<never>((_, reject) => {
      disposeAttempt = () => reject(new Error("Catalog refresher disposed"));
      this.disposeAttempts.add(disposeAttempt);
    });

    try {
      await Promise.race([operation, timeout, disposed]);
    } catch (error) {
      attemptActive = false;
      if (this.disposed) {
        this.catalog.finishRefreshWithoutChange(packageId, generation);
        return;
      }
      if ((error as { code?: unknown } | null)?.code === "ETIMEDOUT") {
        const registryWithEviction = this.registry as PackageRegistry & {
          evictClient?: (
            packageId: string,
            reason: "unhealthy",
          ) => Promise<void>;
        };
        await registryWithEviction.evictClient?.(packageId, "unhealthy");
      }
      this.recordTransientFailure(packageId, generation, error);
    } finally {
      attemptActive = false;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (disposeAttempt) this.disposeAttempts.delete(disposeAttempt);
      this.catalog.finishRefreshWithoutChange(packageId, generation);
    }
  }

  private async performRefresh(
    packageId: string,
    refresh: QueuedRefresh,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const outcome = await this.connect(packageId, refresh.forceReconnect);
    if (!isCurrent()) return;

    if (outcome.kind === "connected") {
      const tools = await outcome.client.listTools();
      if (isCurrent()) this.catalog.commitReady(packageId, tools, generation);
      return;
    }
    if (outcome.kind === "auth_required") {
      this.catalog.commitFailure(packageId, generation, {
        status: "auth_required",
        lastError: undefined,
        failureClass: "auth_required",
        nextRetryAt: null,
        nextAuthProbeAt: this.authProbeIntervalMs === 0
          ? null
          : this.now() + this.authProbeIntervalMs,
      });
      return;
    }
    if (outcome.kind === "setup_incomplete") {
      this.catalog.commitFailure(packageId, generation, {
        status: "setup_incomplete",
        lastError: outcome.reason,
        failureClass: "setup_incomplete",
        nextRetryAt: null,
        nextAuthProbeAt: null,
      });
      return;
    }
    if (outcome.kind === "permanent_failure") {
      const categorized = this.catalog.categorizeError(packageId, outcome.error);
      this.catalog.commitFailure(packageId, generation, {
        status: categorized.status,
        lastError: categorized.lastError,
        failureClass: outcome.failureClass,
        nextRetryAt: null,
        nextAuthProbeAt: null,
      });
      return;
    }
    this.recordTransientFailure(
      packageId,
      generation,
      outcome.error,
      outcome.failureClass,
    );
  }

  private async connect(packageId: string, forceReconnect: boolean): Promise<ConnectOutcome> {
    const seam = this.registry as PackageRegistry & CatalogRegistrySeam;
    if (seam.connectForCatalog) {
      return seam.connectForCatalog(packageId, { forceReconnect });
    }

    const setupStatus = this.registry.getPackage(packageId)?.setupStatus;
    if (setupStatus?.state === "blocked") {
      return { kind: "setup_incomplete", reason: setupStatus.reason };
    }
    try {
      const client = await this.registry.getClient(packageId);
      const health = await client.healthCheck?.();
      if (health === "needs_auth") {
        return {
          kind: "auth_required",
          client,
          error: new Error("Authentication required"),
        };
      }
      if (health === "error") {
        return {
          kind: "transient_failure",
          failureClass: "transport_error",
          error: new Error("MCP client health check failed"),
        };
      }
      return { kind: "connected", client };
    } catch (error) {
      return {
        kind: "transient_failure",
        failureClass: classifyTransientFailure(error),
        error,
      };
    }
  }

  private recordTransientFailure(
    packageId: string,
    generation: number,
    error: unknown,
    failureClass: TransientConnectFailureClass = classifyTransientFailure(error),
  ): void {
    const categorized = this.catalog.categorizeError(packageId, error);
    if (categorized.status === "auth_required") {
      this.catalog.commitFailure(packageId, generation, {
        status: "auth_required",
        lastError: categorized.lastError,
        failureClass: "auth_required",
        nextRetryAt: null,
        nextAuthProbeAt: this.authProbeIntervalMs === 0
          ? null
          : this.now() + this.authProbeIntervalMs,
      });
      return;
    }
    const consecutiveFailures = this.catalog.getConsecutiveFailures(packageId) + 1;
    const delay = calculateRetryDelayMs({
      failureClass,
      consecutiveFailures,
      random: this.random,
    });
    const failure: CatalogFailureState = {
      status: "error",
      lastError: categorized.lastError,
      failureClass,
      nextRetryAt: this.now() + delay,
      nextAuthProbeAt: null,
    };
    this.catalog.commitFailure(packageId, generation, failure);
  }

  private ensureAuthProbeScheduled(packageId: string): void {
    if (this.authProbeIntervalMs === 0) {
      this.catalog.setRetrySchedule(packageId, { nextAuthProbeAt: null });
      return;
    }
    const hint = this.catalog.getRetryHint(packageId, this.now());
    if (hint.retryAt === null) {
      this.catalog.setRetrySchedule(packageId, {
        nextRetryAt: null,
        nextAuthProbeAt: this.now() + this.authProbeIntervalMs,
      });
    }
  }

  private armWakeTimer(): void {
    if (!this.started || this.disposed) return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    const now = this.now();
    let nextWakeAt: number | null = null;
    for (const pkg of this.registry.getPackages()) {
      if (this.inFlight.has(pkg.id) || this.queue.has(pkg.id)) continue;
      const hint = this.catalog.getRetryHint(pkg.id, now);
      if (hint.retryAt === null) continue;
      if (nextWakeAt === null || hint.retryAt < nextWakeAt) nextWakeAt = hint.retryAt;
    }
    if (nextWakeAt === null) return;

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.enqueueDueRefreshes();
    }, Math.max(0, nextWakeAt - now));
    this.wakeTimer.unref?.();
  }

  private enqueueDueRefreshes(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const pkg of this.registry.getPackages()) {
      if (this.inFlight.has(pkg.id) || this.queue.has(pkg.id)) continue;
      const status = this.catalog.getPackageStatus(pkg.id);
      const hint = this.catalog.getRetryHint(pkg.id, now);
      if (hint.retryAt === null || hint.retryAt > now) continue;
      this.enqueue(pkg.id, {
        forceReconnect: status === "auth_required",
        reason: status === "auth_required" ? "half_open" : "passive",
      });
    }
    this.drainQueue();
    this.armWakeTimer();
  }

  private handleRegistryEvent(event: RegistryLifecycleEvent): void {
    if (this.inFlight.has(event.packageId)) return;
    if (event.type === "auth_outcome" && event.outcome !== "authenticated") return;
    if (
      event.type === "client_evicted" &&
      (event.reason === "idle" || event.reason === "restart" || event.reason === "shutdown")
    ) return;
    this.notify(event.packageId, "registry");
  }

  private createReadinessPromise(): Promise<void> {
    this.readinessResolved = false;
    return new Promise<void>((resolve) => {
      this.resolveReadiness = () => {
        if (this.readinessResolved) return;
        this.readinessResolved = true;
        resolve();
      };
    });
  }

  private resetReadinessForCurrentGeneration(): void {
    const generation = this.catalog.getConfigurationGeneration();
    if (generation === this.readinessGeneration) return;
    this.resolveReadiness();
    this.readinessGeneration = generation;
    this.readinessPromise = this.createReadinessPromise();
  }

  private updateReadiness(): void {
    this.resetReadinessForCurrentGeneration();
    if (this.catalog.isSnapshotComplete()) {
      this.resolveReadiness();
    } else if (this.readinessResolved) {
      this.readinessPromise = this.createReadinessPromise();
    }
  }
}
