<p align="center">
  <img src="docs/assets/glitch.svg" alt="Glitch, the Rebel character for safety checks and known limitations" width="112" />
</p>

# Super MCP Router

A local MCP router that aggregates all your MCP servers behind a single
interface — and saves your context window by loading only the tools you
actually need, when you need them. No installation required - just use npx!

Connect ten MCP servers directly and every tool schema lands in your model's
context before it has done any work. Super-MCP replaces that with a small set
of meta-tools and on-demand discovery: search for the tool you need, fetch its
schema, call it. Your context window stays for the actual task.

Works with Claude Desktop, Claude Code, Cursor, [Rebel](https://mindstone.com),
or any other MCP host.

## Overview

Super MCP Router allows you to configure multiple MCP servers (both local stdio and hosted HTTP) and access them through a single unified interface with these meta-tools:

- `list_tool_packages` - List available MCP packages and discover their capabilities
- `list_tools` - Browse tools in a package (use `detail:"lite"` for names + descriptions, `detail:"full"` for complete schemas)
- `get_tool_details` - Get full schema for specific tools before first use
- `record_tool_note` - Save or replace one durable, non-obvious tool lesson (200 characters max); it surfaces on matching-schema detail requests for up to 30 days
- `use_tool` - Execute a tool from any package
- `search_tools` - BM25 keyword search across all available tools
- `get_help` - Get detailed guidance on using Super-MCP effectively
- `authenticate` - Start OAuth authentication for packages that require it
- `health_check_all` - Check the operational status of all configured packages
- `health_check` - Check the status of a specific package
- `restart_package` - Hot-reload a package's credentials without restarting Super-MCP

### Discovery snapshots

Discovery is a read of Super MCP's latest health-gated catalog snapshot. The passive discovery tools—`list_tool_packages`, `list_tools`, `get_tool_details`, `search_tools`, and package help from `get_help`—do not wait for packages to connect. Unreachable or unauthenticated packages are reported with their catalog status and retry information instead of delaying every other package.

The catalog REST routes follow the same rule. `GET /api/tools` returns immediately by default; a cold-start consumer may opt into a bounded wait with `wait_for_snapshot_ms`, for example `GET /api/tools?wait_for_snapshot_ms=500`. If the current configuration generation is still not ready when that budget ends, the response remains explicitly incomplete (`snapshot_complete: false`) and includes `degraded_packages`—an empty snapshot is never presented as a successful complete catalog.

Tool execution remains explicit. `use_tool`, `read_resource`, and `bulk_export` may establish a bounded package connection when doing the requested work; their catalog lookups themselves only consult the snapshot.

## Documentation

For detailed guides, see the `docs/` directory:

| Document | Description |
|----------|-------------|
| [Configuration Reference](docs/CONFIGURATION_REFERENCE.md) | Complete schema for all config options |
| [Security Policy Guide](docs/SECURITY_POLICY_GUIDE.md) | Allowlist/blocklist rules, patterns, hot-reload |
| [Security Hardening](docs/SECURITY_HARDENING.md) | Security measures, mitigations, and future work |
| [OAuth & Authentication](docs/OAUTH_AND_AUTHENTICATION.md) | API keys, OAuth flows, token storage |
| [Transport Modes](docs/TRANSPORT_MODES.md) | STDIO vs HTTP comparison and selection guide |
| [Error Codes Reference](docs/ERROR_CODES_REFERENCE.md) | All error codes with causes and solutions |
| [Timeout Configuration](docs/TIMEOUT_CONFIGURATION.md) | Per-server and global timeout settings |
| [Multi-Config Best Practices](docs/MULTI_CONFIG_BEST_PRACTICES.md) | Organizing configs across files |
| [Architecture Overview](docs/ARCHITECTURE_OVERVIEW.md) | Component design and request flow |

## Quick Start (No Installation Required!)

Super MCP Router supports two transport modes:
- **STDIO** (default): For local Claude Desktop integration
- **HTTP**: For remote access and running multiple instances in parallel

### 1. Add to Claude Desktop (STDIO Mode)

Add this to your Claude Desktop MCP settings:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "super-mcp": {
      "command": "npx",
      "args": ["-y", "super-mcp-router@latest"]
    }
  }
}
```

### 1b. Use HTTP Mode (Remote/Parallel Access)

**When to use HTTP mode:**
- 🔄 Running multiple instances in parallel (no tool call conflicts)
- 🌐 Remote access from multiple machines
- ☁️ Cloud deployments (AWS, GCP, Azure, etc.)
- 🔧 Load balancing across multiple servers
- 📊 Easier monitoring and debugging with HTTP tools

To run the server in HTTP mode:

```bash
# Run on default port 3000
npx super-mcp-router@latest --transport http

# Run on custom port
npx super-mcp-router@latest --transport http --port 8080

# With custom config
npx super-mcp-router@latest --transport http --config /path/to/config.json
```

Then configure Claude Desktop to connect via HTTP:

```json
{
  "mcpServers": {
    "super-mcp-http": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Running Multiple Instances:**
```bash
# Terminal 1 - Instance on port 3000
npx super-mcp-router@latest --transport http --port 3000

# Terminal 2 - Instance on port 3001
npx super-mcp-router@latest --transport http --port 3001

# Terminal 3 - Instance on port 3002
npx super-mcp-router@latest --transport http --port 3002
```

Each instance runs independently with no shared state or conflicts.

### 2. Restart Claude Desktop

That's it! Super MCP Router will automatically:
- Create `~/.super-mcp/` directory
- Create an empty config file
- Start working immediately (even with no MCPs configured)

### 3. Add MCP Servers (Optional)

Use the simple CLI to add MCP servers:

```bash
# Add common MCP servers
npx super-mcp-router add filesystem
npx super-mcp-router add github
npx super-mcp-router add memory

# See available servers
npx super-mcp-router add --help
```

Or manually edit `~/.super-mcp/config.json` to add custom MCPs.

## Transport Modes

> **See also**: [Transport Modes Guide](docs/TRANSPORT_MODES.md) for detailed comparison and selection guidance.

### STDIO Mode (Default)
- ✅ Best for: Local Claude Desktop integration
- ✅ Zero configuration needed
- ✅ Lowest latency
- ⚠️ Single client only
- ⚠️ Cannot run multiple instances in parallel

### HTTP Mode
- ✅ Best for: Multiple parallel instances, remote access, cloud deployments
- ✅ Run unlimited instances simultaneously
- ✅ No tool call conflicts between instances
- ✅ Works with load balancers
- ✅ Easier to monitor and debug
- ⚠️ Requires port configuration
- ⚠️ Slightly higher latency than stdio (minimal)

## Configuration

> **See also**: [Configuration Reference](docs/CONFIGURATION_REFERENCE.md) for complete schema documentation.

Super MCP Router supports the standard MCP `mcpServers` configuration format, making it easy to drop in existing MCP server configurations.

Create a `super-mcp-config.json` file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/directory"
      ]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_GITHUB_TOKEN"
      }
    },
    "notion-api": {
      "type": "sse",
      "url": "https://mcp.notion.com/mcp",
      "oauth": true,
      "name": "Notion Integration",
      "description": "Access and manage Notion workspaces"
    }
  }
}
```

### Configuration Options

**Standard MCP fields:**
- `command`: Command to execute (for stdio servers)
- `args`: Command arguments
- `env`: Environment variables (supports variable expansion - see below)
- `cwd`: Working directory for the server process
- `type`: Transport type:
  - `"stdio"`: Local command execution
  - `"sse"`: HTTP+SSE transport (deprecated as of MCP spec 2025-03-26)
  - `"http"`: Streamable HTTP transport (recommended for HTTP servers)
- `url`: Server URL (for HTTP servers)
- `headers`: HTTP headers for authentication

**Extended fields (super-mcp specific):**
- `oauth`: Enable OAuth authentication (boolean)
- `name`: Human-readable name for the package
- `description`: Description of the package's capabilities
- `visibility`: "default" or "hidden" (controls display in tool lists)
- `timeout`: Tool execution timeout in milliseconds (default: 5400000 = 90 minutes)

### Environment Variable Expansion

Super MCP Router supports environment variable expansion in the `env` field using `${VAR}` or `$VAR` syntax:

```json
{
  "github": {
    "command": "npx",
    "args": ["@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
    }
  }
}
```

This allows you to:
- Keep sensitive tokens out of configuration files
- Share configurations without exposing credentials
- Use different values across environments

**Security Note**: Only explicitly configured environment variables are passed to MCP servers. This prevents leaking system environment variables to individual servers.

### Configuring Tool Timeouts

> **See also**: [Timeout Configuration](docs/TIMEOUT_CONFIGURATION.md) for detailed timeout guide.

Super MCP Router supports configurable timeouts for long-running tool executions. By default, tools time out after 90 minutes (5,400,000ms), but you can customize this per-server or globally.

**Per-Server Timeout:**
```json
{
  "mcpServers": {
    "deep-research": {
      "command": "npx",
      "args": ["-y", "octagon-deep-research-mcp@latest"],
      "timeout": 600000,  // 10 minutes for deep research tasks
      "env": {
        "OCTAGON_API_KEY": "your_api_key"
      }
    }
  }
}
```

**Global Timeout (Environment Variable):**
```bash
export SUPER_MCP_TOOL_TIMEOUT=600000  # 10 minutes default for all tools
```

**How Timeouts Work:**
- Default timeout: 5,400,000ms (90 minutes)
- Per-server `timeout` config overrides the default
- `SUPER_MCP_TOOL_TIMEOUT` environment variable provides a global default
- Timeout automatically resets when the tool sends progress notifications
- Useful for long-running operations like research, data processing, or complex queries

## CLI Commands

Super MCP Router includes a simple CLI for managing MCP servers:

### Adding MCP Servers

```bash
# Add pre-configured MCP servers
npx super-mcp-router add filesystem  # Adds filesystem access
npx super-mcp-router add github      # Adds GitHub integration 
npx super-mcp-router add memory      # Adds persistent memory

# See available servers
npx super-mcp-router add --help
```

The `add` command:
- Adds servers to `~/.super-mcp/config.json`
- Uses sensible defaults (e.g., `~/Documents` for filesystem)
- Reminds you about required environment variables

### Default Config Location

If no `--config` is specified, Super MCP Router uses:
- `~/.super-mcp/config.json` (auto-created if missing)

You can still use custom locations:
```bash
npx super-mcp-router --config /custom/path/config.json
```

## Package homes

A `packageHomes` entry routes a configured package to another router over streamable HTTP:

```json
{
  "packageHomes": {
    "notebook": {
      "url": "https://cloud.example.test/mcp/packages/notebook",
      "headers": { "Authorization": "Bearer example-token" }
    }
  }
}
```

Keep the package's original `mcpServers` entry. Any config file can supply homes; later files override earlier entries by package ID. Reloading a home or its headers reconnects only that package. Removing its home resumes local operation on the next use.

Tool discovery, calls and resources use the home. An unreachable home pauses the package until the next successful request. `authenticate` uses the original package entry; HTTP OAuth always starts a fresh authorization. No local fallback runs while a home is configured.

In HTTP mode, `/mcp/packages/:id` exposes one local package with its original tool names, schemas, annotations, metadata and resources. Calls share the router's security, administrator and user restrictions. Sessions belong to one endpoint, and unknown or homed IDs return 404. These routes use the same loopback listener and request guards as `/mcp`.

### File-read preflight (experimental v1)

This is a Super MCP experimental extension, not part of the MCP standard. It lets a host (the app running the router) apply its file permissions before a local connector reads an input file. The router starts each local connector as a child process. The host and router reuse their MCP connection; the connector still opens and uploads the bytes itself. The following sections are for host and connector authors; users do not put these permission fields in tool arguments.

For local stdio calls without a configured `cwd`, a nonblank effective `MCP_WORKSPACE_PATH` supplies the default for declared `connectorCwd` and `connectorCwdNative` file inputs, such as `General/report.txt`. A relative workspace resolves from the actual child cwd. The connector still launches in its existing directory. In standalone mode, the router clones the arguments and makes only selected relative operands absolute; the caller's original arguments stay intact. With host read authority, arguments and raw-path bindings stay intact and the host decides the canonical paths. Explicit `cwd`, operands that already name a root or drive (such as `/report.txt`, or `\report.txt` and `C:report.txt` on Windows), undeclared fields and other declaration bases keep their existing behavior. Affected standalone calls now discover tool metadata and validate version-1 declarations before dispatch; discovery failures or malformed declarations stop the call. This preparation does not forward relative source files to a package home; at a home, a relative operand resolves against that home's own workspace.

**Host to router.** During MCP initialization, the host advertises the Client capability `experimental["files/readAuthority"]: {"version":1}`. The router reads that capability; a connector does not need to inspect it. For an executable call, the host supplies request-level `_meta["files/invocation"]: {"version":1,"invocationId":"…"}`. The ID refers to a host-owned record for this exact active call, including its admitted arguments. It expires when the call ends and is not a session-wide permission.

For each dispatch attempt, the router sends a `files/authorizeReads` batch containing `version`, `invocationId` and `operands`. Each operand has a concrete `location`, its original `rawPath` and its absolute `resolvedPath`. An `allowed` result returns exactly one `{location,rawPath,canonicalPath}` per operand. `approval_pending` returns `presentation` (`"queued"` or `"staged"`) and `reason`; `denied` and `unavailable` return `reason`. Every result has `version:1` and `outcome`; only `allowed` returns paths. A missing or expired invocation record for an actual read, an invalid reply, a pending decision, a denial, a transport failure or cancellation stops that call before file bytes are opened. Calls with no file inputs skip this authorization request. Pagination or replaying an expired package-home session can repeat a batch for the same invocation; the host must answer each batch while that invocation remains active.

**Declaring a connector's inputs.** The connector author adds `_meta["files/readInputs"]` to each local stdio tool definition. The router does not infer file fields from their names. This declaration describes the tool's existing input semantics:

```json
{
  "version": 1,
  "inputs": [{
    "selector": ["attachments", "*", "path"],
    "base": "connectorCwd",
    "expandTilde": false,
    "nonLocalPrefixes": ["https://"],
    "when": [{ "relativeTo": "parent", "selector": ["content"], "test": "falsy" }]
  }]
}
```

The declaration requires `version` and `inputs`; each input requires `selector`, `base` and `expandTilde`. `when` and `nonLocalPrefixes` are optional. Here the router selects each attachment's `path` only when that attachment's `content` is falsy. Selectors use property names, numeric indices and `"*"` for array elements. Conditions are combined with AND and use concrete selectors relative to the operand's parent object or the argument root. Supported tests are scalar `equals` (with `value`), `undefined` (including absent) and JavaScript `falsy`. Empty/non-string values are skipped. `nonLocalPrefixes` matches the **raw input string**, case-sensitively and before path resolution; the connector keeps handling those URL or inline branches itself.

Describe the path handling your tool already uses; do not change its accepted inputs through the declaration:

Choose a base by tracing the reader's existing path operations. Here, **lexical** means normalizing `.` and `..` in the path string before the filesystem follows links. **Native** means passing the spelling to the filesystem as the reader does. For example, on POSIX, if `/a/link` points to `/x/y`, `/a/link/../file` means `/a/file` lexically and `/x/file` natively.

| Base | Readers | Root used for relative inputs |
| --- | --- | --- |
| `connectorCwd` | 13 reader families | The working directory the child actually reports (physical on POSIX, its normalized spelling on Windows), or the router's when none is configured. For local calls with no configured `cwd`, a nonblank workspace replaces it for operands without a root or drive (see above). The operand resolves lexically from it. |
| `connectorCwdNative` | Canvas | The same directory, for a tool that opens the input as spelled. A `..` segment is left for the filesystem to walk, so a symlink before it counts; a target that cannot be resolved is an error. Other inputs behave like `connectorCwd`. |
| `workspace` | OpenAI Image | Trim the child's effective `MCP_WORKSPACE_PATH`; blank gives no operand. Resolve a relative workspace from child cwd, then resolve the operand lexically. |
| `workspaceRealpath` | Computers | Trim the workspace; blank or non-absolute gives no operand. After that guard, resolve the workspace as spelled, so a symlink before `..` counts, with a driveless Windows root on the child's drive, before the operand. ENOENT/ENOTDIR gives no operand; other errors surface. |
| `workspaceRealpathOrTmp` | Browser automation | Trim workspace or use the child's temp when unset or blank. Anchor from child cwd, realpath that root, then resolve the operand lexically. An unresolvable workspace or temp is an error; an unavailable workspace never selects temp. |

On Windows, child temp is `TEMP || TMP || effectiveSystemRoot + '\\temp'`, recognizing `SYSTEMROOT`, `SystemRoot` and `windir`; it does not use the router's temp as a fallback.

A missing workspace does not create a new allowed root. Required-workspace reads still fail closed; negotiated calls may report a missing approved input rather than the standalone reader's missing-workspace error. Set `expandTilde:true` only if the tool already replaces a leading `~` with its home directory; false leaves it literal.

**Router to connector.** The router advertises Client capability `experimental["files/readModes"]: {"version":1}` when initializing a stdio child. With the TypeScript MCP SDK, the child reads that capability after initialization through `McpServer.server.getClientCapabilities()?.experimental`. Version 1 is negotiated only when the advertised `version` equals `1`; unknown versions retain the older strict behavior. A malformed version-1 declaration fails explicitly when a hosted, forwarded or affected standalone call uses it, rather than silently reverting to that older behavior.

On a version-1 connection, the router sends request-level `_meta["files/readMode"]` on every dispatched call. A TypeScript MCP SDK tool handler receives it in `extra._meta`. Pending, denied and unavailable preflight results do not dispatch the connector at all:

- `{version:1,mode:"central",reads:[…]}`: open only the supplied `canonicalPath` for each exact declared operand. Do not apply another workspace-containment or raw-symlink refusal to a centrally allowed path. Keep regular-file, descriptor/stream, size and media checks. An empty `reads` list permits no file input, and a required operand missing from the list refuses the call.
- `{version:1,mode:"standalone"}`: apply the connector's existing strict read rules, typically canonical containment within `MCP_WORKSPACE_PATH` or its existing temporary-directory fallback. A symlink pointing outside those roots remains refused under those rules. This mode is selected when the upstream host has not advertised version-1 authority.

A child that negotiated version 1 rejects missing or malformed per-call modes. A host, router or child that never negotiated it keeps the existing standalone behavior. The connector consumes the router's request metadata; model arguments such as `arguments._meta` never select a mode or grant a path. The host owns `files/invocation` on the host-to-router hop, and the router owns `files/readMode` on the router-to-child hop. Do not put either key in tool arguments or forward arbitrary upstream `files/*` request keys. Declarations from a remote HTTP server do not request permission to read the router machine's files: that server runs on another filesystem and retains its own file handling.

**Forwarding to a package home.** A package home is another router's `/mcp/packages/:id` endpoint, configured through `packageHomes` above. Endpoints advertise Server capability `experimental["files/forwardedInputs"]: {"version":1}`. When sender and receiver both support version 1 and the tool declares its inputs, the source router authorizes existing absolute source-workspace inputs before opening them. This includes a path spelled inside the workspace that passes through a directory symlink to a physical file elsewhere, if the host permits that target. Copies keep the existing `{path,name,contentBase64}` envelope, size limit and cleanup. Replacement changes only declared input locations in a cloned execution view; literal text, output paths and the original arguments stay intact.

With older receivers or undeclared tools, the router retains the older discovery and replacement route, adding central source checks when authority is available. That older replacement recursively changes **every string equal to a forwarded source path**, so an unrelated literal or output field with the same string can also change. This is an existing mixed-version limitation; use compatible declarations and version-1 endpoints for location-only replacement. A new home accepts old envelopes and uses its child's declaration to restrict replacement when available. Connector authors do not parse this forwarding envelope; the routers handle copying and replacement before calling the connector's usual path reader. An authorization failure never selects the older route as a fallback.

A path that exists only at the package home keeps that home's existing standalone restrictions; it is not authorized using the source host's filesystem context. Forwarded source bytes are authorized before leaving the source when authority is available. A host running beside the remote connector can use its own central authority and originating session. No additional byte transport or permission store is introduced. Compatibility tests use [wire-v1.json](test/fixtures/file-read/wire-v1.json) to pin the version-1 message shapes across implementations.

## Using Multiple Configuration Files

> **See also**: [Multi-Config Best Practices](docs/MULTI_CONFIG_BEST_PRACTICES.md) for organization strategies.

You can split your MCP servers across multiple configuration files for better organization. This is useful for:
- Separating personal and work MCPs
- Grouping MCPs by functionality (e.g., dev tools, AI services, databases)
- Sharing common configurations across projects
- Managing team-wide vs personal tool configurations

### Method 1: Multiple --config Arguments

In your Claude configuration, you can specify multiple config files:

```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "npx",
      "args": [
        "-y",
        "super-mcp-router@latest",
        "--config",
        "/Users/YOU/.super-mcp/personal-mcps.json",
        "--config",
        "/Users/YOU/.super-mcp/work-mcps.json",
        "--config",
        "/Users/YOU/.super-mcp/shared-mcps.json"
      ]
    }
  }
}
```

### Method 2: Environment Variable (Comma-Separated)

Set the environment variable with comma-separated paths:

```bash
export SUPER_MCP_CONFIG="/path/to/personal.json,/path/to/work.json,/path/to/shared.json"
```

Then use Super MCP normally - it will automatically load all specified configs.

### Example: Organizing by Function

**dev-tools.json:**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/YOU/dev"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

**ai-services.json:**
```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### Important Notes

- **Duplicate IDs**: If the same server ID appears in multiple configs, the last one loaded takes precedence (with a warning logged)
- **Error Handling**: If any config file fails to load, the entire startup fails (fail-fast behavior)
- **Backward Compatible**: Single config files work exactly as before - no changes needed to existing setups
- **Legacy Format**: The old `packages` array format is still supported and automatically converted

## Alternative Installation Methods

While npx is the recommended way to use Super MCP Router (no installation, always up-to-date), you can also:

### Install Globally

```bash
npm install -g super-mcp-router
```

Then use in Claude config:
```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "super-mcp-router",
      "args": [
        "--config",
        "/Users/YOUR_USERNAME/.super-mcp/super-mcp-config.json"
      ]
    }
  }
}
```

To update: `npm update -g super-mcp-router`

### Clone and Build from Source (For Development)

```bash
git clone https://github.com/mindstone/Super-MCP.git
cd Super-MCP
npm install
npm run build
```

Then use in Claude config:
```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "node",
      "args": [
        "/absolute/path/to/Super-MCP/dist/cli.js",
        "--config",
        "/Users/YOUR_USERNAME/.super-mcp/super-mcp-config.json"
      ]
    }
  }
}
```

To update:
```bash
cd /path/to/Super-MCP
git pull
npm install
npm run build
```

## Features

- **Single Interface**: Access all your MCPs through one connection
- **Mixed Transports**: Combine stdio and HTTP MCPs seamlessly
- **HTTP Transport Support**: Both HTTP+SSE (legacy) and Streamable HTTP (recommended)
- **OAuth Support**: Browser-based OAuth flow with persistent token storage
- **Tool Discovery**: Background refresh with fast, health-gated snapshot reads
- **Validation**: Schema validation for all tool arguments
- **Error Handling**: Comprehensive error codes and messages with contextual help
- **Improved Authentication**: Clear error messages guiding users to authenticate when needed
- **Built-in Help System**: Interactive guidance with `get_help` tool
- **Security Policy**: Block or allow specific tools/packages with regex pattern support
- **Hot Reload**: Security config changes apply immediately without restart
- **Portable**: Everything contained within this directory

## Project Structure

```
src/
├── cli.ts              # CLI entry point
├── server.ts           # MCP server with meta-tools
├── registry.ts         # Config loading & package management
├── catalog.ts          # Snapshot state and health-gated catalog reads
├── catalogRefresher.ts # Bounded background connection and refresh ownership
├── catalogFormatters.ts# Pure catalog response formatting
├── security.ts         # Security policy (allowlist/blocklist)
├── configWatcher.ts    # Config hot-reload for security
├── summarize.ts        # Tool summaries & arg skeletons
├── validator.ts        # Argument validation
├── logging.ts          # Structured logging
├── types.ts            # TypeScript definitions
├── handlers/           # Request handlers
│   ├── useTool.ts      # Tool execution with security checks
│   ├── listTools.ts    # Tool discovery with blocked status
│   └── ...             # Other handlers
├── auth/
│   ├── callbackServer.ts # OAuth callback server
│   └── providers/      # OAuth providers
└── clients/
    ├── stdioClient.ts  # Stdio MCP client
    └── httpClient.ts   # HTTP MCP client
```

## Security

### Credential Safety

> **See also**: [OAuth & Authentication](docs/OAUTH_AND_AUTHENTICATION.md) for detailed auth documentation.

- **Never commit your `super-mcp-config.json`** - it contains API keys and credentials
- Tokens stored securely in OS keychain (with file fallback)
- All sensitive data redacted from logs
- File tokens created with 0600 permissions
- Device code flow (no local HTTP server required)

⚠️ **Important**: The `.gitignore` file excludes your config file, but double-check before committing!

### Security Policy (Tool Blocking)

> **See also**: [Security Policy Guide](docs/SECURITY_POLICY_GUIDE.md) for complete security documentation.

Super MCP Router includes a security policy system that lets you control which tools and packages can be used. This is useful for:
- Blocking dangerous operations (e.g., file deletion)
- Restricting access to specific packages
- Creating allowlists for sensitive environments

#### Configuration

Add a `security` section to your config file:

```json
{
  "security": {
    "blockedTools": [
      "filesystem__delete_file",
      "filesystem__write_file",
      "/.*delete.*/i",
      "/.*remove.*/i"
    ],
    "blockedPackages": ["dangerous-package"],
    "allowedPackages": ["filesystem", "github"],
    "allowedTools": ["filesystem__read_file", "filesystem__list_directory"],
    "logBlockedAttempts": true
  },
  "mcpServers": { ... }
}
```

#### Layered Security Model

Both allowlist and blocklist rules apply together (layered):

1. **Allowlist gate**: If `allowedPackages` or `allowedTools` is configured, the item must be on the list
2. **Blocklist gate**: If `blockedPackages` or `blockedTools` is configured, the item must NOT be on the list

| Configuration | Behavior |
|--------------|----------|
| Only blocklist | Everything allowed except blocked items |
| Only allowlist | Only allowed items permitted |
| Both configured | Must be on allowlist AND not on blocklist |
| Neither configured | Everything allowed |

#### Pattern Matching

Tools can be specified as:
- **Exact names**: `"filesystem__delete_file"`
- **Regex patterns**: `"/.*delete.*/i"` (delimited by `/`, optional flags)

#### Hot Reload

Security configuration is hot-reloaded when config files change - no server restart required. Edit your config file and the new rules apply immediately to subsequent tool calls.

## Built-in Help System

> **See also**: [Error Codes Reference](docs/ERROR_CODES_REFERENCE.md) for all error codes with solutions.

Super MCP includes comprehensive built-in help accessible through the `get_help` tool:

### Help Topics
- **getting_started**: Basic workflow and examples
- **workflow**: Common usage patterns
- **authentication**: OAuth and API key setup
- **tool_discovery**: Finding and understanding available tools
- **error_handling**: Troubleshooting error codes
- **common_patterns**: Typical usage scenarios
- **package_types**: Understanding different MCP types

### Usage Examples
```javascript
// Get started with Super MCP
get_help(topic: "getting_started")

// Get help for a specific package
get_help(package_id: "github")

// Get help for an error code
get_help(error_code: -33003)
```

### Enhanced Error Messages
All errors now include contextual guidance pointing to relevant help resources and suggesting next steps.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- --config ./super-mcp-config.json

# Build for production
npm run build
```

## The Mindstone open-source family

This repo is one of several open-source projects from Mindstone:

- [Rebel](https://mindstone.com) — the AI workspace desktop app that uses
  Super-MCP as its tool router (source release in progress).
- [mcp-servers](https://github.com/mindstone/mcp-servers) — source-available
  MCP connectors for popular SaaS tools; works with any MCP host.
- [rebel-system](https://github.com/mindstone/rebel-system) — the public
  Rebel system: skills, prompts, operators, help docs, and templates.
- [meeting-note-recorder](https://github.com/mindstone/meeting-note-recorder)
  — meeting detection, recording, and live transcripts (the Rebel note-taker).

## License

Released under the [MIT License](LICENSE).
