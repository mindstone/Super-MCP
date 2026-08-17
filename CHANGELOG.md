# Changelog

All notable changes to Super MCP Router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

> Shipped to Rebel from submodule source (the app bundles super-mcp at build time), so these changes are live without an npm release. The package version stays at **2.7.6**; the next npm publish folds this section into a version heading.

### Added
- **Tool notes let agents save one short lesson for future tool use.** `record_tool_note` stores or replaces a mechanically bounded 200-character note for an exact package/tool pair. Notes expire within 30 days, stop surfacing when the tool schema changes, and appear only in that tool's `get_tool_details` response with an untrusted-advisory notice.

### Fixed
- **A misplaced `dry_run` / `result_id` nested inside `args` can no longer silently run the real action.** `use_tool` takes these two as **top-level** parameters (siblings of `args`), and a model that nests one is making a call-shape mistake. Previously the router only taught that mistake when the tool's own JSON Schema would strip the unknown key; on a permissive schema (`additionalProperties`, or no declared `properties` at all) the nested key validated clean and the call **dispatched** — so a model that asked to "dry run" a tool got the real, unreverted action, with nothing but a log warning to show for it. The gate is now keyed on **declared properties** rather than stripping behaviour: at a new unconditional post-validation seam (after auto-repair, before the `dry_run` short-circuit and before dispatch), any of the soft pair present in the effective args and *not* declared by the schema throws `-33003` with a misplacement repair ticket naming the exact corrected call shape, and is never dispatched. A tool that genuinely declares `dry_run` or `result_id` as its own parameter passes through unchanged (the declare-it escape hatch).
- **A canonical-form twin of a nested soft meta-param is now renamed before dispatch, not forwarded verbatim.** A tool declaring `dryRun` legitimises a nested `dry_run`, so the gate must not reject that call — but merely *exempting* it re-opened the same hole one layer down: on a permissive schema the nested `dry_run` validates clean, so the auto-repair pass that would have renamed it never runs, and the tool received a key it does not declare, ignored it, kept its own `dryRun` default of `false`, and mutated for real. The gate now performs the rename itself (`dry_run` → declared `dryRun`, `result_id` → declared `resultId`), records an `auto_repair_key:` breadcrumb, and logs it. Whichever the model meant — the tool's own parameter or `use_tool`'s dry run — the result is safe. The rename is applied only when intent is unambiguous: exactly one declared property shares the canonical form and the declared spelling is not already carrying a value; otherwise the call gets the misplacement ticket rather than a guess. The three hard-rejected meta-params (`max_output_chars`, `output_offset`, `schema_hash`) are unaffected — they stay envelope-layer-only, including their top-level-twin escape hatch.
- **A canonical-twin rename is now re-validated before dispatch, so a mistyped twin is taught instead of sent.** The rename above fixes the *spelling* of a nested soft meta-param (`dry_run` → declared `dryRun`); it cannot prove the *value*. A call nesting `result_id: 42` against a tool declaring `resultId: {type: "string"}` was renamed into a type-invalid `{resultId: 42}` and dispatched anyway — on a permissive schema the pre-rename validation passed clean, so nothing downstream of the gate could catch it, and the call failed later, differently, and unhelpfully. The seam now applies **all** renames to a single clone, re-validates it against the tool's schema, and adopts it only if it passes cleanly (`valid` and nothing stripped — the same accept condition as the auto-repair pass). If it does not, `args` is left exactly as the model sent it (all renames rolled back together, so the ticket never echoes a key the caller never wrote) and the affected params are taught through the existing `-33003` misplacement ticket — now carrying the re-validation's schema errors, so the ticket names the **declared property and its expected type** rather than only "move it outside `args`", which is the wrong correction for a type mismatch. One validation-attempt increment per call, unchanged.
  - **Model-visible behaviour change:** a call that previously dispatched can now surface as `-33003`. Beyond the type-mismatch case above, this covers renamed shapes that the schema rejects for structural reasons — notably **exotic schemas** (`oneOf` / `anyOf` / `patternProperties`), where introducing the declared spelling can select or violate a different branch. In every such case the previous behaviour was a type- or shape-invalid dispatch, so the new failure is the earlier, better-taught one.
- **A repair ticket for a mixed call no longer echoes a renamed key the model never sent.** When one nested soft meta-param is a decidable twin (`dry_run` against a declared `dryRun`) and another is a genuine misplacement (`result_id`), the call fails either way — but the rename was committed first, so the `-33003` ticket's `provided_args` listed `dryRun`, a key the caller never wrote, and a rename breadcrumb plus info log were emitted for a call that never dispatched. Renames are now attempted only when nothing else is already headed for the misplacement ticket, so the ticket always mirrors the model's own call shape (the same accuracy rule as the all-or-nothing rollback above, applied to an independent misplacement). The twin itself is still not taught as misplaced: once the model moves `result_id` to the top level, the retry renames and dispatches as before.
- **The generic "use `dry_run` to preview" advice suffix is no longer appended to misplacement errors.** `appendErrorAdvice` suppressed it only for dispatch-stage failures, so a validation-stage repair ticket that had just taught the model where `dry_run` belongs was followed by boilerplate suggesting it use `dry_run` — contradictory advice on the one error where the model was already being told the answer. Suppression is now keyed on the ticket carrying a misplacement (any stage).

### Changed
- **The meta-param name-collision warning fires once per tool+param instead of on every call.** It exists to flag a tool whose schema legitimately declares a property named like a `use_tool` meta-param (in which case the misplacement teaching would be wrong for that tool); on a hot tool it re-emitted per call and buried its own signal.
- **That collision warning now also covers canonical-form twins.** A tool declaring `dryRun` against a nested `dry_run` is not a literal name collision, but it is the path that now gets renamed before dispatch — so it gets its own distinct warning (naming the declared property) rather than passing unobserved.

### Testing
- **Pinned the composed-schema (`oneOf`) twin behaviour on both sides**, since a composed schema skips the validator's `additionalProperties: false` injection and leaves the gate as the only check before dispatch: a well-typed twin on a `oneOf` schema still renames and dispatches (`{query, dry_run}` → `{query, dryRun}`, so the injection skip plus branch selection cannot turn a working call into a `-33003`), while a schema whose branches are mutually exclusive — where introducing the declared spelling flips branch membership — fails loudly with the teaching ticket and the model's own keys echoed back. That over-fire is the designed behaviour, now pinned rather than merely documented.
- **Pinned the hard-param canonical-twin arm** of the collision warning: a tool declaring `maxOutputChars` against a call nesting `max_output_chars` (with the top-level twin present — the envelope guard's escape hatch) both emits the twin warning naming `maxOutputChars` **and** still dispatches the nested key **verbatim**. Hard meta-params are never renamed; their escape hatch is the top-level twin, not a schema declaration. The assertion exists so a future scoping tidy-up cannot silently narrow away either half — the deferred residue items are conditioned on that signal.

### Removed
- **`schemaStripsUnknownArgs` and its drift-pin suite**, dead once the misplacement gate stopped asking whether the validator would strip an unknown key. It had duplicated `validator.ts`'s stripping semantics and needed a pin suite to keep the two in sync.
- **The non-stripping-schema passthrough warning** (the "warn (ii)" companion to the collision warning). For the soft pair the passthrough it detected is now structurally impossible — the gate throws instead of dispatching.

## [2.7.3] - 2026-07-01

### Fixed
- **A completed browser re-authentication now clears the dead-grant reconnect marker.** When a rotating-refresh grant genuinely dies, super-mcp clears its tokens and writes a `${packageId}_needsReconnect.json` marker (2.7.2) so the host can surface a reconnect prompt. The refresh path cleared that marker on a successful rotation, but the **interactive authorization-code path (`finishOAuth`) did not** — so after a user reconnected via the browser, the marker lingered and the host kept prompting. `finishOAuth` now clears the marker on a successful token exchange (gated on the marker existing, so first-time connects stay a no-op). This is what lets an in-app "Reconnect" visibly resolve the prompt.

### Testing
- Added a high-N (N=6) concurrency **soak** to the rotation-race suite: many processes racing the same seed refresh token converge to exactly one server-side rotation, zero `invalid_grant`, and no reconnect marker on a live grant — extending the existing N=2 FM1 coverage to scale.

## [2.7.2] - 2026-07-01

### Fixed
- **OAuth refresh-token rotation race no longer wedges connectors (Notion / Linear "keeps needing re-authentication").** Providers that issue **single-use, rotating** refresh tokens (Notion rolled this out ~2026-06-04, Linear ~2026-06-22) broke super-mcp's silent hourly refresh: multiple concurrent super-mcp processes share one on-disk token file written **non-atomically with no cross-process lock**, and `tokens()` served a per-process in-memory cache — so two refreshes raced, one rotated the token, the other replayed the now-dead one → `invalid_grant` / "Grant not found". "Refresh-only mode" then refused to discard the dead grant, so the connector stayed wedged until a manual interactive re-auth. The fix makes token refresh a **single transactional chokepoint** in the SDK fetch wrapper, serialized by a **per-package cross-process lock** (`proper-lockfile`, mirroring the app's HubSpot credential-lock semantics) plus an in-process mutex: under the lock it re-reads disk (the source of truth), short-circuits when a peer already minted a still-valid access token (no network POST, no burned single-use token), otherwise refreshes with the freshest disk token and **persists atomically (temp+rename+fsync) under the lock before returning** to the SDK. `tokens()` now reads disk fresh; `saveTokens()` is atomic and guarded against stale-write downgrades (a bounded authoritative-echo set absorbs the SDK's unavoidable second save) and **fails closed** if persisting a freshly-rotated token fails. A genuinely revoked grant is now detected (after a bounded re-read to absorb a peer mid-rotation), cleared, and marked for reconnect with an observable error log — instead of silently wedging. General across all rotating-refresh OAuth connectors (no provider-specific branches).

## [2.7.1] - 2026-06-25

### Fixed
- **Owner-liveness watchdog no longer self-terminates super-mcp on Windows (REBEL-6ED).** The watchdog had duplicated the owner process-start-time probe to guard against PID reuse, but its Windows implementation (`Get-Date -UFormat %s`) returns **local-time** seconds on Windows PowerShell 5.1, not UTC epoch-seconds — so on any non-UTC machine it disagreed with the UTC value the spawning app passes via `--rebel-owner-start` by the machine's UTC offset (hours), far exceeding the 2 s reuse-guard tolerance. The watchdog read this as "PID reused → owner dead" and called `process.exit()` ~30 s after every launch, tearing down super-mcp and all MCP children. The fix is **structural**: the watchdog is now **ESRCH-only** — it treats `process.kill(pid, 0)` success as conclusively alive and only a missing process (ESRCH) as dead. The duplicate start-time probe (`probeProcessStartTimeMs` and its platform helpers) is **deleted**, leaving a single start-time implementation on the app side (`processStartTime.ts`, used by the cross-launch orphan reaper) so the seam-mismatch class cannot recur. Owner start-time is retained only for log correlation.

## [2.7.0] - 2026-06-20

### Added
- **Owner-liveness self-watchdog.** super-mcp now self-exits when its spawning owner (the Rebel app) dies, so it doesn't accumulate as an orphan process. When spawned with `--rebel-owner-pid/--rebel-owner-start/--rebel-owner-id`, it polls owner liveness on a ~15 s interval and gracefully shuts down (closing downstream MCP children) once the owner is confirmed gone. Standalone invocations (no owner flags) are unaffected. (See 2.7.1 for the Windows start-time hardening.)

## [2.6.0] - 2026-06-18

### Added
- **Schema-driven validate-before-send argument auto-repair in `use_tool`**. When a tool call fails validation, `use_tool` now repairs a snapshot of the args against the tool's own JSON schema, re-validates, and only dispatches the repaired call when it passes cleanly (otherwise it falls through to the usual validation-failure result, unchanged). Two conservative, schema-driven repairs: (1) **canonical key normalization** — renames a top-level key to a schema property when their case/separator-insensitive forms match *unambiguously* (exactly one candidate), catching camelCase↔snake_case drift without fuzzy matching; (2) **scalar type coercion** — coerces a stringified scalar (`"20"`→`20`, `"true"`→`true`) only when the property's declared type is exactly numeric/boolean and a string/enum/const is not also accepted, using a strict-integer grammar and a safe-integer guard against lossy id coercion. Every repair is logged and recorded in `_meta.superMcp.normalisations`. True synonyms and nested-target renames stay explicit in `paramAliasMap` — schema shape cannot infer those safely.

### Changed
- **`paramAliasMap` shrunk to the irreducible entries.** Pure casing/separator aliases are now handled generically by the schema-driven normalization above; only true synonyms (e.g. Slack `limit`→`count`) and nested-target renames (e.g. HubSpot `body`→`properties.hs_note_body`) remain as hand-maintained entries.

### Documentation
- **`docs/TIMEOUT_CONFIGURATION.md` and `src/types.ts` JSDoc updated to reflect the 30-minute default**. The default tool execution timeout was raised from 300,000ms (5 minutes) to 1,800,000ms (30 minutes) in commit `035f2fb` (no version bump at the time) to align with Rebel Core's `TOOL_CALL_TIMEOUT`, but the documentation kept claiming 5 minutes. Source of truth lives in `src/clients/stdioClient.ts` and `src/clients/httpClient.ts` as the `'1800000'` env-var fallback.

### Fixed
- **`use_tool` outer `isError` now correctly propagates the wrapped tool's `isError` verdict** (#TBD). Previously, the outer envelope hardcoded `isError: false` on all non-throwing return paths, hiding application-level tool failures from MCP-spec-compliant clients. The fix aligns with the canonical MCP spec (`CallToolResult.isError` reflects tool-level failure, not transport-level success). Clients that drilled into `result.result.isError` as a workaround can now read outer `isError` directly; the workaround still works (body content is unchanged).

## [2.5.0] - 2026-03-28

### Added
- **Progressive disclosure API**: `list_tools` now supports `detail:"lite"|"full"` parameter for controlling response verbosity. `detail:"lite"` returns tool names and descriptions only; `detail:"full"` includes complete schemas
- **get_tool_details meta-tool**: New dedicated tool for fetching full schemas of specific tools before first use, replacing the old `include_schemas`/`name_pattern` pattern
- **Multi-field BM25 weighting**: search_tools now weights name (3x), summary (2x), params (1x) for better relevance

### Changed
- **Error code migration**: Custom error codes moved from -32xxx to -33xxx range to avoid collision with MCP SDK reserved codes (e.g., RequestTimeout = -32001)
- `summarize` and `include_schemas` parameters on `list_tools` are now deprecated (still functional for backward compatibility). Use `detail:"lite"|"full"` instead
- `annotateToolSecurity` refactored to `computeSecurityAnnotation` — shape-agnostic, eliminates duplication across 4 call sites

### Removed
- Dead code: `summarizeTool()` and `categorizeTools()` functions

## [2.4.0] - 2025-12-27

### Added
- **Tool search endpoint**: New `GET /api/tools` REST endpoint for bulk tool export with ETag support for efficient caching
- **search_tools MCP tool**: BM25 keyword search over all available tools, returning relevance scores, schemas, and package info. Enables semantic tool discovery in client applications.

### Changed
- Updated `@modelcontextprotocol/sdk` to 1.25.1 (backwards-compatible spec type adjustments)

## [2.3.0] - 2025-12-22

### Added
- **Package restart tool**: New `restart_package` tool to hot-reload credentials without restarting Super MCP
  - Closes existing client connection and re-expands environment variables from raw config
  - Picks up new `process.env` values for packages using `${VAR}` syntax
  - Handles race conditions: waits for pending connections before restart
  - Next tool call automatically reconnects with fresh configuration
- New `restartPackage()` method on `PackageRegistry` for programmatic package restarts
- New `normalizeServerEntry()` helper for single-package config normalization

### Use Cases
- Update API keys for third-party MCP packages without full server restart
- Refresh OAuth tokens or credentials that have been rotated
- Development workflow: change credentials and immediately test without restart

## [2.2.0] - 2025-12-08

### Changed
- **Layered security model**: Allowlist and blocklist now both apply together
  - Previously: If allowlist was configured, blocklist was ignored
  - Now: Both gates apply - must be on allowlist (if configured) AND not on blocklist (if configured)
  - This enables configurations like "allow only filesystem package, but block delete operations within it"
- Security policy `mode` in logs now shows "layered" when both allowlist and blocklist are configured
- Blocked attempt logs now show which `gate` (allowlist vs blocklist) caused the block

## [2.1.0] - 2025-12-08

### Added
- **Security config hot-reload**: Security policy automatically reloads when config files change
  - No server restart required to update blocked/allowed tools
  - All config files in the chain are watched (including `configPaths` references)
  - Changes debounced (500ms) to handle editor save behavior
  - Fail-safe: if reload fails (invalid JSON), existing policy is kept
- New `chokidar` dependency for robust cross-platform file watching

## [2.0.0] - 2025-12-08

### Added
- **Security policy system**: Block or allow specific tools and packages
  - `blockedTools`: Block specific tools by exact name or regex pattern
  - `blockedPackages`: Block entire packages
  - `allowedTools`: Allowlist mode - only specified tools permitted
  - `allowedPackages`: Allowlist mode - only specified packages permitted
  - `logBlockedAttempts`: Control logging of blocked access attempts
- Pattern matching support: exact strings or regex patterns (`"/.*delete.*/i"`)
- Security status shown in `list_tools` output (blocked tools marked with reason)
- New error code `TOOL_BLOCKED` (-33008) for security policy violations

### Changed
- Major codebase refactoring for improved maintainability
- Handler functions extracted to separate modules
- Improved code organization and separation of concerns

## [1.6.5] - 2025-12-06

### Added
- **Dynamic OAuth port selection**: OAuth callback server now automatically finds an available port
  - Tries ports 5173-5182 in sequence if default port is in use
  - Eliminates "port already in use" errors during concurrent authentication
  - Port is dynamically registered with OAuth providers via MCP's dynamic client registration
- **Port finder utility**: New `findAvailablePort()` function in `src/utils/portFinder.ts`

### Changed
- `OAuthCallbackServer` now accepts port in constructor (default: 5173)
- `HttpMcpClient` now accepts `oauthPort` option for OAuth redirect URL
- `SimpleOAuthProvider` now uses dynamic port for redirect URLs
- `handleAuthenticate` finds available port before starting OAuth flow

### Fixed
- Fixed OAuth failures when port 5173 is already in use by another process
- Fixed concurrent authentication attempts conflicting on the same port

## [1.6.2] - 2025-11-29

### Fixed
- **Critical: HTTP mode process exit bug**: Fixed issue where HTTP server would exit immediately after starting (within 2ms) due to missing `await` on `startServer()` in CLI entry point. This caused all concurrent agent sessions to fall back to stdio mode, resulting in race conditions and tool failures.

## [1.6.0] - 2025-11-27

### Added
- **Output truncation support**: New `max_output_chars` parameter on `use_tool` to prevent context overflow
  - When specified, tool outputs exceeding the limit are truncated with a clear indicator
  - Truncation metadata included in telemetry (`output_truncated`, `original_output_chars`)
- **Large output warnings**: Automatic warning hints when tool outputs exceed 150k characters (~37.5k tokens)
  - Warning suggests using `max_output_chars` parameter to prevent context overflow
  - Enables AI agents to self-recover by retrying with output limits
- **Output size telemetry**: All tool results now include `output_chars` in telemetry for monitoring

### Changed
- `UseToolOutput` telemetry now includes optional fields: `output_chars`, `output_truncated`, `original_output_chars`

## [1.4.0] - 2025-10-08

### Added
- **Configurable tool timeouts**: Support for per-server timeout configuration via `timeout` field
- **Global timeout environment variable**: `SUPER_MCP_TOOL_TIMEOUT` for setting default timeout across all servers
- **Progress-based timeout reset**: Timeouts automatically reset when MCP servers send progress notifications
- **Increased default timeout**: Changed from 60 seconds to 5 minutes (300,000ms) for better support of long-running operations

### Changed
- Default tool execution timeout increased from 60 seconds to 5 minutes
- Tool timeouts now properly passed through to MCP SDK for both stdio and HTTP transports
- Timeout configuration now supports three levels: per-server config > global env var > default (300s)

### Fixed
- Fixed issue where MCP tool calls were timing out at hardcoded 60 seconds regardless of configuration
- Long-running tools (research, data processing, complex queries) can now complete successfully

## [1.3.0] - 2025-01-11

### Added
- **Zero-config setup**: Automatically creates `~/.super-mcp/` directory and config on first run
- **CLI for adding MCPs**: Simple `add` command to add pre-configured MCP servers
- **Empty config support**: Super MCP Router now works with no MCPs configured (minimal mode)
- **Auto-setup**: Creates directories, logs folder, and empty config automatically

### Changed
- **Simplified onboarding**: No manual config creation needed - just add to Claude and restart
- **Default config location**: Now defaults to `~/.super-mcp/config.json` if no config specified
- **Better first-run experience**: Helpful messages guide users on next steps

### Fixed
- Config validation no longer requires at least one server

## [1.2.0] - 2025-01-11

### Added
- **Comprehensive error messaging**: All errors now provide actionable diagnostics and troubleshooting steps
- **Environment variable expansion**: Support for `${VAR}` and `$VAR` syntax in configuration files
- **JSON Schema format validation**: Added support for standard formats (date, date-time, email, etc.) via ajv-formats
- **OAuth token invalidation**: Automatic cleanup of invalid OAuth tokens when "Client ID mismatch" occurs
- **Enhanced health check diagnostics**: Detailed per-package status with suggested actions
- **Improved validation errors**: Clear guidance on missing/incorrect arguments with schema hints

### Changed
- **Security improvement**: Only explicitly configured environment variables are passed to MCP servers (no longer passes entire process.env)
- **Better connection error handling**: Specific diagnostics for command not found, permission denied, and network issues
- **Clearer tool execution errors**: Context-aware error messages based on failure type (timeout, auth, permissions)

### Fixed
- **Notion OAuth browser not opening**: Fixed issue where browser wouldn't open when invalid tokens were present
- **Notion search failures**: Fixed validation errors with date formats in Notion search filters
- **Environment variable security**: Prevented leaking of all system environment variables to MCP servers

### Security
- Environment variables are now isolated per MCP server - each server only receives explicitly configured variables
- Sensitive values (tokens, keys) are never logged in debug output

## [1.1.0] - 2025-01-09

### Added
- Support for multiple configuration files via multiple --config arguments
- Support for comma-separated config paths in SUPER_MCP_CONFIG environment variable
- Automatic merging of servers from multiple config files (duplicates handled gracefully)

### Changed
- Configuration loading now supports both single and multiple file inputs
- Backward compatible - existing single config setups continue to work unchanged

## [1.0.4] - 2025-01-09

### Changed
- Reorganized README to prioritize npx (no-installation) method
- Improved documentation flow to make getting started easier
- Moved installation methods to a dedicated section

## [1.0.3] - 2025-01-09

### Fixed
- Fixed critical stdout pollution issue that broke MCP protocol when using npx
- Logger now correctly outputs to stderr instead of stdout, ensuring clean JSON-RPC communication
- This fix makes npx execution reliable for fresh installations

## [1.0.2] - 2025-01-06

### Added
- Support for new Streamable HTTP transport type (recommended for HTTP servers)
- Support for `cwd` configuration field to specify working directory for server processes
- Improved authentication error messages that guide users to authenticate when needed
- Browser-based OAuth provider with callback server for OAuth flows
- Global OAuth lock coordination to prevent concurrent OAuth flows

### Changed
- HTTP transport type detection now uses configured `type` field instead of URL-based detection
- Enhanced error handling for 401/Unauthorized responses with clearer user guidance
- Updated documentation to reflect HTTP+SSE deprecation (as of MCP spec 2025-03-26)

### Deprecated
- HTTP+SSE transport (`type: "sse"`) is now deprecated in favour of Streamable HTTP (`type: "http"`)

## [1.0.1] - 2025-01-01

### Added
- Device code OAuth flow support
- Token storage with OS keychain integration (with file fallback)
- Built-in help system with `get_help` tool
- Comprehensive error codes and contextual help

### Changed
- Improved logging with structured output
- Enhanced tool discovery and caching

## [1.0.0] - 2024-12-25

### Added
- Initial release of Super MCP Router
- Support for multiple MCP servers (stdio and HTTP)
- Meta-tools for package discovery and management
- Tool validation with Ajv schemas
- Basic OAuth support for HTTP servers