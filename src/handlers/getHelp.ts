import type {
  CatalogRefreshScheduler,
  CatalogView,
  PackageMetadataView,
} from "../catalog.js";
import { coerceStringifiedNumber } from "../utils/normalizeInput.js";

export async function handleGetHelp(
  input: { topic?: string; package_id?: string; error_code?: number },
  packagesView: PackageMetadataView,
  catalog: CatalogView,
  refreshScheduler?: CatalogRefreshScheduler,
): Promise<any> {
  let { topic = "getting_started", package_id, error_code } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  error_code = coerceStringifiedNumber(error_code, { handler: "get_help", field: "error_code" }) as typeof error_code;

  let helpContent = "";

  if (error_code !== undefined) {
    helpContent = getErrorHelp(error_code);
  }
  else if (package_id) {
    helpContent = getPackageHelp(package_id, packagesView, catalog, refreshScheduler);
  }
  else {
    helpContent = getTopicHelp(topic);
  }

  return {
    content: [
      {
        type: "text",
        text: helpContent,
      },
    ],
    isError: false,
  };
}

export function getTopicHelp(topic: string): string {
  const helpTopics: Record<string, string> = {
    getting_started: `# Getting Started with Super-MCP

Super-MCP provides a unified interface to multiple MCP (Model Context Protocol) packages. Here's how to use it effectively:

## Basic Workflow
1. **Discover Packages**: Use \`list_tool_packages\` to see available MCP packages
2. **Browse Tools**: Use \`list_tools(package_id: "...", detail: "lite")\` to see tool names and descriptions
3. **Get Schemas**: Use \`get_tool_details(tool_ids: ["Package__tool_name"])\` to get full schemas before calling a tool
4. **Execute Tools**: Use \`use_tool\` to run a specific tool with appropriate arguments
5. **Search by Intent**: Use \`search_tools(query: "what you want to do")\` to find tools across all packages

## Example Flow
\`\`\`
1. list_tool_packages() → See all available packages
2. list_tools(package_id: "filesystem", detail: "lite") → Browse filesystem tools
3. get_tool_details(tool_ids: ["filesystem__read_file"]) → Get full schema
4. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/test.txt"})
\`\`\`

## Tips
- Always check package health with \`health_check_all\` if tools aren't working
- Some packages require authentication — use \`authenticate\` when needed
- Always call \`get_tool_details\` before using a tool for the first time — never guess argument names
- Use \`dry_run: true\` in use_tool to validate arguments without executing`,

    workflow: `# Super-MCP Workflow Patterns

## Discovery Flow
1. Start with \`list_tool_packages\` to understand available capabilities
2. Note the package_id values for packages you want to use
3. Use \`list_tools(package_id: "...", detail: "lite")\` to browse tools (names + descriptions)
4. Use \`get_tool_details(tool_ids: ["Package__tool_name"])\` to get full schemas before using tools
5. Or use \`search_tools(query: "...")\` to find tools by intent across all packages

## Common Patterns

### File Operations
- Package: usually "filesystem" or similar
- Common tools: read_file, write_file, list_directory
- Always use absolute paths

### API Integrations
- Packages: "github", "notion-api", "slack", etc.
- May require authentication via \`authenticate\`
- Check health_check_all to verify connection status

### Search Operations
- Look for packages with "search" in the name
- Tools often have query parameters with specific syntax
- Use dry_run to test complex queries

## Error Recovery
- If a tool fails, check the error message for guidance
- Use \`get_help(error_code: <code>)\` for specific error help
- Verify authentication status for API packages
- Use \`get_tool_details\` to review the exact schema before retrying`,

    authentication: `# Authentication in Super-MCP

## Overview
Some MCP packages require authentication to access their APIs (e.g., Notion, Slack, GitHub private repos).

## How to Authenticate
1. **Check Status**: Run \`health_check_all\` to see which packages need auth
2. **Start Auth**: Use \`authenticate(package_id: "package-name")\`
3. **Complete in Browser**: A browser window opens for authorization
4. **Verify**: Run \`health_check_all\` again to confirm authentication

## Package Types
- **Local (stdio)**: No authentication needed, runs locally
- **Public APIs**: May work without auth but with limitations
- **Private APIs**: Always require authentication (OAuth)

## Troubleshooting
- If authentication fails, try again - OAuth tokens can expire
- Some packages store tokens securely and remember authentication
- Check package documentation for specific auth requirements`,

    tool_discovery: `# Discovering Tools in Super-MCP

## Understanding Package Structure
Each package contains related tools. The packages available depend on your super-mcp configuration — always call \`list_tool_packages()\` first to see what's actually configured. Do not assume a package is available because you've seen its name in an example; examples are illustrative, not an inventory.

Common package patterns you may encounter (availability depends on config):
- **filesystem**: File and directory operations
- **github**: Repository, issue, and PR management
- **notion-api**: Page and database operations

## Using list_tools Effectively
\`\`\`
// Browse tools (names + descriptions only)
list_tools(package_id: "github", detail: "lite")

// Get full schemas for specific tools
get_tool_details(tool_ids: ["github__search_repositories", "github__get_repository"])

// Or get everything at once (larger response)
list_tools(package_id: "github", detail: "full")
\`\`\`

## Reading Tool Schemas
- Required fields are marked in the schema
- Check type constraints (string, number, boolean, object, array)
- Note any enum values for restricted options
- Look for format hints (uri, email, date)

## Tips
- Use \`detail: "lite"\` for browsing, \`get_tool_details\` for schemas before calling tools
- Use \`search_tools\` when you know what you want to do but not which tool to use
- Page through results if a package has many tools`,

    error_handling: `# Error Handling in Super-MCP

## Common Error Codes

### -33001: PACKAGE_NOT_FOUND
- The package_id doesn't exist
- Solution: Use \`list_tool_packages\` to see valid package IDs

### -33002: TOOL_NOT_FOUND
- The tool_id doesn't exist in the specified package
- Solution: Use \`search_tools(query: "...")\` to find tools by intent, or \`list_tools(package_id: "...", detail: "lite")\` to browse

### -33003: ARG_VALIDATION_FAILED
- Arguments don't match the tool's schema
- Solution: Use \`get_tool_details\` to review the exact schema, then fix your arguments
- Use dry_run: true to test arguments
- \`max_output_chars\`, \`output_offset\`, \`schema_hash\`, \`dry_run\` and \`result_id\` are top-level \`use_tool\` parameters — never nest them inside \`args\` (args holds the tool's own arguments only)

### -33004: PACKAGE_UNAVAILABLE
- Package is configured but not responding
- Solution: Check \`health_check_all\` and verify configuration

### -33005: AUTH_REQUIRED
- Package needs authentication
- Solution: Use \`authenticate(package_id)\`

### -33007: DOWNSTREAM_ERROR
- The underlying MCP server returned an error
- Solution: Check error details and tool documentation

## Best Practices
- Always validate arguments match the schema
- Use dry_run for testing complex operations
- Check health status before troubleshooting
- Read error messages carefully - they often contain the solution`,

    common_patterns: `# Common Patterns in Super-MCP

## File Management Pattern
\`\`\`
1. list_tools(package_id: "filesystem", detail: "lite")  // Browse tools
2. get_tool_details(tool_ids: ["filesystem__read_file"])  // Get schema
3. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/data.txt"})
4. use_tool(package_id: "filesystem", tool_id: "write_file", args: {path: "/tmp/output.txt", content: "..."})
\`\`\`

## API Search Pattern
\`\`\`
1. authenticate(package_id: "github")  // If needed
2. search_tools(query: "search github repositories")  // Find by intent
3. get_tool_details(tool_ids: ["github__search_repositories"])  // Get schema
4. use_tool(package_id: "github", tool_id: "search_repositories", args: {query: "language:python"})
\`\`\`

## Data Processing Pattern
\`\`\`
1. Read data from one source
2. Process/transform the data
3. Write to another destination
4. Verify the operation succeeded
\`\`\`

## Diagnostic Pattern
\`\`\`
1. health_check_all(detailed: true)
2. Identify problematic packages
3. authenticate() if needed
4. Retry failed operations
\`\`\``,

    package_types: `# Package Types in Super-MCP

## Local (stdio) Packages
- Run as local processes on your machine
- No network latency
- Full access to local filesystem (with permissions)
- Examples: filesystem, git, docker
- Configuration: command and args

## HTTP/SSE Packages
- Connect to remote MCP servers
- May require authentication (OAuth)
- Subject to network latency and limits
- Examples: notion-api, slack, cloud services
- Configuration: url and optional headers

## Package Capabilities
Different packages offer different capabilities:

### Data Access
- filesystem: Local file operations
- database packages: SQL queries
- API packages: Cloud service data

### Automation
- git: Version control operations
- docker: Container management
- ci/cd packages: Pipeline control

### Integration
- notion-api: Workspace management
- slack: Communication automation
- github: Repository management

## Choosing Packages
- Use local packages for file/system operations
- Use HTTP packages for cloud services
- Check authentication requirements upfront
- Consider rate limits for API packages`,
  };

  return helpTopics[topic] || `Unknown help topic: ${topic}. Available topics: ${Object.keys(helpTopics).join(", ")}`;
}

export function getErrorHelp(errorCode: number): string {
  const errorHelp: Record<number, string> = {
    [-33001]: `# Error -33001: PACKAGE_NOT_FOUND

This error means the package_id you specified doesn't exist.

## How to Fix
1. Run \`list_tool_packages()\` to see all available packages
2. Copy the exact package_id from the response
3. Use that package_id in your request

## Common Causes
- Typo in package_id
- Package not configured in super-mcp-config.json
- Using tool name instead of package_id`,

    [-33002]: `# Error -33002: TOOL_NOT_FOUND

The tool_id doesn't exist in the specified package.

## How to Fix
1. Use \`search_tools(query: "...")\` to find tools by intent
2. Or run \`list_tools(package_id: "your-package", detail: "lite")\` to browse available tools
3. Use the exact tool_id from the response

## Common Causes
- Wrong package selected
- Tool name changed or deprecated
- Case sensitivity issues`,

    [-33003]: `# Error -33003: ARG_VALIDATION_FAILED

The arguments provided don't match the tool's expected schema.

## How to Fix
1. Run \`get_tool_details(tool_ids: ["Package__tool_name"])\` to review the exact schema
2. Ensure all required fields are present
3. Check that types match exactly (string vs number)
4. Use \`dry_run: true\` to test before executing
5. Keep \`max_output_chars\`, \`output_offset\`, \`schema_hash\`, \`dry_run\` and \`result_id\` at the TOP LEVEL of the \`use_tool\` call — they are \`use_tool\` parameters, not tool arguments, so nesting them inside \`args\` will be rejected

## Common Issues
- Missing required fields
- Wrong data types (sending string instead of number)
- Invalid enum values
- Incorrect nesting of objects`,

    [-33004]: `# Error -33004: PACKAGE_UNAVAILABLE

The package exists but isn't responding.

## How to Fix
1. Run \`health_check_all()\` to check status
2. If it shows "error", check your configuration
3. For local packages, ensure the command is installed
4. For HTTP packages, check network connectivity

## Common Causes
- Local MCP server not installed
- Network issues for HTTP packages
- Incorrect configuration in super-mcp-config.json`,

    [-33005]: `# Error -33005: AUTH_REQUIRED

The package requires authentication before use.

## How to Fix
1. Run \`authenticate(package_id: "package-name")\`
2. Complete OAuth flow in browser
3. Try your operation again
4. If authenticate() says 'already_authenticated' but tools still fail, use \`authenticate(package_id: "package-name", force: true)\` to force re-authentication

## Notes
- Some packages require API keys in config
- OAuth tokens may expire and need refresh
- Use \`force: true\` when tokens are stale but the system thinks auth is valid
- Check package documentation for auth setup`,

    [-33007]: `# Error -33007: DOWNSTREAM_ERROR

The underlying MCP server returned an error.

## How to Fix
1. Read the error message details carefully
2. Check if it's an auth issue (401/403) — run \`authenticate(package_id: "...")\`
3. If authenticate() says 'already_authenticated' but tools still fail, use \`authenticate(package_id: "...", force: true)\` to force re-authentication
4. Verify the operation is valid for that package
5. Check package-specific documentation

## Common Causes
- Expired authentication tokens (use \`force: true\` to re-authenticate)
- Rate limiting
- Invalid operations for the package
- Permissions issues`,
  };

  const help = errorHelp[errorCode];
  if (help) {
    return help;
  }

  return `# Error Code ${errorCode}

This error code is not specifically documented.

## General Troubleshooting
1. Check the error message for details
2. Run \`health_check_all()\` to verify package status
3. Use \`list_tools\` to verify the tool exists
4. Validate arguments with \`dry_run: true\`
5. Check if authentication is needed

For more help, try:
- \`get_help(topic: "error_handling")\`
- \`get_help(topic: "workflow")\``;
}

export function getPackageHelp(
  packageId: string,
  packagesView: PackageMetadataView,
  catalog: CatalogView,
  refreshScheduler?: CatalogRefreshScheduler,
): string {
  try {
    const pkg = packagesView.getPackage(packageId);
    if (!pkg) {
      return `# Package Not Found: ${packageId}

The package "${packageId}" doesn't exist.

Run \`list_tool_packages()\` to see available packages.`;
    }

    let toolCount = 0;
    let toolExamples = "";
    refreshScheduler?.scheduleRefresh(packageId);
    const tools = catalog.getPackageTools(packageId);
    toolCount = tools.length;

    if (tools.length > 0) {
      const exampleTools = tools.slice(0, 5).map(t => `- ${t.tool.name}: ${t.tool.description || 'No description'}`).join('\n');
      toolExamples = `
## Available Tools (showing first 5 of ${toolCount})
${exampleTools}

Use \`list_tools(package_id: "${packageId}", detail: "lite")\` to browse all tools.`;
    } else if (catalog.getPackageStatus(packageId) !== "ready") {
      toolExamples = `
## Tools
The catalog snapshot for this package is not currently available.
Run \`list_tool_packages()\` for its status and retry guidance.`;
    }

    const authInfo = pkg.transport === "http" && pkg.oauth 
      ? `
## Authentication
This package requires OAuth authentication.
Use \`authenticate(package_id: "${packageId}")\` to connect.`
      : pkg.transport === "stdio"
      ? `
## Authentication
This is a local package - no authentication needed.`
      : "";

    return `# Package: ${pkg.name || packageId}

${pkg.description || 'No description available'}

## Basic Info
- **ID**: ${packageId}
- **Type**: ${pkg.transport}
- **Status**: Run \`health_check_all()\` to check
${pkg.transport === "http" ? `- **URL**: ${pkg.base_url || 'Not specified'}` : ''}
${toolExamples}
${authInfo}

## Usage Example
\`\`\`
// 1. Browse available tools
list_tools(package_id: "${packageId}", detail: "lite")

// 2. Get full schema for a specific tool
get_tool_details(tool_ids: ["${packageId}__tool_name"])

// 3. Execute the tool
use_tool(
  package_id: "${packageId}",
  tool_id: "tool_name",
  args: { /* tool-specific arguments */ }
)
\`\`\`

## Troubleshooting
- If tools aren't working, check \`health_check_all()\`
- Always use \`get_tool_details\` to review schemas before calling tools
- Test arguments: Add \`dry_run: true\` to use_tool`;

  } catch (error) {
    return `Error generating help for package ${packageId}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
