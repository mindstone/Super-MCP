import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { PackageRegistry } from "./registry.js";
import { assertToolAccess } from "./toolAccess.js";
import { getSecurityPolicy } from "./security.js";
import { ERROR_CODES } from "./types.js";

export function createPackageServer(registry: PackageRegistry, packageId: string): Server {
  const server = new Server({ name: "super-mcp-package", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const allowed = (name: string) => {
    const policy = getSecurityPolicy();
    return !policy.isToolBlocked(packageId, name, false).blocked && !policy.isAdminDisabled(registry.getPackage(packageId)?.catalogId, name) && !policy.isUserDisabled(packageId, name);
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: string }).message ?? error);
  // The registry knows this state; keep the words for older clients while carrying the type.
  const withSignInState = async (error: unknown): Promise<unknown> =>
    (await registry.connectForCatalog(packageId)).kind === "auth_required"
      ? Object.assign(new Error(errorText(error)), { code: ERROR_CODES.AUTH_REQUIRED, data: { package_id: packageId, status: "auth_required" } })
      : error;
  const tools = async () => {
    try { return await (await registry.getClient(packageId)).listTools(); }
    catch (error) { throw await withSignInState(error); }
  };
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
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
    }
    try {
      return await registry.callTool(packageId, params.name, params.arguments ?? {});
    } catch (error) {
      const typed = await withSignInState(error);
      if (typed !== error) throw typed;
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
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
