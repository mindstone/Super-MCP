# Super-MCP Architecture Overview

High-level overview of Super-MCP's component architecture and request flow.

## See Also

- [README.md](../README.md) – Quick start and configuration guide
- [docs/plans/251208_architecture_improvement_plan.md](plans/251208_architecture_improvement_plan.md) – Internal refactoring notes
- [src/server.ts](../src/server.ts) – MCP server and routing
- [src/registry.ts](../src/registry.ts) – Config and client management
- [src/catalog.ts](../src/catalog.ts) – Tool caching

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
│                     │  health_check, restart_package         │
├─────────────────────┼───────────────────────────────────────┤
│  registry.ts        │  Config loading, package management,   │
│  (PackageRegistry)  │  client lifecycle, connection caching  │
├─────────────────────┼───────────────────────────────────────┤
│  catalog.ts         │  Tool discovery, schema caching,       │
│  (Catalog)          │  pagination, ETags                     │
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
| **Catalog** | `catalog.ts` | Discovers tools from connected MCPs, caches schemas, tracks catalog changes via ETags |
| **SecurityPolicy** | `security.ts` | Enforces allowlist/blocklist rules, supports regex patterns, hot-reloads on config changes |
| **MCP Clients** | `clients/` | Transport-specific implementations for STDIO and HTTP connections |

---

## Request Flow

When Claude calls `use_tool(package_id, tool_id, args)`, the following flow occurs:

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
- Tool schemas are cached per-package after first discovery
- Cache invalidated via ETag changes from MCP servers
- Reduces round-trips for repeated tool calls

### Tool Notes Store
Tool notes use a bounded, OS-user-local store with one note per package/tool pair, a 200-character limit, fixed capacity ceilings, and a hard 30-day TTL. A note is tied to the tool's current schema hash, so schema changes suppress and clean up stale advice. Reads are pull-only: one immutable snapshot is consulted per `get_tool_details` request, and matching notes are never added to list, search, manifest, REST catalog, or tool-advertisement surfaces.

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
| **Lazy client initialization** | Clients connect on first use, not at startup—faster boot and lower resource usage |
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
