# Super-MCP Error Codes Reference

Complete reference for all Super-MCP error codes with causes, solutions, and troubleshooting guidance.

## See Also

- [README.md](../README.md) — Built-in help system via `get_help` tool
- [src/types.ts](../src/types.ts) — Error code constant definitions
- [src/handlers/getHelp.ts](../src/handlers/getHelp.ts) — Error help content and implementation

---

## Error Codes Overview

Super-MCP uses JSON-RPC 2.0 standard error codes alongside custom application-specific codes.

| Code | Name | Description |
|------|------|-------------|
| -32602 | INVALID_PARAMS | Invalid parameters provided |
| -33001 | PACKAGE_NOT_FOUND | Package ID not in configuration |
| -33002 | TOOL_NOT_FOUND | Tool not found in package |
| -33003 | ARG_VALIDATION_FAILED | Tool arguments don't match schema |
| -33004 | PACKAGE_UNAVAILABLE | Package not connected (auth/network) |
| -33005 | AUTH_REQUIRED | Package requires authentication |
| -33006 | AUTH_INCOMPLETE | OAuth flow not finished |
| -33007 | DOWNSTREAM_ERROR | Error from upstream MCP server |
| -33008 | TOOL_BLOCKED | Tool blocked by security policy |
| -32603 | INTERNAL_ERROR | Internal server error |

---

## Detailed Error Guide

### -32602: INVALID_PARAMS

Standard JSON-RPC error indicating the request parameters are malformed or missing.

**Causes:**
- Missing required parameters in the request
- Malformed JSON in the request body
- Wrong parameter types (e.g., string instead of object)
- Mutually exclusive parameters supplied together
- Extra unrecognized parameters (in strict mode)

`record_tool_note` uses `-32602` for request-shape errors: missing, empty, or
wrongly typed `package_id`, `tool_id`, `note`, or `remove` fields; combining a
note with `remove: true`; a `package_id` containing `__`; and a namespaced
`tool_id` that does not resolve as an exact bare tool name. Once the request
shape is valid, domain outcomes remain tool results: `not_found` means the tool
or note does not exist, while `rejected` carries note-policy or store reasons
such as the 200-character limit, capacity, an unsupported store version, or a
retryable lock conflict.

**Solutions:**
1. Check that all required parameters are present
2. Verify parameter types match the expected schema
3. Review the tool's input schema via `get_tool_details`

**Related get_help:** `get_help(topic: "workflow")`

**Example log message:**
```
Invalid params: missing required field 'package_id'
```

---

### -33001: PACKAGE_NOT_FOUND

The specified `package_id` does not exist in the Super-MCP configuration.

**Causes:**
- Typo in the package_id value
- Package not configured in `super-mcp-config.json`
- Using a tool name instead of the package_id
- Case sensitivity mismatch

**Solutions:**
1. Run `list_tool_packages()` to see all available packages
2. Copy the exact package_id from the response
3. Verify the package is defined in your configuration file

**Related get_help:** `get_help(error_code: -33001)`

**Example log message:**
```
Package not found: "github-typo". Available: filesystem, github, notion-api
```

---

### -33002: TOOL_NOT_FOUND

The specified `tool_id` does not exist within the given package.

**Causes:**
- Wrong tool name or typo
- Tool exists in a different package
- Tool name changed or deprecated in upstream MCP server
- Case sensitivity issues

**Solutions:**
1. Run `list_tools(package_id: "your-package")` to browse available tools, then `get_tool_details(tool_ids: ["your-package__tool-name"])` for full schema
2. Verify you're using the correct package
3. Check for case sensitivity in tool names

**Related get_help:** `get_help(error_code: -33002)`

**Example log message:**
```
Tool 'read_files' not found in package 'filesystem'. Did you mean 'read_file'?
```

---

### -33003: ARG_VALIDATION_FAILED

The arguments provided to a tool don't match its expected JSON schema.

**Causes:**
- Missing required fields
- Wrong data types (e.g., sending string instead of number)
- Invalid enum values
- Incorrect nesting of objects/arrays
- Fields exceeding length limits

**Solutions:**
1. Inspect `data.repair_ticket` in the error response for surgical fix guidance:
   - `missing_required`
   - `type_errors`
   - `enum_violations`
   - `format_errors`
   - `unknown_fields` + `did_you_mean`
   - `schema_fragments` (field-level snippets; escalates to full schema on repeated failures)
2. Fix only the fields listed in the repair ticket and retry
3. Use `dry_run: true` with `use_tool` to validate arguments before execution
4. If `repair_ticket.attempt >= 3`, ask the user for clarification before retrying

**Related get_help:** `get_help(error_code: -33003)`

**Example log message:**
```
Argument validation failed for tool 'write_file'. Missing required: content. Type errors: overwrite (expected boolean, got string).
```

**Example error data payload:**
```json
{
  "repair_ticket": {
    "missing_required": ["content"],
    "type_errors": [{"field": "overwrite", "expected": "boolean", "got": "string", "value": "yes"}],
    "enum_violations": [],
    "format_errors": [],
    "unknown_fields": ["filePath"],
    "did_you_mean": {"filePath": "path"},
    "schema_fragments": {
      "content": {"type": "string"},
      "path": {"type": "string"}
    },
    "attempt": 1
  }
}
```

---

### -33004: PACKAGE_UNAVAILABLE

The package is configured but cannot establish a connection.

**Causes:**
- Local MCP server binary not installed or not in PATH
- Network connectivity issues for HTTP packages
- Incorrect command or URL in configuration
- Process crashed or timed out during startup
- Firewall blocking connection

**Solutions:**
1. Run `health_check_all()` to diagnose package status
2. For local packages, verify the command is installed and executable
3. For HTTP packages, check network connectivity
4. Review configuration in `super-mcp-config.json`

**Related get_help:** `get_help(error_code: -33004)`

**Example log message:**
```
Package 'filesystem' unavailable: spawn ENOENT - command 'npx' not found
```

---

### -33005: AUTH_REQUIRED

The package requires authentication before tools can be used.

**Causes:**
- Package uses OAuth and user hasn't authenticated
- API key missing from configuration
- Previous authentication expired

**Solutions:**
1. Run `authenticate(package_id: "package-name")` to start OAuth flow
2. Complete the authorization in your browser
3. Verify authentication with `health_check_all()`

**Related get_help:** `get_help(error_code: -33005)`

**Example log message:**
```
Package 'notion-api' requires authentication. Use authenticate(package_id: "notion-api")
```

---

### -33006: AUTH_INCOMPLETE

OAuth authentication was started but not completed.

**Causes:**
- User closed browser before completing OAuth
- OAuth flow timed out
- Browser redirect failed
- OAuth callback not received

**Solutions:**
1. Run `authenticate(package_id: "...")` again to restart the flow
2. Complete the entire OAuth flow in the browser
3. Check that callback URL is correctly configured
4. Verify the OAuth provider is accessible

**Related get_help:** `get_help(topic: "authentication")`

**Example log message:**
```
Authentication incomplete for 'github': OAuth callback not received within timeout
```

---

### -33007: DOWNSTREAM_ERROR

The upstream MCP server returned an error during tool execution.

**Causes:**
- Expired authentication tokens on upstream server
- Rate limiting by upstream API
- Invalid operation for the upstream service
- Permission denied on upstream resource
- Upstream service outage

**Solutions:**
1. Read the detailed error message from upstream
2. Check for 401/403 errors indicating auth issues
3. Verify you have permission for the requested operation
4. Check rate limits if making many requests
5. Re-authenticate if tokens expired

**Related get_help:** `get_help(error_code: -33007)`

**Example log message:**
```
Downstream error from 'github': 403 Forbidden - Resource not accessible by integration
```

---

### -33008: TOOL_BLOCKED

The tool execution was blocked by the security policy.

**Causes:**
- Tool is in the `blockedTools` list for the package
- Security mode is `audit` or `strict` and tool not in `allowedTools`
- Tool operation violates security policy rules
- Package-level security restrictions

**Solutions:**
1. Check security policy in configuration
2. Add tool to `allowedTools` if it should be permitted
3. Remove tool from `blockedTools` if blocking was unintentional
4. Review security policy mode (`permissive`, `audit`, `strict`)

**Related get_help:** `get_help(topic: "error_handling")`

**Example log message:**
```
Tool 'delete_file' blocked by security policy for package 'filesystem'
```

---

### -32603: INTERNAL_ERROR

Standard JSON-RPC error indicating an unexpected internal failure.

**Causes:**
- Unhandled exception in Super-MCP
- Memory or resource exhaustion
- Bug in Super-MCP or upstream MCP server
- Corrupted internal state

**Solutions:**
1. Check Super-MCP logs for stack trace details
2. Restart Super-MCP if the error persists
3. Report reproducible bugs to the maintainers
4. Try the operation again (may be transient)

**Related get_help:** `get_help(topic: "error_handling")`

**Example log message:**
```
Internal error: unexpected state in tool execution pipeline
```

---

## Using get_help for Errors

The `get_help` tool provides contextual help for error codes directly in the MCP interface:

```javascript
// Get help for a specific error code
get_help(error_code: -33003)

// Get general error handling guidance
get_help(topic: "error_handling")

// Get help for a specific package
get_help(package_id: "filesystem")
```

---

## Common Troubleshooting Flow

When encountering errors, follow this diagnostic sequence:

1. **Check the error code** in the response to identify the error type
2. **Read the error message** for specific details about what went wrong
3. **Run `health_check_all()`** to see overall package status:
   ```javascript
   health_check_all(detailed: true)
   ```
4. **Use `get_help`** for contextual guidance:
   ```javascript
   get_help(error_code: -33003)  // For specific error
   ```
5. **Validate arguments** with dry run before retrying:
   ```javascript
   use_tool(package_id: "...", tool_id: "...", args: {...}, dry_run: true)
   ```
6. **Check logs** for detailed context and stack traces

---

## Maintenance

This document should be updated when:

- New error codes are added to `src/types.ts`
- Error handling behavior changes
- New troubleshooting patterns are discovered
- Help content in `getHelp.ts` is updated
