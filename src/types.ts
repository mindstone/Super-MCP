// Standard MCP config format
export interface StandardMcpConfig {
  mcpServers: Record<string, StandardServerConfig>;
}

// Wire contract mirrored by Rebel's src/shared/types/mcp.ts (MCP_SETUP_INCOMPLETE_REASONS).
// Keep both reason lists in sync; Rebel's mcpSetupStatusContract.test.ts enforces parity.
export const SETUP_INCOMPLETE_REASONS = ['missing_managed_credentials', 'cloud_reprovision_required'] as const;
export type SetupIncompleteReason = (typeof SETUP_INCOMPLETE_REASONS)[number];

export interface PackageSetupStatus {
  state: 'blocked';
  reason: SetupIncompleteReason;
}

export type CatalogStatus = 'ready' | 'auth_required' | 'setup_incomplete' | 'error';

export interface StandardServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Transport config:
  // - "stdio": Local command execution
  // - "sse": HTTP+SSE transport (deprecated in MCP spec 2025-03-26)
  // - "http": Streamable HTTP transport (recommended)
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
  // Tool execution timeout in milliseconds (default: 14400000ms = 4 hours sentinel)
  // The Rebel Core agent-turn watchdog is the real effective ceiling; this is the
  // last-resort upstream cap. Can be overridden by SUPER_MCP_TOOL_TIMEOUT environment variable.
  timeout?: number;
  /** Cloud-owned setup state. A blocked package must never be spawned. */
  setupStatus?: PackageSetupStatus;
}

// Extended super-mcp config format (backward compatibility)
export interface SuperMcpConfig {
  mcpServers?: Record<string, StandardServerConfig | ExtendedServerConfig>;
  packages?: PackageConfig[]; // Legacy format support
  configPaths?: string[]; // Reference other config files to merge
  security?: {
    blockedTools?: string[]; // Exact names or regex patterns like "/.*delete.*/i"
    blockedPackages?: string[]; // Package IDs to completely block
    allowedTools?: string[]; // If set, only these tools are allowed (allowlist mode)
    allowedPackages?: string[]; // If set, only these packages are allowed
    logBlockedAttempts?: boolean; // Log when tools are blocked (default: true)
  };
  // User-disabled tools per server (scoped by server ID to avoid name collisions)
  // Tool names are short names (e.g., "delete_file"), not namespaced
  // Example: { "filesystem": ["delete_file"], "gmail": ["send_email"] }
  userDisabledToolsByServer?: Record<string, string[]>;
  // Disabled servers - these servers are completely excluded from routing
  // Server IDs are the keys in mcpServers (e.g., "GoogleWorkspace-greg-work-com", "Slack-mindstone")
  // Example: ["Slack-mindstone", "HubSpot"]
  disabledServers?: string[];
  // Admin-disabled tools by catalog ID (set by organization administrators)
  // Catalog IDs are connector identifiers (e.g., "bamboohr", "bundled-talentlms")
  // Tool names are short names (e.g., "configure_talentlms"), not namespaced
  // Example: { "bamboohr": ["bamboohr_add_employee_dependent"], "docusign": ["create_template"] }
  adminDisabledToolsByCatalogId?: Record<string, string[]>;
}

export interface ExtendedServerConfig extends StandardServerConfig {
  // Extended properties for super-mcp
  name?: string;
  description?: string;
  visibility?: 'default' | 'hidden';
  auth?: AuthConfig;
  oauth?: boolean; // Enable OAuth for this server
  // Pre-registered OAuth client credentials (for servers that don't support DCR)
  oauthClientId?: string;
  oauthClientSecret?: string;
  // Catalog ID for connector identification (e.g., "bamboohr", "bundled-google")
  // Used for admin-disabled tool resolution across server instances
  catalogId?: string;
}

export interface PackageConfig {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  transportType?: 'sse' | 'http'; // For HTTP transport: HTTP+SSE (deprecated) or Streamable HTTP
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  base_url?: string;
  auth?: AuthConfig;
  extra_headers?: Record<string, string>;
  visibility: 'default' | 'hidden';
  oauth?: boolean; // Enable OAuth for this server
  // Pre-registered OAuth client credentials (for servers that don't support DCR)
  oauthClientId?: string;
  oauthClientSecret?: string;
  timeout?: number; // Tool execution timeout in milliseconds
  // Catalog ID for connector identification (e.g., "bamboohr", "bundled-google")
  // Used for admin-disabled tool resolution
  catalogId?: string;
  /** Cloud-owned setup state. A blocked package must never be spawned. */
  setupStatus?: PackageSetupStatus;
}

/**
 * Represents a package that was skipped during validation.
 * Used when gracefully handling invalid config entries.
 */
export interface SkippedPackage {
  id: string;
  reason: string;
}

/**
 * Result of config validation - returns valid packages and any skipped entries.
 */
export interface ValidationResult {
  valid: PackageConfig[];
  skipped: SkippedPackage[];
}

export interface AuthConfig {
  mode: 'oauth2';
  method: 'device_code' | 'authorization_code_pkce';
  scopes: string[];
  client_id: string;
}

export interface PackageInfo {
  package_id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  auth_mode: 'env' | 'oauth2' | 'none';
  tool_count: number;
  health?: 'ok' | 'error' | 'unavailable';
  summary: string;
  visibility: 'default' | 'hidden';
  catalog_status?: CatalogStatus;
  catalog_error?: string;
}

export interface ToolInfo {
  package_id: string;
  tool_id: string;
  name: string;
  description?: string;
  summary?: string;
  args_skeleton?: any;
  schema_hash: string;
  schema?: any;
  /** MCP spec tool annotations (behavioral hints from upstream server) */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  blocked?: boolean;
  blocked_reason?: string;
  /** True if this tool was disabled by user preference (separate from security policy) */
  user_disabled?: boolean;
  /** True if this tool was disabled by an organization administrator */
  admin_disabled?: boolean;
}

export interface ListToolPackagesInput {
  safe_only?: boolean;
  limit?: number;
  include_health?: boolean;
}

export interface ListToolPackagesOutput {
  packages: PackageInfo[];
  catalog_etag: string;
  updated_at: string;
}

export interface ListToolsInput {
  package_id: string;
  detail?: 'lite' | 'full';
  page_size?: number;
  page_token?: string | null;
}

export interface ListToolsOutput {
  tools: ToolInfo[];
  next_page_token?: string | null;
}

export interface GetToolDetailsInput {
  tool_ids: string[];
}

export interface UseToolInput {
  package_id: string;
  tool_id: string;
  args: any;
  dry_run?: boolean;
  max_output_chars?: number | null;
  result_id?: string;
  output_offset?: number;
  schema_hash?: string;
}

/**
 * SSOT for the `use_tool` envelope's meta-parameters: the top-level parameters that
 * belong to super-mcp itself, NOT to the downstream tool's `args`.
 *
 * Models routinely nest one of these inside `args` (REBEL-7JD: `max_output_chars`
 * inside `args` for a no-argument tool), which the downstream schema then rejects as
 * an unknown field. Consumers:
 *   - `handlers/useToolInput.ts` — envelope schema entries + the misplacement guard.
 *   - `handlers/useTool.ts` — misplacement-aware repair-ticket text (all five).
 * Adding a sixth meta-param to `UseToolInput`? Add it here too. The `satisfies` check
 * below proves membership only; exhaustiveness is gated by
 * `USE_TOOL_INPUT_FIELD_CLASSIFICATION` (tsc) plus its drift-guard test.
 */
export const USE_TOOL_META_PARAMS = [
  'max_output_chars',
  'dry_run',
  'result_id',
  'output_offset',
  'schema_hash',
] as const satisfies readonly (keyof UseToolInput)[];

export type UseToolMetaParam = (typeof USE_TOOL_META_PARAMS)[number];

/**
 * Compile-time exhaustiveness gate for the SSOT above (planner F6 / reviewer-opus F1).
 *
 * `satisfies readonly (keyof UseToolInput)[]` proves MEMBERSHIP only: a sixth field
 * added to `UseToolInput` and forgotten here would go silently unguarded by the
 * misplacement guard and untaught by the repair ticket. This `Record` makes that
 * omission a tsc error (`npm run build`), and the drift-guard test
 * (test/useTool-metaParam-contract.test.ts) asserts the two stay in agreement at
 * runtime — so classifying a new field as 'meta' without adding it to
 * USE_TOOL_META_PARAMS is caught too.
 *
 * 'structural' = the envelope's own addressing fields; never a misplaceable meta-param.
 */
export const USE_TOOL_INPUT_FIELD_CLASSIFICATION: Record<
  keyof UseToolInput,
  'meta' | 'structural'
> = {
  package_id: 'structural',
  tool_id: 'structural',
  args: 'structural',
  dry_run: 'meta',
  max_output_chars: 'meta',
  result_id: 'meta',
  output_offset: 'meta',
  schema_hash: 'meta',
};

/**
 * Meta-params EXCLUDED from the hard-reject guard (see below). Derived by explicit
 * exclusion so the reason for each is recorded where a future reader will see it.
 *
 * Exported because these two are ALSO the exact scope of the declared-property
 * misplacement gate at the validation seam (handlers/useTool.ts). The gate is
 * deliberately the complement of the envelope guard: the hard three never reach
 * the validator, and widening the gate to cover them would break their
 * top-level-twin escape hatch (REBEL-7JD residue R1 / plan Amendment A).
 */
export const USE_TOOL_SOFT_META_PARAMS: readonly UseToolMetaParam[] = [
  // dry_run: plausible as a legitimate third-party tool argument (plenty of real
  // tools take a `dry_run` flag). A false positive would make that tool permanently
  // uncallable, so dry_run is taught by the schema-aware repair ticket instead.
  'dry_run',
  // result_id: the guard is UNREACHABLE for it. `isContinuationCall(input)` is
  // `Boolean(input.result_id)` (handlers/useToolInput.ts) and the guard only fires
  // when the key is ABSENT at top level — exact logical complements. Worse, the
  // guard's own advice ("pass it top-level") would hijack the call into the
  // continuation branch at useTool.ts:969, which returns cache-miss prose without
  // ever invoking the tool: a silent failure. Taught by the repair ticket instead.
  'result_id',
];

/**
 * Meta-params rejected outright when nested inside `args` with no top-level twin.
 * All three are consumed by the envelope before the downstream schema is ever
 * fetched, and all three have a verified-working escape hatch: pass the param
 * top-level as well and the call proceeds (so a tool that legitimately declares
 * one of these stays callable).
 */
export const USE_TOOL_HARD_REJECT_META_PARAMS: readonly UseToolMetaParam[] =
  USE_TOOL_META_PARAMS.filter((param) => !USE_TOOL_SOFT_META_PARAMS.includes(param));

export interface UseToolOutput {
  package_id: string;
  tool_id: string;
  args_used: any;
  result: any;
  telemetry: {
    duration_ms: number;
    status: 'ok' | 'error';
    output_chars?: number;
    output_truncated?: boolean;
    original_output_chars?: number;
    result_id?: string;
    materialized?: boolean;
  };
  /** Connector tool's MCP spec annotations (behavioral hints for retry decisions) */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface BulkExportInput {
  package_id?: string;
  tool_id: string;
  args: Record<string, unknown>;
  output_file: string;
  items_path?: string;
  max_pages?: number;
  if_exists?: 'error' | 'overwrite';
  pagination?: {
    token_field: string;
    input_param: string;
  };
}

export interface BulkExportOutput {
  status: 'complete' | 'partial' | 'failed';
  pages: number;
  lines: number;
  bytes: number;
  output_file: string;
  errors?: string[];
}

export interface BeginAuthInput {
  package_id: string;
}

export interface BeginAuthOutput {
  method: 'device_code';
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AuthStatusInput {
  package_id: string;
}

export interface AuthStatusOutput {
  state: 'pending' | 'authorized' | 'error';
  scopes?: string[];
  expires_at?: string;
}

export interface ReadResourceResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<any[]>;
  callTool(name: string, args: any): Promise<any>;
  close(): Promise<void>;
  healthCheck?(): Promise<'ok' | 'error' | 'needs_auth'>;
  requiresAuth?(): Promise<boolean>;
  isAuthenticated?(): Promise<boolean>;
  readResource?(uri: string): Promise<ReadResourceResult>;
  supportsResources?(): boolean;
  hasPendingRequests?(): boolean;
}

export interface AuthManager {
  beginAuth(packageId: string, config: AuthConfig): Promise<BeginAuthOutput>;
  getAuthStatus(packageId: string): Promise<AuthStatusOutput>;
  getAuthHeaders(packageId: string): Promise<Record<string, string>>;
}

/**
 * Closed discriminator for why a tool call was rejected with TOOL_BLOCKED.
 * Emitted as `data.reason` on every TOOL_BLOCKED error so hosts can branch on
 * a stable contract field instead of parsing the human-readable message.
 * Legacy fields (`blocked_reason`, `user_disabled`, `admin_disabled`) are kept
 * alongside for backward compatibility — do not remove them.
 *
 * The Rebel host mirrors this union literally in
 * `src/main/ipc/mcpAppsHandlers.ts` (`TOOL_BLOCKED_REASONS`); both copies are
 * pinned by their own contract tests, so keep them in sync when adding a reason.
 */
export type ToolBlockedReason = 'user-disabled' | 'admin-disabled' | 'security-policy';

export const ERROR_CODES = {
  INVALID_PARAMS: -32602,
  PACKAGE_NOT_FOUND: -33001,
  TOOL_NOT_FOUND: -33002,
  ARG_VALIDATION_FAILED: -33003,
  PACKAGE_UNAVAILABLE: -33004,
  AUTH_REQUIRED: -33005,
  AUTH_INCOMPLETE: -33006,
  DOWNSTREAM_ERROR: -33007,
  TOOL_BLOCKED: -33008,
  RESOURCE_NOT_FOUND: -33010,
  CAPABILITY_NOT_SUPPORTED: -33011,
  INTERNAL_ERROR: -32603,
} as const;
