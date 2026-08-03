import * as http from "http";
import { timingSafeEqual } from "crypto";
import { getLogger } from "../logging.js";
import {
  OAUTH_CALLBACK_HOST_V4,
  OAUTH_CALLBACK_HOST_V6,
} from "../utils/portFinder.js";

/** Error codes that mean IPv6 loopback simply isn't usable on this host. */
const IPV6_UNSUPPORTED_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);

const logger = getLogger();

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read branding config from environment variables with sensible defaults */
function getCallbackHtmlConfig() {
  return {
    appName: process.env.SUPER_MCP_APP_NAME || "Rebel",
    iconUrl: process.env.SUPER_MCP_ICON_URL || "",
    iconText: process.env.SUPER_MCP_ICON_TEXT || "✓",
    primaryColor: process.env.SUPER_MCP_PRIMARY_COLOR || "#6366f1",
    countdownSeconds: parseInt(process.env.SUPER_MCP_COUNTDOWN_SECONDS || "5", 10),
    deepLinkUrl: process.env.SUPER_MCP_DEEP_LINK_URL || "mindstone://settings/connectors",
  };
}

/** Pick a random item from an array */
function randomPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Format service name for display (capitalize, handle kebab-case) */
function formatServiceName(serviceId: string): string {
  if (!serviceId) return "your service";
  const knownNames: Record<string, string> = {
    "linear": "Linear", "notion": "Notion", "slack": "Slack", "github": "GitHub",
    "google": "Google", "atlassian": "Atlassian", "jira": "Jira", "asana": "Asana",
    "trello": "Trello", "figma": "Figma", "dropbox": "Dropbox", "airtable": "Airtable",
    "monday": "Monday", "clickup": "ClickUp", "todoist": "Todoist", "zendesk": "Zendesk",
    "hubspot": "HubSpot", "salesforce": "Salesforce", "sentry": "Sentry",
    "cloudflare": "Cloudflare", "cloudflare workers": "Cloudflare Workers",
  };
  const lower = serviceId.toLowerCase().split("-")[0]; // Extract base name before instance suffix
  if (knownNames[lower]) return knownNames[lower];
  return serviceId.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Generate a success message with the service name baked in. */
function generateSuccessMessage(serviceName: string): { headline: string; subtitle: string } {
  const messages = [
    { headline: "You're in.", subtitle: `${serviceName} and Rebel are now on speaking terms. The hard part's over.` },
    { headline: "Connected.", subtitle: `${serviceName} has joined the party. Click below to return to Rebel.` },
    { headline: "Done and done.", subtitle: `${serviceName} is locked in. OAuth handshake complete, dignity intact.` },
    { headline: "That's a wrap.", subtitle: `${serviceName} credentials secured. No tokens were harmed in this connection.` },
    { headline: "All systems go.", subtitle: `${serviceName} is officially on board. Click the button to continue.` },
    { headline: "Consider it handled.", subtitle: `${serviceName} and Rebel have exchanged pleasantries and API keys.` },
    { headline: "Mission accomplished.", subtitle: `${serviceName} integration complete. The bureaucracy of OAuth is behind us.` },
    { headline: "Link established.", subtitle: `${serviceName} now answers to Rebel. The paperwork is filed, tokens acquired.` },
    { headline: "Success.", subtitle: `${serviceName} is connected. That was easier than explaining OAuth to a friend.` },
    { headline: "We're in business.", subtitle: `${serviceName} access granted. Click below to return with credentials intact.` },
  ];
  return randomPick(messages);
}

/** Generate success HTML page with prominent button to return to Rebel */
function generateSuccessHtml(serviceId?: string): string {
  const config = getCallbackHtmlConfig();
  const appName = escapeHtml(config.appName);
  const deepLinkUrl = escapeHtml(config.deepLinkUrl);
  const countdownSeconds = config.countdownSeconds;
  const serviceName = formatServiceName(serviceId || "");
  const message = generateSuccessMessage(serviceName);
  const headline = escapeHtml(message.headline);
  const subtitle = escapeHtml(message.subtitle);
  const iconContent = config.iconUrl
    ? `<img src="${escapeHtml(config.iconUrl)}" alt="" style="width:48px;height:48px;">`
    : escapeHtml(config.iconText);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected — ${appName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(145deg, #0c0c14 0%, #1a1a2e 50%, #0f0f1a 100%);
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      color: #e0e0e0;
    }
    .container { max-width: 420px; padding: 56px 48px; text-align: center; }
    .icon {
      width: 88px; height: 88px; margin: 0 auto 28px;
      background: linear-gradient(135deg, ${escapeHtml(config.primaryColor)} 0%, ${escapeHtml(config.primaryColor)}cc 100%);
      border-radius: 22px;
      display: flex; align-items: center; justify-content: center;
      font-size: 44px; color: white;
      box-shadow: 0 12px 40px ${escapeHtml(config.primaryColor)}35;
      animation: iconPulse 2s ease-in-out infinite;
    }
    @keyframes iconPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
    h1 { font-size: 26px; font-weight: 600; margin-bottom: 12px; color: #ffffff; letter-spacing: -0.3px; }
    .subtitle { font-size: 15px; color: #888; line-height: 1.6; margin-bottom: 32px; }
    .countdown-container {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      padding: 16px 24px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .countdown-text { font-size: 14px; color: #666; }
    .countdown-number { font-size: 18px; font-weight: 600; color: ${escapeHtml(config.primaryColor)}; min-width: 24px; }
    .open-button {
      display: inline-block; padding: 14px 28px;
      background: linear-gradient(135deg, ${escapeHtml(config.primaryColor)} 0%, ${escapeHtml(config.primaryColor)}dd 100%);
      color: white; font-size: 15px; font-weight: 500;
      border: none; border-radius: 10px; cursor: pointer;
      text-decoration: none;
      box-shadow: 0 4px 16px ${escapeHtml(config.primaryColor)}40;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .open-button:hover { transform: translateY(-1px); box-shadow: 0 6px 20px ${escapeHtml(config.primaryColor)}50; }
    .fallback { margin-top: 16px; font-size: 13px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${iconContent}</div>
    <h1>${headline}</h1>
    <p class="subtitle">${subtitle}</p>
    <div class="countdown-container">
      <span class="countdown-text">Auto-opening ${appName} in</span>
      <span class="countdown-number" id="countdown">${countdownSeconds}</span>
    </div>
    <a href="${deepLinkUrl}" class="open-button" id="openBtn">Open ${appName}</a>
    <p class="fallback">If ${appName} doesn't open automatically, click the button above.</p>
  </div>
  <script>
    (function() {
      var count = ${countdownSeconds};
      var el = document.getElementById('countdown');
      var btn = document.getElementById('openBtn');
      var countdownContainer = document.querySelector('.countdown-container');
      var fallback = document.querySelector('.fallback');
      var opened = false;
      var timerId = null;

      function openApp() {
        if (opened) return;
        opened = true;
        if (timerId) clearTimeout(timerId);
        if (countdownContainer) countdownContainer.style.display = 'none';
        if (fallback) fallback.style.display = 'none';
        window.location.href = '${deepLinkUrl}';
      }

      function tick() {
        if (opened) return;
        count--;
        el.textContent = count;
        if (count <= 0) {
          openApp();
        } else {
          timerId = setTimeout(tick, 1000);
        }
      }

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        openApp();
      });

      timerId = setTimeout(tick, 1000);
    })();
  </script>
</body>
</html>`;
}

/** Generate error HTML page */
function generateErrorHtml(error: string, errorDescription?: string): string {
  const config = getCallbackHtmlConfig();
  const appName = escapeHtml(config.appName);
  const errorText = escapeHtml(error);
  const descriptionText = errorDescription ? escapeHtml(errorDescription) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection Failed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e0e0e0;
    }
    .container { max-width: 400px; padding: 48px; text-align: center; }
    .icon {
      width: 80px; height: 80px; margin: 0 auto 24px;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      border-radius: 20px;
      display: flex; align-items: center; justify-content: center;
      font-size: 40px; color: white;
      box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);
    }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
    p { font-size: 15px; color: #a0a0a0; line-height: 1.5; margin-bottom: 16px; }
    .error-detail {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px; padding: 12px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px; color: #f87171;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">!</div>
    <h1>Connection Failed</h1>
    <p>Something went wrong. You can close this window and try again in ${appName}.</p>
    <div class="error-detail">${errorText}${descriptionText ? `<br><br>${descriptionText}` : ""}</div>
  </div>
  <script>setTimeout(function() { window.close(); }, 5000);</script>
</body>
</html>`;
}

/**
 * Distinct rejection message for a waitForCallback waiter cancelled by stop()
 * (REBEL-7F9 Stage 3 refinement, runtime-safety F3): a probe-rejected
 * attempt's race has already settled when its callback server is torn down,
 * so the waiter must not linger until its own 300s timer fires. The distinct
 * message gives the callback-during-teardown race a deterministic, observable
 * outcome instead of silence. Callers that lost the race attach rejection
 * suppression, so this rejection is expected to be handled.
 */
export const OAUTH_CALLBACK_SERVER_STOPPED_MESSAGE =
  "OAuth callback server stopped before a callback arrived";

/** Security headers for OAuth callback responses */
const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export class OAuthCallbackServer {
  /** IPv4 listener (127.0.0.1). REQUIRED — start() fails if this can't bind. */
  private serverV4?: http.Server;
  /** IPv6 listener (::1). BEST-EFFORT — missing on hosts without IPv6 loopback. */
  private serverV6?: http.Server;
  private port: number;
  private resolveCallback?: (code: string) => void;
  private rejectCallback?: (error: Error) => void;
  private callbackTimer?: NodeJS.Timeout;
  private expectedState?: string;
  private serviceId?: string;

  constructor(port: number = 5173) {
    this.port = port;
  }
  
  /** Set the service ID for display in the success page (e.g., "Sentry", "Linear") */
  setServiceId(serviceId: string): void {
    this.serviceId = serviceId;
  }
  
  /**
   * Timing-safe string comparison to prevent timing attacks on state validation.
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  /**
   * State-check-then-settle guard shared by the `code` and `?error=` branches
   * (REBEL-7F9 Stage 3 refinement for `code`; Stage 4c extended it to
   * `?error=` per two convergent round-2 reviewers — the error branch was the
   * last remaining late-redirect kill path). A callback without this
   * attempt's state is NOT this attempt's callback — most often a LATE
   * redirect from a superseded attempt arriving at the port a newer attempt
   * now owns. Such a callback must never settle (resolve OR reject) the
   * newer attempt's wait: the mismatch is deterministically observable (warn
   * log + 400 page) but the current attempt's wait survives for the correct
   * callback or its own timeout. In a genuine CSRF shape the legitimate
   * callback can still arrive and settle the wait.
   *
   * "unverified" means no expected state is armed (state validation not in
   * use for this wait) — the caller proceeds exactly as before.
   */
  private checkCallbackState(
    receivedState: string | null,
  ): "valid" | "missing" | "mismatch" | "unverified" {
    if (!this.expectedState) {
      return "unverified";
    }
    if (!receivedState) {
      logger.warn("OAuth callback missing state parameter; not settling the callback wait", {
        has_expected_state: true,
      });
      return "missing";
    }
    if (!this.safeCompare(receivedState, this.expectedState)) {
      logger.warn("OAuth state mismatch; not settling the callback wait (stale or foreign callback)", {
        // Don't log actual state values for security
        received_length: receivedState.length,
        expected_length: this.expectedState.length,
      });
      return "mismatch";
    }
    logger.debug("OAuth state validated successfully");
    return "valid";
  }

  /** Shared 400 response for a state-invalid callback (never settles the waiter). */
  private respondInvalidState(
    res: http.ServerResponse,
    check: "missing" | "mismatch",
  ): void {
    res.writeHead(400, SECURITY_HEADERS);
    res.end(
      generateErrorHtml(
        "invalid_state",
        check === "missing" ? "Missing state parameter" : "State parameter mismatch",
      ),
    );
  }

  getPort(): number {
    return this.port;
  }

  /** Shared request handler used by both the IPv4 and IPv6 listeners. */
  private handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url || "", `http://localhost:${this.port}`);

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      const receivedState = url.searchParams.get("state");

      if (error) {
        // State-check-then-settle (REBEL-7F9 Stage 4c): the error branch
        // previously settled the waiter via rejectCallback WITHOUT state
        // validation — a stale `?error=access_denied&state=<stale>` from a
        // superseded/foreign flow arriving at a port a newer attempt owns
        // would kill the new attempt's wait. Same guard as the code branch:
        // mismatched/missing state → 400 + warn log, do NOT settle.
        const stateCheck = this.checkCallbackState(receivedState);
        if (stateCheck === "missing" || stateCheck === "mismatch") {
          this.respondInvalidState(res, stateCheck);
          return;
        }

        res.writeHead(200, SECURITY_HEADERS);
        res.end(generateErrorHtml(error, errorDescription || undefined));

        if (this.rejectCallback) {
          this.rejectCallback(new Error(`OAuth error: ${error}`));
        }
      } else if (code) {
        // Validate state parameter if expected state is set (CSRF protection)
        const stateCheck = this.checkCallbackState(receivedState);
        if (stateCheck === "missing" || stateCheck === "mismatch") {
          this.respondInvalidState(res, stateCheck);
          // Do NOT settle the waiter: a callback without this attempt's
          // state is not this attempt's callback — most often a LATE
          // redirect from a superseded attempt arriving at the port a newer
          // attempt now owns (REBEL-7F9 Stage 3 refinement: such a callback
          // must not be able to kill the subsequent attempt's wait). The
          // wait continues for the correct callback or its own timeout.
          return;
        }

        res.writeHead(200, SECURITY_HEADERS);
        res.end(generateSuccessHtml(this.serviceId));

        logger.info("OAuth callback received", {
          has_code: true,
          state_validated: !!this.expectedState,
          serviceId: this.serviceId,
          remote_family: req.socket.remoteFamily,
        });

        if (this.resolveCallback) {
          this.resolveCallback(code);
        }
      } else {
        res.writeHead(400, SECURITY_HEADERS);
        res.end(generateErrorHtml("invalid_callback", "No authorization code received"));
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  };

  /**
   * Start a single http.Server bound to the given loopback host.
   * Resolves with the bound Server, or rejects with the bind error.
   */
  private listenOn(host: string): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.handleRequest);
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, host);
    });
  }

  async start(): Promise<void> {
    // IPv4 listener is required. If localhost resolves to 127.0.0.1 anywhere in
    // the user's stack (Chrome on Windows, most Linux setups, many macOS setups)
    // this is the listener that handles the callback. Failure here is fatal.
    try {
      this.serverV4 = await this.listenOn(OAUTH_CALLBACK_HOST_V4);
      logger.info("OAuth callback server started", {
        port: this.port,
        host: OAUTH_CALLBACK_HOST_V4,
        stack: "v4",
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      logger.error("Failed to start OAuth callback server (IPv4)", {
        error: e.message,
        code: e.code,
        port: this.port,
        stack: "v4",
      });
      throw err;
    }

    // IPv6 listener is best-effort. Needed when `localhost` resolves to `::1`
    // first (default on modern macOS and some Linux distros). We still start the
    // IPv4 listener even if this fails — but we explicitly warn so operators
    // know the dual-stack protection isn't active.
    try {
      this.serverV6 = await this.listenOn(OAUTH_CALLBACK_HOST_V6);
      logger.info("OAuth callback server started", {
        port: this.port,
        host: OAUTH_CALLBACK_HOST_V6,
        stack: "v6",
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code && IPV6_UNSUPPORTED_CODES.has(e.code)) {
        // Host has no IPv6 loopback — typical on some containers / IPv6-disabled Windows.
        // IPv4-only callback is sufficient because the browser can only reach the v4 stack.
        logger.info("IPv6 loopback unavailable, running IPv4-only callback server", {
          port: this.port,
          stack: "v6",
          code: e.code,
        });
      } else {
        // e.g. EADDRINUSE — portFinder should have already caught this, but if we hit it
        // here the IPv6 stack of `localhost` will reach the wrong process. Warn loudly;
        // do NOT throw (we'd break IPv4-resolving browsers needlessly).
        logger.warn("Failed to bind OAuth callback server IPv6 listener, proceeding IPv4-only", {
          port: this.port,
          stack: "v6",
          code: e.code,
          error: e.message,
        });
      }
    }
  }

  /**
   * Wait for the OAuth callback with optional state validation.
   * 
   * @param timeout - Timeout in milliseconds (default 120000)
   * @param expectedState - Expected state parameter for CSRF protection
   */
  async waitForCallback(timeout: number = 120000, expectedState?: string): Promise<string> {
    // Store expected state for validation in the request handler
    this.expectedState = expectedState;
    
    if (expectedState) {
      logger.debug("OAuth callback server waiting with state validation", {
        state_length: expectedState.length
      });
    }
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbackTimer = undefined;
        reject(new Error("OAuth callback timeout"));
      }, timeout);
      this.callbackTimer = timer;

      // Wrap both resolve and reject to clear the timer
      this.resolveCallback = (code) => {
        clearTimeout(timer);
        this.callbackTimer = undefined;
        resolve(code);
      };
      this.rejectCallback = (error) => {
        clearTimeout(timer);
        this.callbackTimer = undefined;
        reject(error);
      };
    });
  }

  /**
   * Settle a pending waitForCallback waiter with the distinct "server
   * stopped" rejection and clear its timeout. Idempotent; a no-op when no
   * waiter is armed or the waiter already settled.
   */
  private cancelPendingWaiter(): void {
    if (this.callbackTimer) {
      clearTimeout(this.callbackTimer);
      this.callbackTimer = undefined;
    }
    if (this.rejectCallback) {
      this.rejectCallback(new Error(OAUTH_CALLBACK_SERVER_STOPPED_MESSAGE));
      this.resolveCallback = undefined;
      this.rejectCallback = undefined;
    }
  }

  async stop(): Promise<void> {
    // Cancel any pending waiter FIRST (before the no-servers early return and
    // before the shutdown grace): a probe-rejected attempt's race already
    // settled, so its waiter would otherwise leak a live 300s timer + closure
    // past teardown (runtime-safety F3).
    this.cancelPendingWaiter();

    const servers = [this.serverV4, this.serverV6].filter(
      (s): s is http.Server => s !== undefined
    );
    if (servers.length === 0) return;

    // Wait briefly to allow the success response to be fully sent to the browser
    // before force-closing connections (prevents "Connection Reset" errors)
    await new Promise((resolve) => setTimeout(resolve, 500));

    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            // Force close to avoid 60-75 second delays from browser keep-alive
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
    this.serverV4 = undefined;
    this.serverV6 = undefined;
    logger.info("OAuth callback server stopped", { listeners: servers.length });
  }
}