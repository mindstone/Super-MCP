import { expandReadInputs, getReadInputs } from './fileReadInputs.js';
import { effectiveInputBases } from './fileReadPreflight.js';
import { assertDispatchActive, captureToolDispatch, DECLARED_FORWARDING, FileReadAdmissionError } from './fileReadProtocol.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { PackageRegistry } from "./registry.js";
import { assertToolAccess } from "./toolAccess.js";
import { getSecurityPolicy } from "./security.js";
import { isSafetyDisabled } from "./safetyDisabledTools.js";
import { forwardedFilesSchema, getWorkspacePath, runWithForwardedFiles } from "./forwardedFiles.js";
import { ERROR_CODES } from "./types.js";

export function createPackageServer(registry: PackageRegistry, packageId: string, workspacePath = getWorkspacePath()): Server {
  const server = new Server({ name: "super-mcp-package", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, ...(registry.getPackage(packageId)?.transport === 'stdio' ? { experimental: { [DECLARED_FORWARDING]: { version: 1 } } } : {}) } });
  const allowed = (name: string) => {
    const policy = getSecurityPolicy();
    const pkg = registry.getPackage(packageId);
    return !policy.isToolBlocked(packageId, name, false).blocked && !isSafetyDisabled(pkg, name) && !policy.isAdminDisabled(pkg?.catalogId, name) && !policy.isUserDisabled(packageId, name);
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
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      assertToolAccess(registry, packageId, params.name);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
    }
    try {
      const context = captureToolDispatch(server.getClientCapabilities()?.experimental?.['files/readAuthority'], params._meta, extra);
      assertDispatchActive(context);
      const forwarded = params._meta?.["rebel/forwardedFiles"];
      if (forwarded !== undefined && !forwardedFilesSchema.safeParse(forwarded).success) throw new Error('Invalid forwarded files');
      const config = registry.getPackage(packageId);
      let operands;
      if (forwarded !== undefined && config?.transport === 'stdio') {
        const client = await registry.getClient(packageId);
        const declaration = getReadInputs(await client.getToolMetadata?.(params.name));
        if (declaration) operands = await expandReadInputs(params.arguments ?? {}, declaration, effectiveInputBases(config, client));
      }
      // Package-home senders have no originating home authority. Their child
      // receives explicit standalone, preserving strict remote-only reads.
      return await runWithForwardedFiles(params.arguments ?? {}, forwarded,
        args => registry.callTool(packageId, params.name, args, context), workspacePath, config?.name ?? packageId, operands);
    } catch (error) {
      if (error instanceof FileReadAdmissionError) return { isError: true, content: [{ type: 'text', text: error.message }] };
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
