// Standard MCP config format
export interface StandardMcpConfig {
  mcpServers: Record<string, StandardServerConfig>;
}

export interface StandardServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Transport config:
  // - "stdio": Local command execution
  // - "sse": HTTP+SSE transport (deprecated in MCP spec 2025-03-26)
  // - "http": Streamable HTTP transport (recommended)
  type?: "stdio" | "sse" | "http";
  url?: string;
  headers?: Record<string, string>;
  // Tool execution timeout in milliseconds (default: 1800000ms = 30 minutes)
  // Can be overridden by SUPER_MCP_TOOL_TIMEOUT environment variable
  timeout?: number;
}

// Extended super-mcp config format (backward compatibility)
export interface SuperMcpConfig {
  mcpServers?: Record<string, StandardServerConfig | ExtendedServerConfig>;
  packages?: PackageConfig[]; // Legacy format support
  configPaths?: string[]; // Reference other config files to merge
  security?: {
    blockedTools?: string[];      // Exact names or regex patterns like "/.*delete.*/i"
    blockedPackages?: string[];   // Package IDs to completely block
    allowedTools?: string[];      // If set, only these tools are allowed (allowlist mode)
    allowedPackages?: string[];   // If set, only these packages are allowed
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
  visibility?: "default" | "hidden";
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
  transport: "stdio" | "http";
  transportType?: "sse" | "http"; // For HTTP transport: HTTP+SSE (deprecated) or Streamable HTTP
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  base_url?: string;
  auth?: AuthConfig;
  extra_headers?: Record<string, string>;
  visibility: "default" | "hidden";
  oauth?: boolean; // Enable OAuth for this server
  // Pre-registered OAuth client credentials (for servers that don't support DCR)
  oauthClientId?: string;
  oauthClientSecret?: string;
  timeout?: number; // Tool execution timeout in milliseconds
  // Catalog ID for connector identification (e.g., "bamboohr", "bundled-google")
  // Used for admin-disabled tool resolution
  catalogId?: string;
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
  mode: "oauth2";
  method: "device_code" | "authorization_code_pkce";
  scopes: string[];
  client_id: string;
}

export interface PackageInfo {
  package_id: string;
  name: string;
  description?: string;
  transport: "stdio" | "http";
  auth_mode: "env" | "oauth2" | "none";
  tool_count: number;
  health?: "ok" | "error" | "unavailable";
  summary: string;
  visibility: "default" | "hidden";
  catalog_status?: "ready" | "auth_required" | "error";
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
  detail?: "lite" | "full";
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

export interface UseToolOutput {
  package_id: string;
  tool_id: string;
  args_used: any;
  result: any;
  telemetry: {
    duration_ms: number;
    status: "ok" | "error";
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

export interface BeginAuthInput {
  package_id: string;
}

export interface BeginAuthOutput {
  method: "device_code";
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AuthStatusInput {
  package_id: string;
}

export interface AuthStatusOutput {
  state: "pending" | "authorized" | "error";
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
  healthCheck?(): Promise<"ok" | "error" | "needs_auth">;
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