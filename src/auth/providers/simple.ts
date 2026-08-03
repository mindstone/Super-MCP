import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../../logging.js";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import {
  buildRedirectUriRejectedError,
  isAuthorizeProbeDisabled,
  probeAuthorizeUrl,
  type AuthorizeProbeVerdict,
} from "../authorizeProbe.js";

const logger = getLogger();
const OAUTH_TOKEN_DIR_ENV = "SUPER_MCP_OAUTH_TOKEN_DIR";

function getOAuthTokenStoragePath(): string {
  return process.env[OAUTH_TOKEN_DIR_ENV] || path.join(homedir(), ".super-mcp", "oauth-tokens");
}

/**
 * Internal bookkeeping field stamped onto persisted token sets so a concurrent
 * peer can decide whether the on-disk access_token is still valid (and thus a
 * refresh can be short-circuited) without an extra network round-trip. Epoch ms
 * of the moment the access_token was persisted. Stripped from the value the SDK
 * sees (it lives only on disk + the in-memory mirror) — the SDK's
 * OAuthTokensSchema `.strip()`s unknown fields anyway, but we keep it private.
 */
export const OBTAINED_AT_FIELD = "__superMcpObtainedAtMs";

/**
 * Strip the private obtained-at bookkeeping stamp from a persisted token set
 * before handing it to the SDK. The provider keeps this field on disk + its
 * in-memory mirror only; the SDK's OAuthTokensSchema would strip it anyway, but
 * we never want to leak our private field across the boundary. Canonical, shared
 * implementation (also consumed by the refresh transaction).
 */
export function stripObtainedAtStamp(tokens: any): any {
  if (!tokens || typeof tokens !== "object") {
    return tokens;
  }
  const { [OBTAINED_AT_FIELD]: _omit, ...rest } = tokens;
  return rest;
}

/**
 * Upper bound on the in-memory queue of recent authoritative token-echo identities
 * (F1). In practice at most one or two authoritative persists are outstanding
 * before their SDK echoes are consumed; this cap is a safety valve so a pathological
 * burst of refreshes whose echoes never arrive cannot grow the queue without limit.
 *
 * Sized comfortably above the maximum number of refreshes that can realistically be
 * outstanding at once: a single HttpMcpClient serialises its OAuth operations at a
 * concurrency of 5 (see `src/clients/httpClient.ts`), so at most ~5 same-provider
 * authoritative persists can be in flight before their SDK echoes land. 8 leaves
 * headroom. If that ceiling ever rises above this cap, the oldest still-pending echo
 * would be evicted and the stale-echo downgrade class (F1) could silently return —
 * so `recordAuthoritativeEcho()` emits a WARN on any eviction to make a future
 * regression observable rather than silent.
 */
const MAX_AUTHORITATIVE_ECHOES = 8;

/**
 * Loopback host spellings treated as equivalent for OAuth redirect URIs
 * (RFC 8252 §7.3): a vendor echoing `127.0.0.1` where we sent `localhost`
 * must not look like a different registration. Node's URL keeps the brackets
 * on IPv6 literals (`[::1]`).
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Normalize a redirect URI for staleness comparison: loopback host spellings
 * (localhost ≡ 127.0.0.1 ≡ [::1]) fold to a single token so spelling variants
 * don't per-launch-invalidate a healthy registration. Returns undefined when
 * the URI is unparseable.
 */
function normalizeRedirectUriForCompare(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  const host = isLoopbackHostname(url.hostname) ? "loopback" : url.hostname.toLowerCase();
  const port =
    url.port ||
    (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return `${url.protocol}//${host}:${port}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Simple OAuth provider that opens browser for authorization
 */
export interface StaticOAuthCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthErrorSummary {
  error: string;
  error_description?: string;
}

export class SimpleOAuthProvider implements OAuthClientProvider {
  private packageId: string;
  private savedTokens?: any;
  /**
   * A bounded queue of the {access_token, refresh_token} identities our recent
   * authoritative (in-lock) persists wrote, recorded in-memory after each
   * successful write. Used by the tolerant public `saveTokens()` to recognise the
   * SDK's unavoidable second save — which echoes back the tokens the transaction
   * just persisted — so it can skip ONLY a true redundant re-write or a stale
   * echo of a now-superseded token, and never clobber a NEWER on-disk token a
   * concurrent peer (or our own later authoritative refresh) rotated in the
   * interim.
   *
   * A SINGLE slot was insufficient (F1): two same-process sequential authoritative
   * refreshes (persist v1, then persist v2) followed by a delayed SDK echo of v1
   * would find the slot holding v2, fail to recognise v1 as a stale echo, and
   * write v1 back over v2 (a downgrade). Tracking a bounded set of recent
   * authoritative identities lets `shouldSkipNonAuthoritativeWrite()` match an
   * incoming echo against ANY still-pending authoritative write. Bounded so it
   * cannot grow unbounded; oldest entries are evicted, and an entry is consumed
   * (dropped) once its echo lands. Cleared on invalidation.
   */
  private authoritativeTokenEchoes: Array<{ access_token?: string; refresh_token?: string }> = [];
  private codeVerifierValue?: string;
  private savedClientInfo?: any;
  private tokenStoragePath: string;
  private oauthPort: number;
  private stateValue?: string;
  private staticCredentials?: StaticOAuthCredentials;
  private redirectStarted: boolean = false;
  private lastOAuthError?: OAuthErrorSummary;
  /**
   * Out-of-band channel for the authorize pre-flight probe verdict (REBEL-7F9
   * Stage 3, recall#2 F2(a)). DISTINCT from lastOAuthError: that slot is
   * consume-once and gets drained by invalidateCredentials(), which the retry
   * loop itself calls on a classified rejection — a verdict stored there would
   * be consumed before classification and the flow would fall through to a
   * generic auth_required. This channel survives invalidation.
   */
  private lastProbeVerdict?: AuthorizeProbeVerdict;
  /**
   * When true, redirectToAuthorization skips the pre-flight probe. Set by the
   * authenticate handler on saved-port reuse WITH a prior successful token
   * exchange (confirm#F6), and for the browser-open floor attempt (recall#2
   * F1(b)) where the probe's uniform-rejection verdict is already known and
   * the browser must open anyway.
   */
  private skipAuthorizeProbe: boolean = false;
  
  constructor(packageId: string, oauthPort: number = 5173, staticCredentials?: StaticOAuthCredentials) {
    this.packageId = packageId;
    this.oauthPort = oauthPort;
    this.tokenStoragePath = getOAuthTokenStoragePath();
    this.staticCredentials = staticCredentials;
    
    // Pre-populate client info from static credentials (skips DCR)
    if (staticCredentials) {
      this.savedClientInfo = {
        client_id: staticCredentials.clientId,
        ...(staticCredentials.clientSecret && { client_secret: staticCredentials.clientSecret }),
        redirect_uris: [`http://localhost:${oauthPort}/oauth/callback`],
      };
      logger.info("Using pre-registered OAuth client credentials (DCR skipped)", {
        package_id: packageId,
        client_id: staticCredentials.clientId,
      });
    }
  }
  
  /**
   * Get the OAuth callback port from a saved client registration.
   * Scans redirect_uris for the FIRST LOOPBACK URI rather than trusting [0] —
   * RFC 7591 doesn't guarantee echo order, and non-loopback entries can't host
   * our callback server. Returns undefined if no registration exists, no
   * loopback URI is present, or every candidate is malformed.
   */
  static async getSavedClientPort(packageId: string): Promise<number | undefined> {
    try {
      const tokenStoragePath = getOAuthTokenStoragePath();
      const clientPath = path.join(tokenStoragePath, `${packageId}_client.json`);
      const clientData = await fs.readFile(clientPath, "utf8");
      const clientInfo = JSON.parse(clientData);

      const redirectUris = clientInfo?.redirect_uris;
      if (!Array.isArray(redirectUris)) return undefined;

      for (const uri of redirectUris) {
        if (typeof uri !== "string") continue;
        try {
          const url = new URL(uri);
          if (!isLoopbackHostname(url.hostname)) continue;
          const port = parseInt(url.port, 10);
          if (!isNaN(port)) return port;
        } catch {
          continue; // Malformed entry — keep scanning
        }
      }
      return undefined;
    } catch {
      return undefined; // No saved client or parse error
    }
  }
  
  async initialize() {
    await this.loadPersistedData();
  }
  
  private async loadPersistedData() {
    // Skip loading persisted client info if static credentials were provided
    if (!this.staticCredentials) {
      try {
        const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
        const clientData = await fs.readFile(clientPath, "utf8");
        this.savedClientInfo = JSON.parse(clientData);
        logger.debug("Loaded persisted client info", { 
          package_id: this.packageId,
          client_id: this.savedClientInfo?.client_id 
        });
      } catch (error) {
        // No saved client info
      }
    }
    
    try {
      const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
      const tokenData = await fs.readFile(tokenPath, "utf8");
      this.savedTokens = JSON.parse(tokenData);
      logger.info("Loaded persisted OAuth tokens", { 
        package_id: this.packageId,
        has_access_token: !!this.savedTokens?.access_token
      });
    } catch (error) {
      // No saved tokens
    }
  }
  
  get redirectUrl(): string {
    return `http://localhost:${this.oauthPort}/oauth/callback`;
  }
  
  get clientMetadata() {
    return {
      client_name: "super-mcp-router",  // RFC 7591 standard
      name: "super-mcp-router",         // Fallback for non-compliant servers
      description: "MCP Router for aggregating multiple MCP servers",
      redirect_uris: [`http://localhost:${this.oauthPort}/oauth/callback`]
    };
  }
  
  async clientInformation() {
    // Re-hydrate from static credentials if cleared by invalidateCredentials()
    if (!this.savedClientInfo && this.staticCredentials) {
      this.savedClientInfo = {
        client_id: this.staticCredentials.clientId,
        ...(this.staticCredentials.clientSecret && { client_secret: this.staticCredentials.clientSecret }),
        redirect_uris: [`http://localhost:${this.oauthPort}/oauth/callback`],
      };
      logger.debug("Restored static OAuth client info after invalidation", {
        package_id: this.packageId,
        client_id: this.staticCredentials.clientId,
      });
    }
    return this.savedClientInfo;
  }
  
  async saveClientInformation(info: any) {
    // For static credentials, update redirect_uris but keep the original client_id/secret
    if (this.staticCredentials) {
      this.savedClientInfo = {
        ...this.savedClientInfo,
        ...info,
        client_id: this.staticCredentials.clientId,
        client_secret: this.staticCredentials.clientSecret,
      };
      logger.debug("Updated static OAuth client info (credentials preserved)", {
        package_id: this.packageId,
        client_id: this.staticCredentials.clientId,
      });
      return;
    }
    
    this.savedClientInfo = info;
    
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true, mode: 0o700 });
      const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
      await fs.writeFile(clientPath, JSON.stringify(info, null, 2), { mode: 0o600 });
      logger.info("OAuth client information saved to disk", { 
        package_id: this.packageId,
        client_id: info?.client_id,
        path: clientPath
      });
    } catch (error) {
      logger.error("Failed to persist OAuth client info", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  /** Absolute path of the persisted token file for this package. */
  getTokenFilePath(): string {
    return path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
  }

  /** Absolute path of the sibling "needs reconnect" marker for this package. */
  getNeedsReconnectMarkerPath(): string {
    return path.join(this.tokenStoragePath, `${this.packageId}_needsReconnect.json`);
  }

  getPackageId(): string {
    return this.packageId;
  }

  /**
   * Read the on-disk token set fresh, bypassing the in-memory mirror.
   * Returns undefined when the file is absent (ENOENT). A read/parse failure for
   * any other reason is surfaced (re-thrown) so callers can decide — we do NOT
   * silently treat a corrupt file as "no tokens".
   */
  async readDiskTokens(): Promise<any | undefined> {
    const tokenPath = this.getTokenFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(tokenPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return JSON.parse(raw) as any;
  }

  async tokens() {
    // Re-read disk every call so a process that entered after a peer rotated the
    // refresh token observes the fresh token (the SDK's retry-after-invalidate
    // then converges). Keep the in-memory mirror coherent with disk.
    try {
      const disk = await this.readDiskTokens();
      if (disk === undefined) {
        // ENOENT: no tokens persisted. Mirror that (don't resurrect a stale
        // in-memory value — the file being gone is authoritative, e.g. after a
        // genuine invalidation).
        this.savedTokens = undefined;
        return undefined;
      }
      this.savedTokens = disk;
      return this.stripInternalFields(disk);
    } catch (error) {
      // Read/parse failure (NOT ENOENT). Do not silently swallow: log with
      // context, and fall back to the last known in-memory value so a single
      // torn/locked read does not spuriously force re-auth.
      logger.warn("Failed to read OAuth tokens from disk; using in-memory fallback", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.stripInternalFields(this.savedTokens);
    }
  }

  /** Strip private bookkeeping fields before handing tokens to the SDK. */
  private stripInternalFields(tokens: any): any {
    return stripObtainedAtStamp(tokens);
  }

  /**
   * Merge an incoming token set against the freshest on-disk value and persist it
   * atomically + durably. This is the single critical-section persist used both
   * by the transactional refresh (fail-closed, under the lock) and by the SDK's
   * public `saveTokens()` (tolerant). Returns the merged token set actually
   * written (or the value that was deliberately preserved by the stale-write
   * guard). Throws on a genuine persistence failure — callers decide whether to
   * fail closed.
   *
   * `authoritative` = this write carries a FRESH rotation we just obtained under
   * the refresh lock; it is the source of truth and bypasses the stale-write
   * guard. Non-authoritative writes (the SDK's unavoidable second save, racing
   * peers) are guarded so they cannot downgrade a newer on-disk token.
   */
  private async mergeAndPersistTokens(tokens: any, authoritative: boolean): Promise<any> {
    // Compute the refresh-token-preserve merge against the ON-DISK value read
    // immediately before write — never the (possibly stale) in-memory mirror —
    // so a concurrent peer's freshly-rotated refresh_token is not clobbered by a
    // stale merge base.
    let onDisk: any;
    try {
      onDisk = await this.readDiskTokens();
    } catch (error) {
      // Corrupt/unreadable existing file: log and proceed with the in-memory
      // mirror as the merge base rather than crashing the refresh.
      logger.warn("Could not read existing tokens before save; merging against in-memory state", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      onDisk = this.savedTokens;
    }

    const mergeBase = onDisk ?? this.savedTokens ?? {};
    const mergedTokens: any = {
      ...mergeBase,
      ...tokens,
    };

    // OAuth refresh responses often omit refresh_token when it has not rotated.
    // Preserve the existing refresh token so a routine access-token refresh does
    // not make the next app launch require full browser authentication.
    if (!tokens?.refresh_token && mergeBase?.refresh_token) {
      mergedTokens.refresh_token = mergeBase.refresh_token;
    }

    // STALE-WRITE GUARD (non-authoritative writes only). Apply it to the MERGED
    // result, not the raw incoming body, so it can distinguish:
    //   - a TRUE redundant re-write (merged == disk, ignoring our private stamp)
    //     → skip; AND
    //   - a real access-token-only refresh (incoming has a NEW access_token but
    //     omits/repeats the refresh_token; the merge above already preserved the
    //     existing refresh_token) → merged differs from disk → MUST write.
    // The authoritative transaction persist (a freshly-rotated token obtained
    // under the lock) is exempt — it IS the new truth.
    if (!authoritative && onDisk && this.shouldSkipNonAuthoritativeWrite(onDisk, tokens, mergedTokens)) {
      logger.debug("Skipping token save: on-disk token already captures this write (stale-write guard)", {
        package_id: this.packageId,
      });
      this.savedTokens = onDisk;
      return onDisk;
    }

    // Stamp the moment we obtained this access_token so a peer can later judge
    // whether it is still valid and short-circuit a refresh.
    if (tokens?.access_token) {
      mergedTokens[OBTAINED_AT_FIELD] = Date.now();
    }

    await this.atomicWriteTokens(mergedTokens);
    this.savedTokens = mergedTokens;
    // Record the authoritative token set we just wrote so the SDK's subsequent
    // tolerant echo of it can be recognised and skipped without clobbering a
    // newer disk token (a peer's, or our own later authoritative refresh's) —
    // see shouldSkipNonAuthoritativeWrite. A bounded QUEUE (not a single slot)
    // so multiple outstanding authoritative writes each remain recognisable
    // until their echoes are consumed (F1).
    if (authoritative) {
      this.recordAuthoritativeEcho({
        access_token: mergedTokens.access_token,
        refresh_token: mergedTokens.refresh_token,
      });
    }
    logger.info("OAuth tokens saved to disk", {
      package_id: this.packageId,
      path: this.getTokenFilePath(),
      has_refresh_token: !!mergedTokens.refresh_token,
    });
    return mergedTokens;
  }

  /**
   * Decide whether a NON-AUTHORITATIVE write (the SDK's public `saveTokens()` or a
   * racing peer) should be SKIPPED. Operates on the already-merged result so the
   * guard cannot conflate two different cases:
   *
   *  - INV-A (a real access-token-only refresh): incoming carries a new
   *    access_token and omits/repeats the refresh_token. The caller's merge has
   *    already preserved the existing refresh_token, so `merged` differs from disk
   *    (new access_token) → we must NOT skip. The pre-fix bug skipped this because
   *    it keyed on the raw incoming body lacking a refresh_token.
   *
   *  - The SDK's unavoidable SECOND save: after the in-lock transaction persisted
   *    the rotation, the SDK calls `saveTokens()` with the same parsed body.
   *      • If disk is UNCHANGED since that authoritative write, `merged` deep-
   *        equals disk (ignoring our private stamp) → a pure redundant re-write →
   *        SKIP (avoids an extra fsync + re-stamp churn).
   *      • If disk has MOVED since that authoritative write (a peer rotated, OR our
   *        own LATER authoritative refresh superseded it), the echo must NOT
   *        downgrade it. We detect this via `authoritativeTokenEchoes`, a bounded
   *        QUEUE of the identities our recent authoritative persists wrote: when
   *        the incoming tokens match ANY still-pending authoritative identity AND
   *        disk no longer matches that identity, the incoming is a stale echo of a
   *        now-superseded token → SKIP (INV-B, no downgrade). A single slot was
   *        insufficient (F1): persist(v1) → persist(v2) → delayed echo(v1) would
   *        leave the slot holding v2, fail to recognise v1, and downgrade v2→v1.
   *        The SDK's subsequent `tokens()` re-read converges onto the fresh token.
   *
   * Anything else — a genuinely new credential (interactive re-auth, a later
   * rotation the SDK reports first) — falls through to a normal write.
   *
   * Constraint: the SDK strips unknown fields, so the incoming body carries NO
   * persist stamp; timestamp comparison across the SDK boundary is impossible.
   * Hence the merged-deep-equal + authoritative-echo signals rather than a
   * brittle "different refresh_token ⇒ always allow" heuristic (which would let a
   * stale peer echo downgrade a newer disk token).
   */
  private shouldSkipNonAuthoritativeWrite(onDisk: any, incoming: any, merged: any): boolean {
    // Case 1 — pure redundant re-write: the merged result equals what's already
    // on disk (ignoring our private bookkeeping stamp). Re-writing would only
    // churn an extra fsync + re-stamp. Skip.
    if (this.tokensEqualIgnoringStamp(onDisk, merged)) {
      return true;
    }

    // Case 2 — stale echo of a token that has since been superseded. The incoming
    // tokens match the exact set ONE OF our recent authoritative persists wrote,
    // but disk has since moved off that set (a peer rotated, or our own later
    // authoritative refresh did). Persisting now would downgrade the newer token,
    // so skip and let the next `tokens()` re-read converge. Compared on the
    // SDK-visible {access_token, refresh_token} identity (the stamp is private and
    // not in the incoming body). We scan a BOUNDED QUEUE of pending authoritative
    // identities (F1) so multiple outstanding echoes are each recognised, and we
    // CONSUME the matched entry so a one-shot echo cannot suppress a genuinely new
    // future write with the same identity.
    const matchIndex = this.authoritativeTokenEchoes.findIndex(
      (echo) => this.tokenIdentityEquals(incoming, echo) && !this.tokenIdentityEquals(onDisk, echo),
    );
    if (matchIndex !== -1) {
      this.authoritativeTokenEchoes.splice(matchIndex, 1);
      return true;
    }

    return false;
  }

  /**
   * Append an authoritative token identity to the bounded echo queue, evicting the
   * oldest entry if the cap is exceeded (F1). Storing only the SDK-visible
   * access/refresh identity — never logged, fingerprint-only comparison.
   */
  private recordAuthoritativeEcho(echo: { access_token?: string; refresh_token?: string }): void {
    this.authoritativeTokenEchoes.push(echo);
    if (this.authoritativeTokenEchoes.length > MAX_AUTHORITATIVE_ECHOES) {
      // Evicting an entry whose SDK echo has not yet arrived re-opens the F1
      // stale-echo downgrade window for that token. Under the current client
      // concurrency (5) this cannot happen, so an eviction signals that the
      // outstanding-refresh ceiling has risen above MAX_AUTHORITATIVE_ECHOES and
      // the cap needs revisiting. Surface it (no token material — count only)
      // rather than silently dropping a still-pending identity.
      logger.warn(
        "Authoritative token-echo queue exceeded cap; evicting oldest pending echo (F1 stale-echo window may re-open)",
        {
          package_id: this.packageId,
          cap: MAX_AUTHORITATIVE_ECHOES,
        },
      );
      this.authoritativeTokenEchoes.shift();
    }
  }

  /** True when both token sets carry the same SDK-visible access/refresh identity. */
  private tokenIdentityEquals(
    a: { access_token?: unknown; refresh_token?: unknown } | undefined,
    b: { access_token?: unknown; refresh_token?: unknown } | undefined,
  ): boolean {
    return a?.access_token === b?.access_token && a?.refresh_token === b?.refresh_token;
  }

  /**
   * Deep-equal two persisted token sets while IGNORING our private obtained-at
   * stamp (which differs on every write and must not defeat the redundant-write
   * skip). Order-independent over the remaining keys.
   */
  private tokensEqualIgnoringStamp(a: any, b: any): boolean {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    const strip = (o: any) => {
      const { [OBTAINED_AT_FIELD]: _omit, ...rest } = o;
      return rest;
    };
    const sa = strip(a);
    const sb = strip(b);
    const keysA = Object.keys(sa);
    const keysB = Object.keys(sb);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((k) => sa[k] === sb[k]);
  }

  /**
   * Atomic + durable token write: temp file in the SAME directory (so the rename
   * is atomic on the same filesystem), fsync the temp file, rename over the
   * target, then fsync the containing directory so a crash/power-loss cannot
   * leave the consumed old refresh token as the durable file (FM6). A concurrent
   * reader sees the old file or the new file in full, never a torn intermediate.
   * graceful-fs (installed at boot) retries transient EPERM/EMFILE, incl. the
   * Windows file-in-use window on rename. Throws on failure — no silent swallow.
   */
  private async atomicWriteTokens(mergedTokens: any): Promise<void> {
    await fs.mkdir(this.tokenStoragePath, { recursive: true, mode: 0o700 });
    const tokenPath = this.getTokenFilePath();
    const tempPath = path.join(
      this.tokenStoragePath,
      `.${this.packageId}_tokens.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );

    let wrote = false;
    try {
      const handle = await fs.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(mergedTokens, null, 2));
        // Durability: flush the temp file's contents to stable storage before the
        // rename, so the rename can never expose a half-flushed file after a crash.
        await handle.sync();
      } finally {
        await handle.close();
      }
      wrote = true;

      await fs.rename(tempPath, tokenPath);
      // Flush the directory entry so the rename itself is durable (a crash after
      // rename but before the dir metadata is flushed could otherwise revert to
      // the old, now-consumed token file). Best-effort: some platforms (Windows)
      // do not permit opening a directory for fsync — tolerate that specific case.
      await this.fsyncDir(this.tokenStoragePath);
    } catch (error) {
      // Best-effort cleanup of the temp file if anything failed after we created
      // it; surface the original failure (no silent swallow).
      if (wrote || (await fs.access(tempPath).then(() => true, () => false))) {
        await fs.unlink(tempPath).catch(() => {});
      }
      throw error;
    }
  }

  /** fsync a directory entry. Tolerates platforms that disallow O_RDONLY on dirs. */
  private async fsyncDir(dirPath: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(dirPath, "r");
      await handle.sync();
    } catch (error) {
      // Windows (and some FS) reject opening a directory for fsync (EISDIR/EPERM/
      // EACCES). The file-content fsync above is the load-bearing durability step;
      // the dir fsync is belt-and-braces, so degrade quietly with a debug log
      // rather than failing an otherwise-successful write.
      logger.debug("Directory fsync skipped (unsupported on this platform/FS)", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  async saveTokens(tokens: any) {
    // Public SDK hook. TOLERANT path: the transactional refresh has already
    // persisted the rotated token under the lock (fail-closed) before this
    // unavoidable second save runs, and the stale-write guard makes a redundant
    // or stale save a no-op. So a persistence failure here is logged, not thrown,
    // to keep the benign single-process / interactive authenticate() paths from
    // crashing on a transient write error. The fail-CLOSED guarantee for a real
    // rotation lives in persistRotatedTokensOrThrow(), called under the lock.
    try {
      await this.mergeAndPersistTokens(tokens, false);
    } catch (error) {
      logger.error("Failed to persist OAuth tokens", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * FAIL-CLOSED persist for a real rotation, called by the transactional refresh
   * INSIDE the held cross-process lock, BEFORE the response is returned to the
   * SDK. After the server has consumed a single-use refresh token, a failed
   * persist would otherwise leave a dead token on disk while the SDK reports
   * AUTHORIZED — a silent wedge on the next restart. So this surfaces a hard
   * error instead of swallowing it (MA2). Returns the merged token set written.
   */
  async persistRotatedTokensOrThrow(tokens: any): Promise<any> {
    return this.mergeAndPersistTokens(tokens, true);
  }
  
  async redirectToAuthorization(authUrl: URL) {
    // Authorize pre-flight probe (REBEL-7F9 Stage 3). Kill-switch active →
    // skip the probe entirely: the flow is byte-identical to the pre-probe
    // behavior (confirm#F5).
    const probeDisabled = isAuthorizeProbeDisabled();
    if (probeDisabled) {
      logger.info("Authorize pre-flight probe disabled via SUPER_MCP_OAUTH_PROBE_DISABLE", {
        package_id: this.packageId,
      });
    } else if (this.skipAuthorizeProbe) {
      logger.debug("Authorize pre-flight probe skipped (saved-port reuse or browser floor)", {
        package_id: this.packageId,
      });
    } else {
      const verdict = await probeAuthorizeUrl(authUrl.toString());
      this.lastProbeVerdict = verdict;
      logger.info("Authorize pre-flight probe verdict", {
        package_id: this.packageId,
        outcome: verdict.outcome,
        status: verdict.status,
        matched_phrase: verdict.matchedPhrase,
        // Raw AS Location (3xx shapes) + network-failure detail (inconclusive
        // fail-open) at info level: the message never carries the Location
        // (k3 F1), so this log is the observability channel for both the
        // accepted/rejected Location shapes and why a probe failed open
        // (runtime-safety F7).
        location: verdict.location,
        error: verdict.error,
      });
      if (verdict.outcome === "rejected") {
        // redirectStarted is set only AFTER the probe verdict (recall#2
        // F2(d)) — the SSE/StreamableHTTP fallback guards key off
        // hasStartedRedirect(). The coded error propagates through SDK
        // auth() unchanged (1.28.0 gate: transports rethrow the original
        // error) and authenticate.ts advances the port-retry loop. The
        // browser is NOT opened for a sign-in page we know will fail.
        this.redirectStarted = true;
        throw buildRedirectUriRejectedError(verdict);
      }
    }

    this.redirectStarted = true;
    logger.info("Opening browser for OAuth", {
      package_id: this.packageId,
      url: authUrl.toString()
    });
    
    const clientId = authUrl.searchParams.get('client_id');
    if (clientId && !this.savedClientInfo) {
      this.savedClientInfo = {
        client_id: clientId,
        client_secret: undefined
      };
      logger.info("Extracted client_id from OAuth URL", {
        package_id: this.packageId,
        client_id: clientId
      });
    }
    
    const urlString = authUrl.toString();
    try {
      let child;
      if (process.platform === 'darwin') {
        child = spawn('open', [urlString], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'win32') {
        // Use rundll32 instead of cmd/start to avoid shell metacharacter issues with & in URLs
        child = spawn('rundll32', ['url.dll,FileProtocolHandler', urlString], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [urlString], { detached: true, stdio: 'ignore' });
      }
      // Handle spawn errors to prevent crashing the process
      child.on('error', (err) => {
        logger.error("Failed to open browser", {
          package_id: this.packageId,
          error: err.message
        });
      });
      child.unref();
      logger.info("Browser opened for OAuth", { package_id: this.packageId });
    } catch (error) {
      logger.error("Failed to open browser", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  hasStartedRedirect(): boolean {
    return this.redirectStarted;
  }
  
  async saveCodeVerifier(verifier: string) {
    this.codeVerifierValue = verifier;
  }
  
  async codeVerifier() {
    if (!this.codeVerifierValue) {
      throw new Error("PKCE code verifier not set - saveCodeVerifier() must be called first");
    }
    return this.codeVerifierValue;
  }
  
  /**
   * Returns the OAuth state parameter for CSRF protection.
   * Generates a cryptographically random 32-byte hex string on first call,
   * then returns the cached value for subsequent calls within the same auth flow.
   */
  async state(): Promise<string> {
    if (!this.stateValue) {
      this.stateValue = randomBytes(32).toString('hex');
      logger.debug("Generated OAuth state parameter", {
        package_id: this.packageId,
        state_length: this.stateValue.length
      });
    }
    return this.stateValue;
  }
  
  /**
   * Returns the stored state value without generating a new one.
   * Used for validation in the callback server.
   */
  getStoredState(): string | undefined {
    return this.stateValue;
  }

  setLastOAuthError(error: OAuthErrorSummary): void {
    this.lastOAuthError = {
      error: error.error,
      ...(error.error_description ? { error_description: error.error_description } : {}),
    };
  }

  consumeLastOAuthError(): OAuthErrorSummary | undefined {
    const error = this.lastOAuthError;
    this.lastOAuthError = undefined;
    return error;
  }

  setSkipAuthorizeProbe(skip: boolean): void {
    this.skipAuthorizeProbe = skip;
  }

  /**
   * Consume the recorded probe verdict (consume-once, like
   * consumeLastOAuthError but a SEPARATE slot — see field comment).
   */
  consumeProbeVerdict(): AuthorizeProbeVerdict | undefined {
    const verdict = this.lastProbeVerdict;
    this.lastProbeVerdict = undefined;
    return verdict;
  }

  /**
   * Probe-skip predicate (confirm#F6): a prior successful token exchange is
   * mechanically "<packageId>_tokens.json present with a parseable
   * access_token". Saved-port reuse WITH that file ⇒ the authenticate handler
   * skips the probe; absent (the REBEL-7F9 reporter's saved 5173) ⇒ it runs.
   */
  static async hasPersistedAccessToken(packageId: string): Promise<boolean> {
    try {
      const tokenPath = path.join(getOAuthTokenStoragePath(), `${packageId}_tokens.json`);
      const raw = await fs.readFile(tokenPath, "utf8");
      const tokens = JSON.parse(raw);
      return typeof tokens?.access_token === "string" && tokens.access_token.length > 0;
    } catch (error) {
      // Fail-safe direction (false ⇒ the probe runs), but never SILENTLY: a
      // persistent cause (EACCES on the token dir, corrupt JSON) would
      // otherwise invisibly disable the probe-skip optimization on every
      // authenticate forever (runtime-safety F4). Common cause is ENOENT (no
      // prior token exchange) — debug level is the right volume for that.
      logger.debug("hasPersistedAccessToken: token file unreadable; the probe will run", {
        package_id: packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  
  /**
   * Clear the persisted token set (un-wedge a genuinely-dead grant) and write a
   * sibling `needsReconnect` marker so the host can surface a clean reconnect
   * prompt instead of silently re-failing forever. Used by the transactional
   * refresh in the fetch wrapper once a grant is proven dead (disk unchanged
   * after bounded backoff). Idempotent.
   */
  async clearTokensAndMarkNeedsReconnect(reason: OAuthErrorSummary | undefined): Promise<void> {
    this.savedTokens = undefined;
    this.authoritativeTokenEchoes = [];
    const tokenPath = this.getTokenFilePath();
    try {
      await fs.unlink(tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("Failed to delete dead OAuth token file", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const markerPath = this.getNeedsReconnectMarkerPath();
    const marker = {
      package_id: this.packageId,
      needs_reconnect: true,
      at: new Date().toISOString(),
      ...(reason?.error ? { error: reason.error } : {}),
      ...(reason?.error_description ? { error_description: reason.error_description } : {}),
    };
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true, mode: 0o700 });
      await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
    } catch (error) {
      logger.error("Failed to write needsReconnect marker", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.error("OAuth grant is dead — cleared tokens and flagged reconnect", {
      package_id: this.packageId,
      ...(reason ? reason : {}),
    });
  }

  /**
   * Refresh-only token invalidation, disk-compare aware. The transactional fetch
   * wrapper is the authority that clears a genuinely-dead grant (and writes the
   * reconnect marker). By the time the SDK calls invalidateCredentials('tokens')
   * after an InvalidGrantError, one of three things is true on disk:
   *   - tokens are already GONE → the wrapper cleared a dead grant; nothing to do.
   *   - tokens are PRESENT and a reconnect marker exists → dead grant already
   *     flagged but a residual file remains; clear it to stay un-wedged.
   *   - tokens are PRESENT and no marker → the wrapper deliberately kept them
   *     (short-circuit / peer rotated / non-refresh path) → PRESERVE them.
   * This replaces the old unconditional swallow with a decision grounded in
   * what's actually on disk, so a real dead grant can clear while a peer's
   * freshly-rotated token is never deleted.
   */
  async invalidateTokensRefreshOnly(): Promise<void> {
    const oauthError = this.consumeLastOAuthError();
    let disk: any;
    try {
      disk = await this.readDiskTokens();
    } catch {
      disk = undefined;
    }

    if (!disk) {
      logger.info("Token invalidation (refresh-only): tokens already cleared", {
        package_id: this.packageId,
        ...(oauthError ? oauthError : {}),
      });
      this.savedTokens = undefined;
      return;
    }

    let markerExists = false;
    try {
      await fs.access(this.getNeedsReconnectMarkerPath());
      markerExists = true;
    } catch {
      markerExists = false;
    }

    if (markerExists) {
      logger.warn("Token invalidation (refresh-only): dead grant flagged, clearing residual tokens", {
        package_id: this.packageId,
        ...(oauthError ? oauthError : {}),
      });
      await this.invalidateCredentials("tokens");
      return;
    }

    logger.warn("Token invalidation (refresh-only): preserving on-disk tokens", {
      message:
        "On-disk tokens are present and not flagged dead (peer may have rotated). Preserving to avoid forcing re-auth.",
      package_id: this.packageId,
      ...(oauthError ? oauthError : {}),
    });
  }

  /**
   * Remove the needsReconnect marker after a successful re-auth / refresh. Gated
   * on the marker actually existing so the common (no-marker) hourly-refresh path
   * costs a single `access` stat rather than an unconditional `unlink` syscall.
   */
  async clearNeedsReconnectMarker(): Promise<void> {
    const markerPath = this.getNeedsReconnectMarkerPath();
    try {
      await fs.access(markerPath);
    } catch {
      // No marker present (the overwhelmingly common case): nothing to do.
      return;
    }
    try {
      await fs.unlink(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.debug("Could not remove needsReconnect marker", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery' = 'all') {
    const oauthError = this.consumeLastOAuthError();
    logger.info("Invalidating OAuth credentials", { 
      package_id: this.packageId,
      scope,
      ...(oauthError ? oauthError : {}),
    });
    
    if (scope === 'all' || scope === 'tokens') {
      this.savedTokens = undefined;
      this.authoritativeTokenEchoes = [];
      try {
        const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
        await fs.unlink(tokenPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'client') {
      this.savedClientInfo = undefined;
      try {
        const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
        await fs.unlink(clientPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
    }
    
    // Always clear state on 'all' - state is session-specific
    if (scope === 'all') {
      this.stateValue = undefined;
    }
  }
  
  /**
   * Check whether the DISK-PERSISTED DCR client registration is stale relative
   * to the current redirectUrl and, if so, invalidate ALL credentials
   * (client + tokens) so the flow re-registers with the right redirect_uris.
   *
   * Stale when (REBEL-7F9 Stage 2a):
   *   - the normalized redirect_uris list does NOT include the current
   *     redirectUrl (full-URI `.includes()` compare, NOT `[0] ===` — RFC 7591
   *     doesn't guarantee echo order; loopback spellings
   *     localhost ≡ 127.0.0.1 ≡ [::1] are normalized so spelling variants
   *     don't per-launch-invalidate), or
   *   - a client file EXISTS on disk but its redirect_uris is missing or
   *     unparseable.
   *
   * NOT stale when the client file is ABSENT (fresh registration — and
   * static-credential providers, which deliberately skip the disk client load
   * in loadPersistedData and synthesize redirect_uris in memory from the
   * current port; classifying them stale would invalidate WORKING tokens).
   *
   * Reads ONLY the disk-persisted client file — never the in-memory
   * savedClientInfo, which redirectToAuthorization may have synthesized
   * WITHOUT redirect_uris.
   *
   * @returns true if credentials were invalidated due to staleness
   */
  async checkAndInvalidateOnPortMismatch(): Promise<boolean> {
    // Static-credential providers are never stale on redirect-URI grounds:
    // their redirect_uris are synthesized in memory from the current port and
    // their pre-registered tokens WORK — invalidating them would break a
    // healthy connector. (Behavior-identical to the old code, whose static
    // branch was unreachable: the synthesized redirect_uris always matched
    // the current port.)
    if (this.staticCredentials) {
      return false;
    }

    const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
    let raw: string;
    try {
      raw = await fs.readFile(clientPath, "utf8");
    } catch {
      return false; // No client file on disk (fresh registration) → not stale
    }

    let redirectUris: unknown;
    try {
      redirectUris = JSON.parse(raw)?.redirect_uris;
    } catch {
      redirectUris = undefined; // File present but unparseable → stale
    }

    const normalizedCurrent = normalizeRedirectUriForCompare(this.redirectUrl);
    const isStale =
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.some(
        (uri) =>
          typeof uri === "string" &&
          normalizeRedirectUriForCompare(uri) === normalizedCurrent
      );

    if (!isStale) {
      return false;
    }

    try {
      logger.warn("OAuth client registration is stale, invalidating credentials", {
        package_id: this.packageId,
        current_redirect_url: this.redirectUrl,
        saved_redirect_uris: Array.isArray(redirectUris) ? redirectUris : undefined,
        message: "Will re-register client with the current redirect_uri",
      });

      // Must invalidate BOTH - tokens are bound to client_id
      await this.invalidateCredentials('all');
      return true;
    } catch (error) {
      logger.debug("Error invalidating stale OAuth credentials", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}
