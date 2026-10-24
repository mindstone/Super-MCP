import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { PackageRegistry } from "./registry.js";
import { assertToolAccess, callAllowedTool } from "./toolAccess.js";
import { getValidator } from "./validator.js";

export function createPackageServer(registry: PackageRegistry, packageId: string): Server {
  const server = new Server({ name: "super-mcp-package", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const allowed = (name: string) => {
    try { assertToolAccess(registry, packageId, name); return true; } catch { return false; }
  };
  const tools = async () => (await registry.getClient(packageId)).listTools();
  const resourceAllowed = (uri: string, toolList: Awaited<ReturnType<typeof tools>>) => {
    const owners = toolList.filter(tool => tool._meta?.ui?.resourceUri === uri);
    return owners.length === 0 || owners.some(tool => allowed(tool.name));
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await tools()).filter(tool => allowed(tool.name)) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      assertToolAccess(registry, packageId, params.name);
      const tool = (await tools()).find(tool => tool.name === params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
      const validation = getValidator().validate(tool.inputSchema, params.arguments ?? {});
      if (!validation.valid) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
      return await callAllowedTool(registry, packageId, params.name, params.arguments ?? {});
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
