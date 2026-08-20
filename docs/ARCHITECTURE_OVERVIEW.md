# Super-MCP Architecture Overview

High-level overview of Super-MCP's component architecture and request flow.

## See Also

- [README.md](../README.md) – Quick start and configuration guide
- [docs/plans/251208_architecture_improvement_plan.md](plans/251208_architecture_improvement_plan.md) – Internal refactoring notes
- [src/server.ts](../src/server.ts) – MCP server and routing
- [src/registry.ts](../src/registry.ts) – Config and client management
- [src/catalog.ts](../src/catalog.ts) – Health-gated tool snapshots
- [src/catalogRefresher.ts](../src/catalogRefresher.ts) – Background catalog refresh ownership

---

## Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Super-MCP Router                         │
├─────────────────────────────────────────────────────────────┤
│  server.ts          │  Meta-tools: list_tool_packages,      │
│  (MCP Server)       │  list_tools, get_tool_details,        │
│                     │  use_tool, search_tools, get_help,     │
│                     │  authenticate, health_check_all,       │
│                     │  health_check, restart_package,        │
│                     │  record_tool_note                      │
├─────────────────────┼───────────────────────────────────────┤
│  registry.ts        │  Config loading, package management,   │
│  (PackageRegistry)  │  client lifecycle, connection caching  │
├─────────────────────┼───────────────────────────────────────┤
│  catalog.ts         │  Health-gated snapshots, pagination,   │
│  (Catalog)          │  ETags, state diagnostics              │
├─────────────────────┼───────────────────────────────────────┤
│ catalogRefresher.ts │  Bounded background connect/refresh,   │
│ (CatalogRefresher)  │  retry schedule, generation readiness  │
├─────────────────────┼───────────────────────────────────────┤
│  security.ts        │  Layered allowlist/blocklist,          │
│  (SecurityPolicy)   │  pattern matching, hot-reload          │
├─────────────────────┼───────────────────────────────────────┤
│  clients/           │  StdioMcpClient, HttpMcpClient         │
│                     │  Transport-specific implementations     │
└─────────────────────┴───────────────────────────────────────┘
```

### Component Responsibilities

| Component | File | Purpose |
|-----------|------|---------|
| **MCP Server** | `server.ts` | Exposes meta-tools to Claude, routes requests to handlers |
| **PackageRegistry** | `registry.ts` | Loads config files, manages MCP client instances, handles connection lifecycle |
| **Catalog** | `catalog.ts` | Provides synchronous, health-gated snapshot reads and tracks catalog state, schemas, retry diagnostics, and ETags |
| **CatalogRefresher** | `catalogRefresher.ts` | Owns every connect-for-catalog attempt, bounded concurrency/timeouts, retry scheduling, and current-generation readiness |
| **Catalog formatters** | `catalogFormatters.ts` | Shapes summaries and tool information from snapshot data without acquiring clients |
| **Tool Note Handler** | `handlers/recordToolNote.ts` | Validates note recording and removal requests and resolves the exact catalog tool |
| **Tool Notes Store** | `toolNotes.ts` | Persists bounded, expiring per-tool notes shared by the OS user |
| **SecurityPolicy** | `security.ts` | Enforces allowlist/blocklist rules, supports regex patterns, hot-reloads on config changes |
| **MCP Clients** | `clients/` | Transport-specific implementations for STDIO and HTTP connections |

---

## Request Flow

Passive discovery (`list_tool_packages`, `list_tools`, `get_tool_details`, `search_tools`, package help, `/api/tools`, and `/api/tools/manifest`) never connects to a package. A request reads the current `CatalogView`, queues any due background refresh with `CatalogRefresher`, and returns every configured package with an explicit state: `connecting`, `ready`, `auth_required`, `setup_incomplete`, or `error`. Only `ready` entries advertise tools. A degraded package can retain generation-bound last-known-good data for recovery and execution, but passive discovery does not advertise that retained data. There is no time-based retention expiry.

`GET /api/tools` is immediate unless the caller supplies `wait_for_snapshot_ms`. That option races the refresher's current-generation readiness promise against the requested bounded wait. A timeout returns `snapshot_complete: false` plus `degraded_packages`; it does not convert an incomplete snapshot into success.

Every catalog status transition logs `package_id`, `from`, `to`, `reason`, `consecutive_failures`, `next_retry_at`, and `generation`. `/stats` exposes the matching degradation diagnostics for each child. A 500 ms watchdog emits `discovery_watchdog_exceeded` if a passive discovery handler crosses its latency budget.

Explicit execution paths remain allowed to connect within their own bounds. For example, when Claude calls `use_tool(package_id, tool_id, args)`, the following flow occurs:

```
┌─────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌────────┐
│ Claude  │────▶│ server.ts│────▶│ security │────▶│ registry │────▶│ client │
│         │     │          │     │          │     │          │     │        │
│         │◀────│          │◀────│          │◀────│          │◀────│        │
└─────────┘     └──────────┘     └──────────┘     └──────────┘     └────────┘
     1              2                3                4               5-7
```

1. **Claude calls meta-tool** – `use_tool(package_id, tool_id, args)`
2. **server.ts routes request** – Dispatches to `handlers/useTool.ts`
3. **Security policy check** – Verifies tool is not blocked by allowlist/blocklist rules
4. **Registry provides client** – Returns cached client or creates new connection
5. **Catalog validates tool** – Confirms tool exists, provides schema for validation
6. **Client executes tool** – Sends request via transport (STDIO or HTTP) through request queue
7. **Result returned** – Response with telemetry flows back to Claude

---

## Concurrency Model

Super-MCP uses request queues to manage concurrent tool calls and prevent race conditions:

| Transport | Concurrency | Rationale |
|-----------|-------------|-----------|
| **STDIO** | 1 (serialized) | STDIO servers typically cannot handle concurrent requests |
| **HTTP** | 5 (parallel) | HTTP servers handle concurrent connections well |

The request queue ensures:
- STDIO servers receive one request at a time
- HTTP servers aren't overwhelmed by burst traffic
- Responses are correctly matched to requests

---

## Caching Strategy

### Tool Schema Cache
- Tool schemas are refreshed in the background and cached per package generation
- Readers use only the ready snapshot for the current configuration generation
- Last-known-good data may be retained across a degraded state when package identity is unchanged; it is not advertised until the package is ready again
- Cache changes update package and global ETags

### Tool Notes Store
Tool notes use a bounded, OS-user-global store shared by every Super MCP instance and configuration for that OS user, with one note per package/tool pair, a 200-character limit, fixed capacity ceilings, and a hard 30-day TTL. A note surfaces whenever its package ID, tool name, and current schema hash match, so it intentionally follows the tool across MCP hosts and configurations until it expires; schema changes suppress and clean up stale advice. Reads are pull-only: one immutable snapshot is consulted per `get_tool_details` request, and matching notes are never added to list, search, manifest, REST catalog, or tool-advertisement surfaces.

### Auth Error Retry
- Packages returning auth errors are marked with retry delay
- Retry after 60 seconds to allow user authentication
- Prevents continuous failed connection attempts

### Catalog ETags
- Global ETag tracks overall catalog state
- Clients can check if tool list has changed
- Enables efficient polling for catalog updates

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Single interface for multiple MCPs** | Claude sees one unified tool surface instead of managing multiple MCP connections |
| **Transport abstraction** | STDIO and HTTP clients share common interface, making transport choice transparent |
| **Separated discovery and connection** | Passive discovery reads a snapshot while `CatalogRefresher` owns bounded background connections, so one unreachable package cannot delay the catalog |
| **Security policy as separate concern** | Policy rules can be hot-reloaded without restarting server or reconnecting clients |
| **Meta-tool approach** | `use_tool` indirection allows dynamic tool discovery without pre-registering every tool |

---

## Maintenance

Update this document when:
- Major architectural components are added or removed
- Request flow changes significantly
- Concurrency model is modified
- New caching strategies are introduced

---

*Last updated: 2026-03-28*
