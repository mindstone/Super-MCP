# Super-MCP Timeout Configuration

Guide to configuring tool execution timeouts for long-running MCP operations.

## See Also

- [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) — `timeout` field reference
- [src/clients/stdioClient.ts](../src/clients/stdioClient.ts) — Stdio timeout implementation
- [src/clients/httpClient.ts](../src/clients/httpClient.ts) — HTTP timeout implementation
- [CHANGELOG.md](../CHANGELOG.md) — v1.4.0 timeout changes

---

## Timeout Precedence

Timeouts are resolved in the following order (highest priority first):

1. **Per-server `timeout` field** — Set in the server configuration
2. **`SUPER_MCP_TOOL_TIMEOUT` environment variable** — Global override
3. **Default: 1,800,000ms (30 minutes)** — Fallback when neither is set

The default lives in `src/clients/stdioClient.ts` and `src/clients/httpClient.ts` as the literal `'1800000'` env-var fallback. It was raised from 5 min to 30 min to align with Rebel Core's `TOOL_CALL_TIMEOUT` so long-running tools (deep research, browser pair waiting, large data queries, human-in-the-loop flows) aren't killed at the super-mcp layer before the outer Rebel timer fires.

---

## Configuration Options

### Per-Server Timeout

Set a timeout for a specific MCP server in your configuration:

```json
{
  "mcpServers": {
    "deep-research": {
      "command": "npx",
      "args": ["-y", "octagon-deep-research-mcp"],
      "timeout": 600000
    }
  }
}
```

This sets a 10-minute timeout for the `deep-research` server, overriding the default.

### Global Environment Variable

Set a global timeout for all servers that don't have an explicit timeout configured:

```bash
export SUPER_MCP_TOOL_TIMEOUT=600000
```

This is useful for:
- Development environments where you want longer timeouts across the board
- CI/CD pipelines with different performance characteristics
- Quick adjustments without modifying config files

---

## Progress-Based Timeout Reset

Super-MCP uses `resetTimeoutOnProgress: true` when calling tools. This means:

- **The timeout resets** each time the MCP server sends a progress notification
- **Long operations succeed** as long as they report periodic progress
- **Stalled operations fail** if no progress is reported within the timeout window

This enables operations that may take longer than the configured timeout, as long as the MCP server implements progress notifications.

---

## Recommended Timeouts by Use Case

| Use Case | Recommended Timeout | Notes |
|----------|---------------------|-------|
| File operations | 60,000ms (1 min) | Read/write local files |
| API calls | 120,000ms (2 min) | External HTTP requests |
| Search/research | 600,000ms (10 min) | Web search, document retrieval |
| Data processing | 900,000ms (15 min) | Batch processing, transformations |
| AI generation | 1,200,000ms (20 min) | LLM calls, image generation |

---

## Troubleshooting Timeouts

### Error: "Tool execution timed out"

When you see this error:

1. **Check if the MCP server supports progress notifications** — Servers that report progress can run longer than the timeout
2. **Increase the timeout** for known slow operations using per-server config
3. **Monitor logs for `duration_ms`** — This shows how long operations actually take
4. **Consider the operation type** — Research and AI tasks often need longer timeouts

### Example: Increasing Timeout for Slow Server

```json
{
  "mcpServers": {
    "slow-research-tool": {
      "command": "npx",
      "args": ["-y", "my-research-mcp"],
      "timeout": 900000
    }
  }
}
```

---

## History

- **Post-v2.5.0** (commit `035f2fb`): Default timeout raised from 300,000ms (5 minutes) to 1,800,000ms (30 minutes) to align both stdio and HTTP client defaults with Rebel Core's `TOOL_CALL_TIMEOUT`. Long-running tools (deep research, Rebel Browser pair waiting, large data queries, human-in-the-loop flows) were being killed at the super-mcp layer before the outer Rebel timer fired.
- **v1.4.0**: Default timeout changed from 60,000ms (1 minute) to 300,000ms (5 minutes) to better support long-running operations like research and AI generation.

---

## Maintenance

This document should be updated when:
- Timeout behavior or defaults change in `src/clients/stdioClient.ts` or `src/clients/httpClient.ts`
- New timeout-related configuration options are added to `src/types.ts`
- Progress notification handling changes
