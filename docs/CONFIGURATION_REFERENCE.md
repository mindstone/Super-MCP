# Super-MCP Configuration Reference

Complete reference for all Super-MCP configuration options and schemas.

## See Also

- [README.md](../README.md) — Quick start examples and getting started
- [SECURITY_POLICY_GUIDE.md](./SECURITY_POLICY_GUIDE.md) — Security configuration details
- [OAUTH_AND_AUTHENTICATION.md](./OAUTH_AND_AUTHENTICATION.md) — Authentication configuration
- [src/types.ts](../src/types.ts) — TypeScript interfaces
- [src/registry.ts](../src/registry.ts) — Config loading and normalization

---

## Top-Level Structure

A Super-MCP configuration file has the following top-level structure:

```json
{
  "mcpServers": { ... },    // Server definitions (required for most use cases)
  "configPaths": [ ... ],   // Reference other config files to merge
  "security": { ... }       // Security policy configuration
}
```

---

## Server Configuration

Each server is defined as a key-value pair in the `mcpServers` object, where the key is the server ID.

### Standard MCP Fields

These fields follow the standard MCP configuration format:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | For stdio | Command to execute for stdio transport |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables (supports `${VAR}` expansion) |
| `cwd` | string | No | Working directory for the command |
| `type` | `"stdio"` \| `"sse"` \| `"http"` | No | Transport type (auto-detected from other fields if omitted) |
| `url` | string | For HTTP | Server URL for HTTP/SSE transport |
| `headers` | object | No | HTTP headers to send with requests |
| `timeout` | number | No | Tool execution timeout in milliseconds (default: 5400000 = 90 minutes) |

### Extended Fields (Super-MCP Specific)

Super-MCP adds these extended configuration options:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | server ID | Human-readable name for display |
| `description` | string | — | Package description shown in tool listings |
| `visibility` | `"default"` \| `"hidden"` | `"default"` | Controls display in tool lists |
| `oauth` | boolean | false | Enable OAuth authentication for this server |
| `auth` | AuthConfig | — | OAuth configuration (see [OAUTH_AND_AUTHENTICATION.md](./OAUTH_AND_AUTHENTICATION.md)) |

### Transport Type Detection

If `type` is not specified, Super-MCP auto-detects the transport:

- **stdio**: Used when `command` is specified (and no `url`)
- **http**: Used when `url` is specified

When using HTTP transport:
- `type: "http"` — Streamable HTTP transport (recommended, MCP spec 2025-03-26)
- `type: "sse"` — HTTP+SSE transport (deprecated as of MCP spec 2025-03-26)

### Validation Behavior

Super-MCP validates each server entry on startup. Invalid entries are **skipped with warnings** rather than causing a complete failure:

**Required fields:**
- `name` (or server ID key) must be a non-empty string
- `command` is required for stdio transport (must be non-empty string)
- `url` is required for http transport (must be valid URL)

**Optional field validation:**
- `visibility` must be `"default"` or `"hidden"` if specified

**Graceful degradation:** If an entry fails validation, Super-MCP logs a warning to stderr and continues loading other servers. This prevents one misconfigured server from breaking all tools.

**Structured output for consuming apps:** When servers are skipped, Super-MCP emits a structured line to stderr:
```
SUPER_MCP_SKIPPED_PACKAGES:{"packages":[{"id":"server-name","reason":"..."}]}
```

See `src/registry.ts` → `validatePackageFields()` for the canonical validation rules.

### Example: Stdio Server

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"],
      "name": "Filesystem",
      "description": "Local filesystem access"
    }
  }
}
```

### Example: HTTP Server

```json
{
  "mcpServers": {
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      },
      "name": "Remote API",
      "description": "Remote API integration"
    }
  }
}
```

---

## Security Configuration

The `security` object controls which tools and packages are permitted or blocked.

| Field | Type | Description |
|-------|------|-------------|
| `blockedTools` | string[] | Exact tool names or regex patterns to block |
| `blockedPackages` | string[] | Package IDs to completely block |
| `allowedTools` | string[] | If set, only these tools are permitted (allowlist mode) |
| `allowedPackages` | string[] | If set, only these packages are permitted (allowlist mode) |
| `logBlockedAttempts` | boolean | Log when tools are blocked (default: true) |

### Blocking Patterns

The `blockedTools` array supports:
- **Exact names**: `"delete_file"` — blocks tool with this exact name
- **Regex patterns**: `"/.*delete.*/i"` — blocks tools matching the pattern (case-insensitive)

### Example: Security Configuration

```json
{
  "security": {
    "blockedTools": [
      "execute_shell",
      "/.*delete.*/i",
      "/.*remove.*/i"
    ],
    "blockedPackages": ["untrusted-package"],
    "logBlockedAttempts": true
  }
}
```

### Allowlist Mode

When `allowedTools` or `allowedPackages` is set, Super-MCP operates in allowlist mode:

```json
{
  "security": {
    "allowedPackages": ["filesystem", "memory"],
    "allowedTools": ["read_file", "list_directory"]
  }
}
```

For detailed security configuration, see [SECURITY_POLICY_GUIDE.md](./SECURITY_POLICY_GUIDE.md).

---

## Environment Variable Expansion

Super-MCP supports environment variable expansion in the `env` field:

### Syntax

- `${VAR_NAME}` — Standard syntax for environment variable expansion
- `$VAR_NAME` — Shorthand syntax (uppercase letters, digits, and underscores only)

### Behavior

- Only configured variables are passed to servers (not the entire process environment)
- A warning is logged for missing variables using `${VAR}` syntax
- Missing variables remain unexpanded in the value

### Example

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "GITHUB_ORG": "$GITHUB_ORG"
      }
    }
  }
}
```

---

## Config File Locations

### Default Location

- `~/.super-mcp/config.json` — Default configuration file

### Custom Locations

- **CLI flag**: `--config /path/to/config.json`
- **Multiple files**: Use multiple `--config` flags
- **Environment variable**: `SUPER_MCP_CONFIG` (path to config file)

### Config File Merging (configPaths)

Use `configPaths` to reference and merge other configuration files:

```json
{
  "configPaths": [
    "./servers/filesystem.json",
    "./servers/databases.json",
    "/absolute/path/to/shared-config.json"
  ],
  "mcpServers": {
    "local-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

**Merging behavior:**
- Relative paths are resolved from the containing config file's directory
- Server IDs in later files override earlier ones (with a warning)
- Security arrays are concatenated (blockedTools, allowedTools, etc.)
- Circular references are detected and throw an error
- Maximum nesting depth: 20 levels

---

## Legacy Format Support

Super-MCP maintains backward compatibility with older configuration formats.

### Legacy `packages` Array Format

The old array format is automatically converted:

```json
{
  "packages": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "visibility": "default"
    }
  ]
}
```

### Root-Level Server Entries

Configs without the `mcpServers` wrapper are supported (e.g., some external MCP configs):

```json
{
  "my-server": {
    "url": "https://api.example.com/mcp"
  },
  "another-server": {
    "command": "node",
    "args": ["server.js"]
  }
}
```

A server config is identified by having either a `url` or `command` field.

---

## Complete Example

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"],
      "name": "Filesystem",
      "description": "Read and write local files",
      "visibility": "default"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      "name": "GitHub",
      "description": "GitHub repository operations",
      "timeout": 60000
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "type": "http",
      "headers": {
        "X-API-Key": "${API_KEY}"
      },
      "oauth": true,
      "name": "Remote API"
    }
  },
  "configPaths": [
    "./extra-servers.json"
  ],
  "security": {
    "blockedTools": [
      "/.*delete.*/i",
      "/.*remove.*/i"
    ],
    "logBlockedAttempts": true
  }
}
```

---

## Maintenance

This document should be updated when changes are made to:
- `src/types.ts` — Configuration interfaces
- `src/registry.ts` — Config loading and validation logic
- `src/security.ts` — Security policy implementation
