import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { PackageRegistry } from "./registry.js";
import { assertToolAccess } from "./toolAccess.js";
import { getSecurityPolicy } from "./security.js";
import { getWorkspacePath, runWithForwardedFiles } from "./forwardedFiles.js";

export function createPackageServer(registry: PackageRegistry, packageId: string, workspacePath = getWorkspacePath()): Server {
  const server = new Server({ name: "super-mcp-package", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const allowed = (name: string) => {
    const policy = getSecurityPolicy();
    return !policy.isToolBlocked(packageId, name, false).blocked && !policy.isAdminDisabled(registry.getPackage(packageId)?.catalogId, name) && !policy.isUserDisabled(packageId, name);
  };
  const tools = async () => (await registry.getClient(packageId)).listTools();
  const resourceAllowed = (uri: string, toolList: Awaited<ReturnType<typeof tools>>) => {
    const owners = toolList.filter(tool => tool._meta?.ui?.resourceUri === uri);
    return owners.length === 0 || owners.some(tool => allowed(tool.name));
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    assertToolAccess(registry, packageId);
    return { tools: (await tools()).filter(tool => allowed(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      assertToolAccess(registry, packageId, params.name);
      return await runWithForwardedFiles(params.arguments ?? {}, params._meta?.["rebel/forwardedFiles"], args => registry.callTool(packageId, params.name, args), workspacePath, registry.getPackage(packageId)?.name ?? packageId);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String((error as { message?: string }).message ?? error) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    assertToolAccess(registry, packageId);
    const client = await registry.getClient(packageId);
    const result = client.listResources ? await client.listResources() : { resources: [] };
    const toolList = await tools();
    return { ...result, resources: result.resources.filter(resource => resourceAllowed(resource.uri, toolList)) };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    assertToolAccess(registry, packageId);
    if (!resourceAllowed(params.uri, await tools())) throw new McpError(ErrorCode.InvalidRequest, "Resource access denied");
    const client = await registry.getClient(packageId);
    if (!client.readResource) throw new McpError(ErrorCode.MethodNotFound, "Resources are not supported");
    return { ...await client.readResource(params.uri) };
  });
  return server;
}
