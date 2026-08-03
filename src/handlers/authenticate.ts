import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";
import { checkPortAvailable, findAvailablePortFromCandidates, getOAuthCallbackPortCandidates, OAUTH_CALLBACK_DEFAULT_PORT, OAUTH_CALLBACK_PORT_SCAN_END, OAUTH_CALLBACK_VENDOR_COMMON_PORT } from "../utils/portFinder.js";
import { SimpleOAuthProvider } from "../auth/providers/simple.js";
import { OAUTH_FINISH_AUTH_TIMEOUT_CODE, OAUTH_REDIRECT_URI_REJECTED_CODE } from "../clients/httpClient.js";
import { isAuthorizeProbeDisabled, type AuthorizeProbeVerdict } from "../auth/authorizeProbe.js";
import { formatError } from "../utils/formatError.js";
import { coerceStringifiedBoolean } from "../utils/normalizeInput.js";
import { getValidator } from "../validator.js";

const logger = getLogger();
const STDIO_AUTH_DELEGATION_TIMEOUT_MS = 60_000;

// Budget legs of the wait_for_completion OAuth path. The desktop host bounds the
// WHOLE handleAuthenticate call with AUTHENTICATE_TOOL_TIMEOUT_MS (app repo:
// src/main/services/mcpService.ts) — if you change any constant here, or
// FINISH_AUTH_TIMEOUT_MS / CONNECT_TIMEOUT_MS / LIST_TOOLS_TIMEOUT_MS in
// ../clients/httpClient.ts, or REGISTRY_CONNECT_ATTEMPTS in ../registry.ts, the
// desktop constant and src/handlers/__tests__/oauthBudgetInvariant.test.ts must
// move with it. The pre-check leg is branch-aware: registry.getClient() may
// health-check a cached client (LIST_TOOLS_TIMEOUT_MS) and reconnect with one
// retry (REGISTRY_CONNECT_ATTEMPTS × CONNECT_TIMEOUT_MS) BEFORE the handler's
// own health check + listTools race below.
// 5 minutes — OAuth flows can take time (login, 2FA, permissions review,
// workspace selection).
export const OAUTH_CALLBACK_TIMEOUT_MS = 300_000;
export const HEALTH_CHECK_TIMEOUT_MS = 20_000;

// Bounded port retry on classified authorize-probe rejections (REBEL-7F9
// Stage 3). Rejected attempts die at the probe (≤ AUTHORIZE_PROBE_TIMEOUT_MS),
// so the retry legs are cheap; the 300s callback wait applies exactly ONCE
// (accepted attempt or browser-floor attempt — recall#2 F4). The grown budget
// invariant (oauthBudgetInvariant.test.ts) sums (MAX_PORT_ATTEMPTS - 1) fast
// retry legs + one full attempt against the desktop's
// AUTHENTICATE_TOOL_TIMEOUT_MS.
export const MAX_PORT_ATTEMPTS = 3;

// Outcome of one retry-loop attempt. "response" is terminal (success or a
// classified error); "rejected" is a classified authorize-probe rejection
// (advance the port); "pending" is today's non-fatal fall-through (callback
// wait ended without a code, e.g. the 300s timeout — the bottom of
// handleAuthenticate reports auth_required for it).
type AttemptOutcome =
  | { kind: "response"; response: any }
  | { kind: "rejected"; verdict: AuthorizeProbeVerdict; httpClient: any }
  | { kind: "pending"; httpClient: any };

// Defaults for the pre-check listTools race (env override:
// SUPER_MCP_LIST_TOOLS_TIMEOUT_MS). Windows needs a longer default because of
// antivirus/firewall checks on cold-start; the Windows value is the worst case
// the OAuth budget invariant sums.
export const PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS = 30_000;
export const PRE_CHECK_LIST_TOOLS_TIMEOUT_DEFAULT_MS = 10_000;

type AuthDelegationToolCandidate = {
  name?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
};

type NamedAuthDelegationToolCandidate = AuthDelegationToolCandidate & { name: string };

function getInputSchema(tool: AuthDelegationToolCandidate): unknown {
  return tool.inputSchema ?? tool.input_schema;
}

function getRequiredArguments(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return undefined;
  }

  return (inputSchema as { required?: unknown }).required;
}

export function isEligibleForZeroArgAuthDelegation(
  tool: AuthDelegationToolCandidate,
): tool is NamedAuthDelegationToolCandidate {
  if (typeof tool.name !== "string") {
    return false;
  }

  if (tool.name !== "authenticate" && !tool.name.startsWith("authenticate_")) {
    return false;
  }

  // Eligible only if the tool can actually be invoked with `{}`. Answer that by
  // validating an empty arg object against the tool's own input schema using the
  // same Ajv validator Super-MCP enforces at call time — so this catches not just
  // top-level `required`, but `$ref` / `anyOf` / `oneOf` / `allOf` / `minProperties`
  // shapes where `{}` is invalid WITHOUT a top-level `required`. No schema → no
  // constraints → eligible. A malformed/uncompilable schema → ineligible (fail closed).
  const schema = getInputSchema(tool);
  if (schema === undefined || schema === null) {
    return true;
  }
  try {
    return getValidator().validate(schema, {}).valid;
  } catch {
    return false;
  }
}

function requiredArgsForMessage(tool: AuthDelegationToolCandidate): string[] {
  const required = getRequiredArguments(getInputSchema(tool));
  if (!Array.isArray(required)) {
    return [];
  }

  return required.filter((arg): arg is string => typeof arg === "string");
}

export async function handleAuthenticate(
  input: { package_id: string; wait_for_completion?: boolean; force?: boolean },
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  let { package_id, wait_for_completion = true, force = false } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  wait_for_completion = coerceStringifiedBoolean(wait_for_completion, {
    handler: "authenticate",
    field: "wait_for_completion",
  }) as typeof wait_for_completion;
  force = coerceStringifiedBoolean(force, { handler: "authenticate", field: "force" }) as typeof force;
  
  logger.info("=== AUTHENTICATE START ===", { 
    package_id,
    wait_for_completion,
    force,
    timestamp: new Date().toISOString(),
  });
  
  const pkg = registry.getPackage(package_id);
  if (!pkg) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            error: "Package not found",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }

  if (pkg.transport === "http" && pkg.oauth === true && wait_for_completion === false) {
    wait_for_completion = true;
    logger.warn("OAuth package received wait_for_completion:false — coerced to true; saveless callback path is unsafe for OAuth", {
      package_id,
    });
  }
  
  if (pkg.transport === "stdio") {
    try {
      const client = await registry.getClient(package_id);
      const tools = await client.listTools();
      const authTools = tools.filter(
        (t: AuthDelegationToolCandidate): t is NamedAuthDelegationToolCandidate =>
          typeof t?.name === "string" &&
          (t.name === "authenticate" || t.name.startsWith("authenticate_")),
      );
      const authTool = authTools.find(isEligibleForZeroArgAuthDelegation);

      if (!authTool && authTools.length > 0) {
        const ineligibleTools = authTools.map((tool) => ({
          tool: tool.name,
          required: requiredArgsForMessage(tool),
        }));
        logger.warn("Stdio auth tools require arguments; refusing zero-arg generic delegation", {
          package_id,
          tools: ineligibleTools,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                error:
                  "This connector's authentication tool needs additional information, so Rebel cannot start it automatically. Please reconnect this connector from Settings.",
                ineligible_auth_tools: ineligibleTools,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      if (authTool) {
        logger.info("Delegating to stdio package's auth tool", {
          package_id,
          tool: authTool.name,
        });
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Delegated stdio auth tool timed out after ${STDIO_AUTH_DELEGATION_TIMEOUT_MS}ms`,
              ),
            );
          }, STDIO_AUTH_DELEGATION_TIMEOUT_MS);
        });

        try {
          return await Promise.race([
            client.callTool(authTool.name, {}),
            timeoutPromise,
          ]);
        } catch (err) {
          const error = formatError(err);
          const timedOut =
            typeof error === "string" &&
            error.includes(
              `timed out after ${STDIO_AUTH_DELEGATION_TIMEOUT_MS}ms`,
            );

          logger.warn(
            timedOut
              ? "Delegated stdio auth tool timed out"
              : "Failed to delegate to stdio auth tool",
            {
              package_id,
              tool: authTool.name,
              error,
            },
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  error: `Authentication delegation failed: ${error}`,
                  delegated_tool: authTool.name,
                }, null, 2),
              },
            ],
            isError: true,
          };
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to delegate to stdio auth tool, falling back to legacy response", {
        package_id,
        error: formatError(err),
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "success",
            message: "Package does not expose an authentication tool — no action needed.",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
  
  if (force) {
    logger.info("Force re-auth requested, skipping health check", { package_id });
    
    // Close and remove existing client to release resources
    const clients = (registry as any).clients as Map<string, any>;
    const existingClient = clients.get(package_id);
    if (existingClient) {
      try {
        await existingClient.close();
      } catch (err) {
        logger.debug("Error closing existing client during force re-auth", {
          package_id,
          error: formatError(err),
        });
      }
      clients.delete(package_id);
    }
    
    // Invalidate stored OAuth tokens so the new flow starts fresh.
    // Port is irrelevant for credential invalidation (operates on files by package_id).
    try {
      const tempProvider = new SimpleOAuthProvider(package_id, 5173);
      await tempProvider.initialize();
      await tempProvider.invalidateCredentials('all');
      logger.info("Invalidated stored OAuth credentials", { package_id });
    } catch (err) {
      logger.debug("No stored credentials to invalidate", {
        package_id,
        error: formatError(err),
      });
    }
    
    catalog.clearPackage(package_id);
  }
  
  if (!force) {
  try {
    logger.info("Checking if already authenticated", { package_id });
    const client = await registry.getClient(package_id);
    const health = client.healthCheck ? await client.healthCheck() : "ok";
    logger.info("Client health check", { package_id, health });
    
    if (health === "ok") {
      try {
        logger.info("Testing tool access", { package_id });
        // Timeout to prevent hanging on slow/unresponsive MCP servers
        // Windows needs longer timeout due to antivirus/firewall checks on cold-start
        const isWindows = process.platform === 'win32';
        const defaultTimeoutMs = isWindows
          ? PRE_CHECK_LIST_TOOLS_TIMEOUT_WINDOWS_MS
          : PRE_CHECK_LIST_TOOLS_TIMEOUT_DEFAULT_MS;
        const timeoutMs = Number(process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS) || defaultTimeoutMs;
        const toolsPromise = client.listTools();
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`listTools timed out after ${timeoutMs}ms`)), timeoutMs)
        );
        const tools = await Promise.race([toolsPromise, timeoutPromise]);
        logger.info("Tools accessible", { package_id, tool_count: tools.length });
        catalog.clearPackage(package_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "already_authenticated",
                message: "Package is already authenticated and connected",
              }, null, 2),
            },
          ],
          isError: false,
        };
      } catch (error) {
        logger.info("Tool access failed, need to authenticate", { 
          package_id,
          error: formatError(error),
        });
      }
    }
  } catch (error) {
    logger.info("Client not available or errored", { 
      package_id,
      error: formatError(error),
    });
  }
  } // end if (!force)
  
  try {
    // Static credentials from config (for servers without DCR like Asana V2).
    // Computed BEFORE port selection: static-cred connectors keep the linear
    // 5173-first candidate order (their redirect_uri is pinned in a vendor
    // dashboard, so probing alternate ports is futile).
    const staticCreds = pkg.oauthClientId
      ? { clientId: pkg.oauthClientId, clientSecret: pkg.oauthClientSecret }
      : undefined;

    const clients = (registry as any).clients as Map<string, any>;

    // Kill-switch (confirm#F5): with the probe disabled the retry loop
    // collapses to a single attempt, no classified rejection is acted on, and
    // per-attempt invalidation/re-DCR provably does not fire — the disabled
    // path is byte-identical to the pre-probe flow (asserted by the n=1
    // branch of the budget invariant).
    const probeDisabled = isAuthorizeProbeDisabled();
    if (probeDisabled) {
      logger.info("OAuth authorize probe disabled via SUPER_MCP_OAUTH_PROBE_DISABLE; single-attempt legacy flow", {
        package_id,
      });
    }
    const maxAttempts = probeDisabled ? 1 : MAX_PORT_ATTEMPTS;

    // Saved-port reuse is resolved ONCE: attempt 1 reuses the saved port when
    // free. Retry candidates are [8080, 5173…5182] deduped minus failed ports
    // REGARDLESS of how attempt 1 chose its port (recall#2 F3 — the reported
    // user's saved facade client sits at 5173; attempt 2 must be 8080).
    const savedPort = wait_for_completion
      ? await SimpleOAuthProvider.getSavedClientPort(package_id)
      : undefined;

    const failedPorts: number[] = [];
    let firstRejection: { port: number; verdict: AuthorizeProbeVerdict } | undefined;
    let httpClient: any;

    // One retry-loop attempt. Per-attempt isolation contract (recall#1 F2 +
    // confirm#F2): (a) a rejected attempt invalidates its saved client
    // registration (THE port-advancement mechanism — forces re-DCR with new
    // redirect_uris at real-DCR vendors; ≤2 orphan registrations, only on
    // classified rejection); (b) the attempt's callback server is
    // stopped+awaited in the finally; (c) fresh oauthState + PKCE via the
    // fresh provider; (d) losing-promise rejections suppressed; (e)
    // clients.delete per attempt (clients.set on success); (f) the rejected
    // attempt's httpClient is closed; (h) a FRESH SimpleOAuthProvider per
    // attempt (the synthetic savedClientInfo redirectToAuthorization assigns
    // must never leak across attempts into Stage 2a's stale rule).
    const runAttempt = async (
      attemptPort: number,
      opts: { skipProbe: boolean },
    ): Promise<AttemptOutcome> => {
      // (e)
      clients.delete(package_id);

      const { OAuthCallbackServer } = await import("../auth/callbackServer.js");
      const callbackServer = new OAuthCallbackServer(attemptPort);
      callbackServer.setServiceId(package_id);

      // (h) fresh provider per attempt
      const oauthProvider = new SimpleOAuthProvider(package_id, attemptPort, staticCreds);
      await oauthProvider.initialize();
      oauthProvider.setSkipAuthorizeProbe(opts.skipProbe);

      // Stage 2a staleness gate (explicit authenticate path only): invalidate
      // a stale DCR registration before it can trap the flow on one port.
      const invalidated = await oauthProvider.checkAndInvalidateOnPortMismatch();
      if (invalidated) {
        logger.info("OAuth credentials invalidated due to port mismatch, will re-register", {
          package_id,
          oauth_port: attemptPort
        });
      }

      // (c) fresh state (PKCE verifier is saved by the SDK per attempt)
      const oauthState = await oauthProvider.state();
      logger.info("OAuth state generated for CSRF protection", {
        package_id,
        state_length: oauthState.length
      });

      try {
        await callbackServer.start();
        logger.info("OAuth callback server started", { package_id, oauth_port: attemptPort });

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error("Failed to start callback server", {
          package_id,
          error: formatError(error)
        });

        return {
          kind: "response",
          response: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  message: "Failed to start OAuth callback server",
                  error: formatError(error),
                }, null, 2),
              },
            ],
            isError: false,
          },
        };
      }

      logger.info("Creating HTTP client with OAuth enabled", { package_id, oauth_port: attemptPort });
      const { HttpMcpClient } = await import("../clients/httpClient.js");
      const attemptHttpClient = new HttpMcpClient(package_id, pkg, {
        oauthPort: attemptPort,
        oauthProvider  // Pass pre-configured provider with state already generated
      });

      logger.info("Triggering OAuth connection", { package_id });

      const connectPromise = attemptHttpClient.connectWithOAuth();

      logger.info("Waiting for OAuth callback", { package_id });

      // Hoisted so both the success path and the catch can suppress the
      // losing promise after the race settles (d).
      let callbackPromise: Promise<string> | undefined;
      let fatalConnectErrorPromise: Promise<string> | undefined;
      try {
        // Wait for callback with state validation for CSRF protection.
        // Outer bound: the desktop host budgets this whole call (callback wait +
        // finishOAuth token exchange + reconnect + health check) with
        // AUTHENTICATE_TOOL_TIMEOUT_MS in src/main/services/mcpService.ts —
        // that constant must strictly exceed the sum of these inner legs.
        // The 300s callback wait applies exactly ONCE per authenticate call —
        // to this accepted (or browser-floor) attempt (recall#2 F4).
        callbackPromise = callbackServer.waitForCallback(OAUTH_CALLBACK_TIMEOUT_MS, oauthState);

        // Create a promise that rejects early if connectWithOAuth fails with a fatal error.
        // Without this, a DCR failure or connect timeout would silently fail and the callback
        // server would wait the full 5 minutes for a browser redirect that will never arrive.
        fatalConnectErrorPromise = new Promise<string>((_, reject) => {
          connectPromise.catch(err => {
            // Code-based fatal branch (recall#2 F2(b)): a classified
            // pre-browser probe rejection. Classified by MACHINE CODE — the
            // message-based classifier below must never see it (its
            // vocabulary is deliberately non-auth-like, and message fidelity
            // through SDK re-wrapping is not relied on: the provider's
            // out-of-band verdict channel is the primary signal, consumed in
            // the catch below).
            if ((err as { code?: unknown } | null)?.code === OAUTH_REDIRECT_URI_REJECTED_CODE) {
              reject(err);
              return;
            }
            const errMsg = formatError(err);
            const isFatalAuthError = typeof errMsg === 'string' && (
              errMsg.includes("does not support dynamic client registration") ||
              errMsg.includes("Incompatible auth server") ||
              /timed?\s*out|timeout/i.test(errMsg) ||
              errMsg.includes("client registration failed")
            );

            if (isFatalAuthError) {
              logger.error("OAuth failed with fatal error, aborting callback wait", {
                package_id,
                error: errMsg,
              });
              reject(new Error(`OAuth setup failed: ${errMsg}`));
            } else {
              logger.debug("OAuth redirect initiated (expected)", {
                package_id,
                error: errMsg,
              });
              // Non-fatal errors (e.g., redirect initiated) — don't abort the callback wait
            }
          });
        });

        const authCode = await Promise.race([callbackPromise, fatalConnectErrorPromise]);
        // Suppress unhandled rejection from the losing promise after the race settles (d)
        callbackPromise.catch(() => {});
        fatalConnectErrorPromise.catch(() => {});
        logger.info("OAuth callback received", { package_id, has_code: !!authCode });

        logger.info("Exchanging authorization code for tokens", { package_id });
        await attemptHttpClient.finishOAuth(authCode);

        logger.info("OAuth flow completed, verifying connection", { package_id });

        clients.set(package_id, attemptHttpClient);

        let health: "ok" | "error" | "needs_auth" | "timeout" = "timeout";
        try {
          const healthPromise = attemptHttpClient.healthCheck ? attemptHttpClient.healthCheck() : Promise.resolve("ok" as const);
          const timeoutPromise = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), HEALTH_CHECK_TIMEOUT_MS)
          );
          health = await Promise.race([healthPromise, timeoutPromise]);
        } catch (err) {
          logger.warn("Connection verification failed - tokens saved but server rejected request. Try using a tool to confirm.", {
            package_id,
            error: formatError(err)
          });
          health = "error";
        }

        if (health === "ok") {
          logger.info("Authentication verified successfully", { package_id });
          catalog.clearPackage(package_id);
          return {
            kind: "response",
            response: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "authenticated",
                    message: "Successfully authenticated and verified. Ready to use.",
                  }, null, 2),
                },
              ],
              isError: false,
            },
          };
        } else if (health === "timeout") {
          logger.info("Authentication completed, verification pending (slow server)", { package_id });
          catalog.clearPackage(package_id);
          return {
            kind: "response",
            response: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "authenticated",
                    message: "Successfully authenticated. The server was slow to respond, so full verification will happen on first tool use. Try using a tool to confirm everything works.",
                  }, null, 2),
                },
              ],
              isError: false,
            },
          };
        } else {
          logger.error("Authentication verification failed", { package_id, health });
          return {
            kind: "response",
            response: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "error",
                    message: `Authentication completed but verification failed (${health}). The OAuth tokens were saved, but the server rejected the connection. Try using a tool - if it fails, you may need to re-authenticate.`,
                  }, null, 2),
                },
              ],
              isError: true,
            },
          };
        }
      } catch (error) {
        // (d) suppress the losing promise's late rejection
        callbackPromise?.catch(() => {});
        fatalConnectErrorPromise?.catch(() => {});
        connectPromise.catch(() => {});

        const errMsg = formatError(error);
        // Primary classification signal (recall#2 F2(a)): the provider's
        // out-of-band probe verdict channel — DISTINCT from the consume-once
        // lastOAuthError slot, so the invalidation in step (a) below cannot
        // drain it first. The machine code on the error is belt-and-braces.
        const probeVerdict = oauthProvider.consumeProbeVerdict();
        const isRedirectUriRejected =
          !probeDisabled &&
          (probeVerdict?.outcome === "rejected" ||
            (error as { code?: unknown } | null)?.code === OAUTH_REDIRECT_URI_REJECTED_CODE);

        if (isRedirectUriRejected) {
          logger.warn("Authorize probe classified a redirect_uri rejection; advancing port candidate", {
            package_id,
            oauth_port: attemptPort,
            matched_phrase: probeVerdict?.matchedPhrase,
          });
          // (a) port advancement: invalidate the attempt's saved client
          // registration so the next attempt re-registers with the new
          // redirect_uris (real-DCR vendors) and the saved-port trap clears.
          // Static-cred connectors NEVER invalidate (simple.ts:905-916
          // hazard) — the loop returns their fast coded error instead.
          if (!staticCreds) {
            await oauthProvider.invalidateCredentials("client");
          }
          // (f) close the attempt's client
          try {
            await attemptHttpClient.close();
          } catch (closeError) {
            logger.debug("Error closing rejected attempt's client", {
              package_id,
              error: formatError(closeError),
            });
          }
          return {
            kind: "rejected",
            verdict: probeVerdict ?? { outcome: "rejected" },
            httpClient: attemptHttpClient,
          };
        }

        // finishAuth timeout: classified by machine code, NOT message text
        // (audit F1 — the message-only rejection was swallowed as non-fatal and
        // misreported as "auth_required").
        const isFinishAuthTimeout =
          (error as { code?: unknown } | null)?.code === OAUTH_FINISH_AUTH_TIMEOUT_CODE;
        const isFatalSetupError = typeof errMsg === 'string' && errMsg.startsWith('OAuth setup failed:');

        logger.error("OAuth failed", {
          package_id,
          error: errMsg,
          isFatalSetupError,
          isFinishAuthTimeout,
        });

        // The user completed sign-in but the token exchange hung past its
        // bound. This is a terminal outcome for this attempt — report it
        // honestly instead of falling through to the pending
        // "check browser for OAuth prompt" response the desktop can't act on.
        if (isFinishAuthTimeout) {
          // Desktop (mcpService.ts) displays `parsed.error` first and only
          // falls back to `parsed.message`, so the friendly copy must live in
          // `error` and the raw internal detail in `message`. Inverted from the
          // sibling `isFatalSetupError` branch (audit F1 / Stage 7 review F1:
          // the raw "OAuth token exchange timed out after 30000ms" is jargon the
          // user would see instead of plain-language copy).
          return {
            kind: "response",
            response: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "error",
                    error: "The sign-in took too long, so we stopped waiting. Please try connecting again.",
                    message: errMsg,
                  }, null, 2),
                },
              ],
              isError: false,
            },
          };
        }

        // If this was a fatal setup error (DCR failure, connect timeout), return an
        // actionable error immediately instead of falling through to the generic
        // "check browser for OAuth prompt" message.
        if (isFatalSetupError) {
          return {
            kind: "response",
            response: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "error",
                    error: errMsg,
                    message: "This connector's OAuth setup failed. It may require manual configuration (API key or pre-registered client credentials) instead of automatic sign-in.",
                  }, null, 2),
                },
              ],
              isError: false,
            },
          };
        }

        // Non-fatal (e.g. the 300s callback wait elapsed): today's fall-through
        // to the bottom health probe → auth_required.
        return { kind: "pending", httpClient: attemptHttpClient };
      } finally {
        // (b) stop+await the attempt's callback server — no leaked listeners
        try {
          await callbackServer.stop();
          logger.info("OAuth callback server stopped", { package_id });
        } catch (err) {
          logger.debug("Error stopping callback server", {
            package_id,
            error: formatError(err)
          });
        }
      }
    };

    if (wait_for_completion) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let attemptPort: number;
        let savedPortReused = false;

        if (attempt === 1) {
          try {
            // Part A: reuse the saved OAuth port if available.
            if (savedPort && (await checkPortAvailable(savedPort))) {
              attemptPort = savedPort;
              savedPortReused = true;
              logger.info("Reusing saved OAuth port", { package_id, oauth_port: attemptPort });
            } else {
              if (savedPort) {
                logger.info("Saved OAuth port busy, finding new port", {
                  package_id,
                  saved_port: savedPort,
                  message: "Client registration will be invalidated if mismatch"
                });
              }
              // Fresh registration: ordered candidate sequence — [5173, 8080,
              // 5174, …5182] for non-static-cred connectors (attempt 1 identical
              // to the historical scan; strict allow-list vendors self-correct on
              // attempt 2, REBEL-7F9 Stage 2b).
              attemptPort = await findAvailablePortFromCandidates(
                getOAuthCallbackPortCandidates({ staticCredentials: !!staticCreds })
              );
              logger.info("Found available OAuth port", { package_id, oauth_port: attemptPort });
            }
          } catch (portError) {
            logger.error("Failed to find available port", {
              package_id,
              error: formatError(portError)
            });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "error",
                    message: "Failed to find available port for OAuth callback",
                    error: formatError(portError),
                  }, null, 2),
                },
              ],
              isError: false,
            };
          }
        } else {
          // Retry candidates: [8080, 5173…5182] deduped minus already-failed
          // ports, regardless of attempt-1's port (recall#2 F3).
          const retryCandidates: number[] = [];
          const seen = new Set<number>();
          for (let p = OAUTH_CALLBACK_DEFAULT_PORT; p <= OAUTH_CALLBACK_PORT_SCAN_END; p++) {
            seen.add(p);
          }
          seen.add(OAUTH_CALLBACK_VENDOR_COMMON_PORT);
          const ordered = [OAUTH_CALLBACK_VENDOR_COMMON_PORT, ...[...seen].sort((a, b) => a - b).filter(p => p !== OAUTH_CALLBACK_VENDOR_COMMON_PORT)];
          for (const candidate of ordered) {
            if (!failedPorts.includes(candidate)) {
              retryCandidates.push(candidate);
            }
          }
          try {
            attemptPort = await findAvailablePortFromCandidates(retryCandidates);
          } catch (portError) {
            logger.error("Failed to find available port for retry attempt", {
              package_id,
              attempt,
              failed_ports: failedPorts,
              error: formatError(portError)
            });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    package_id,
                    status: "error",
                    message: "Failed to find available port for OAuth callback",
                    error: formatError(portError),
                  }, null, 2),
                },
              ],
              isError: false,
            };
          }
          logger.info("Retrying OAuth on next port candidate after classified rejection", {
            package_id,
            attempt,
            oauth_port: attemptPort,
            failed_ports: failedPorts,
          });
        }

        // Probe-skip predicate (confirm#F6): saved-port reuse WITH a prior
        // successful token exchange (parseable access_token in
        // <packageId>_tokens.json) skips the probe. The REBEL-7F9 reporter's
        // saved 5173 has no such file → their probe still runs.
        const skipProbe =
          savedPortReused && (await SimpleOAuthProvider.hasPersistedAccessToken(package_id));

        const outcome = await runAttempt(attemptPort, { skipProbe });

        if (outcome.kind === "response") {
          return outcome.response;
        }
        if (outcome.kind === "pending") {
          httpClient = outcome.httpClient;
          break;
        }

        // Classified rejection.
        failedPorts.push(attemptPort);
        if (!firstRejection) {
          firstRejection = { port: attemptPort, verdict: outcome.verdict };
        }

        if (staticCreds) {
          // Static-cred rule (recall F4): fast coded error, NO port advance,
          // NO token invalidation — their redirect_uri is pinned out-of-band
          // in a vendor dashboard, so retrying other ports is futile and
          // invalidating would delete WORKING tokens.
          logger.error("Static-credential connector rejected by provider's sign-in page", {
            package_id,
            oauth_port: attemptPort,
            matched_phrase: outcome.verdict.matchedPhrase,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  code: OAUTH_REDIRECT_URI_REJECTED_CODE,
                  error: "This provider's sign-in page rejected the connection's registered callback address before the browser even opened. The provider's app registration doesn't allow this app's callback URL — this needs a fix on the provider's side.",
                  message: outcome.verdict.matchedPhrase
                    ? `Pre-browser probe verdict: ${outcome.verdict.matchedPhrase}`
                    : "Pre-browser probe classified the provider's sign-in page as rejecting this connection's callback address.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        }
      }

      // Browser-open floor (recall#2 F1(b)): every candidate was classified-
      // rejected, so do NOT fail terminally — open the browser on the first
      // classified-rejection candidate and run today's callback wait. This
      // degrades to exactly today's behavior (the vendor's error page shows;
      // honest timeout copy follows) and is never worse than today.
      if (!httpClient && firstRejection) {
        logger.warn("All OAuth port candidates classified-rejected; opening browser on first candidate (floor)", {
          package_id,
          oauth_port: firstRejection.port,
          failed_ports: failedPorts,
        });
        const floorOutcome = await runAttempt(firstRejection.port, { skipProbe: true });
        if (floorOutcome.kind === "response") {
          return floorOutcome.response;
        }
        // A floor attempt skips the probe, so "rejected" is unreachable in
        // real code; defensively treat it as pending with its client.
        httpClient = floorOutcome.httpClient;
      }
    } else {
      // Non-wait path (non-OAuth HTTP connectors): unchanged fire-and-forget.
      const oauthPort = 5173;
      clients.delete(package_id);

      logger.info("Creating HTTP client with OAuth enabled", { package_id, oauth_port: oauthPort });
      const { HttpMcpClient } = await import("../clients/httpClient.js");
      httpClient = new HttpMcpClient(package_id, pkg, {
        oauthPort,
        oauthProvider: undefined,
      });

      logger.info("Triggering OAuth connection", { package_id });

      const connectPromise = httpClient.connectWithOAuth();
      connectPromise.catch((err: unknown) => {
        logger.debug("OAuth connection error (expected)", {
          package_id,
          error: formatError(err)
        });
      });
    }

    clients.set(package_id, httpClient);
    
    const health = httpClient.healthCheck ? await httpClient.healthCheck() : "needs_auth";
    
    if (health === "ok") {
      catalog.clearPackage(package_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "authenticated",
              message: "Successfully authenticated",
            }, null, 2),
          },
        ],
        isError: false,
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "auth_required",
              message: "Authentication required - check browser for OAuth prompt",
            }, null, 2),
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    logger.error("Authentication failed", {
      package_id,
      error: formatError(error),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            message: "Authentication failed",
            error: formatError(error),
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
}
