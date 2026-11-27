import { expandReadInputs, getReadInputs } from './fileReadInputs.js';
import { effectiveInputBases } from './fileReadPreflight.js';
import { assertDispatchActive, captureToolDispatch, childCallContext, DECLARED_FORWARDING, FileReadAdmissionError, type ChildToolCallContext, type OriginExtra } from './fileReadProtocol.js';
import { risingProgress } from './clients/requestQueueProgress.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { RegistryClosedError, type PackageRegistry } from "./registry.js";
import { HOME_MARKER_GUARD, HOME_MARKER_KEY, REGISTRY_CLOSED_MARKER } from "./homeAdmission.js";
import { assertToolAccess } from "./toolAccess.js";
import { getSecurityPolicy } from "./security.js";
import { safetyBlock } from "./safetyDisabledTools.js";
import { forwardedFilesSchema, getWorkspacePath, runWithForwardedFiles } from "./forwardedFiles.js";
import { collectReturnedFiles, RETURNED_FILES_META } from "./returnedFiles.js";
import { ERROR_CODES } from "./types.js";
import { getLogger } from "./logging.js";

export function createPackageServer(registry: PackageRegistry, packageId: string, workspacePath = getWorkspacePath()): Server {
  const server = new Server({ name: "super-mcp-package", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, experimental: {
    [HOME_MARKER_GUARD]: { version: 1 }, ...(registry.getPackage(packageId)?.transport === 'stdio' ? { [DECLARED_FORWARDING]: { version: 1 } } : {}),
  } } });
  const allowed = (name: string) => {
    const policy = getSecurityPolicy();
    const pkg = registry.getPackage(packageId);
    return !policy.isToolBlocked(packageId, name, false).blocked && safetyBlock(pkg, name) === undefined && !policy.isAdminDisabled(pkg?.catalogId, name) && !policy.isUserDisabled(packageId, name);
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: string }).message ?? error);
  // The registry knows this state; keep the words for older clients while carrying the type.
  const withSignInState = async (error: unknown): Promise<unknown> =>
    (await registry.connectForCatalog(packageId)).kind === "auth_required"
      ? Object.assign(new Error(errorText(error)), { code: ERROR_CODES.AUTH_REQUIRED, data: { package_id: packageId, status: "auth_required" } })
      : error;
  // Only this endpoint's own closed registry may carry the marker. Any other
  // error reaching a handler, from a connector (parsed JSON) or our own code,
  // loses it, without mutating the caught value. In-process code is trusted; a
  // hostile object built here is out of scope.
  const ownRefusals = new WeakSet<McpError>();
  const withoutMarker = (error: unknown): unknown => {
    if (typeof error !== "object" || error === null || ownRefusals.has(error as McpError)) return error;
    const caught = error as { code?: unknown; message?: unknown; data?: unknown; stack?: unknown };
    if (typeof caught.data !== "object" || caught.data === null || !(HOME_MARKER_KEY in caught.data)) return error;
    const { [HOME_MARKER_KEY]: _marker, ...data } = caught.data as Record<string, unknown>;
    if (error instanceof McpError) return Object.assign(new McpError(error.code, ""), { message: error.message, data, stack: error.stack });
    return Object.assign(new Error(), { message: caught.message, data, stack: caught.stack }, "code" in caught ? { code: caught.code } : {});
  };
  const guarded = <A extends unknown[], R>(handler: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try { return await handler(...args); }
      catch (error) { throw withoutMarker(error); }
    };
  // Each step of one request (finding a healthy client, a listing, the call) may wait in the connector's queue;
  // one rising sequence keeps their progress numbers in order.
  const capture = (authority: unknown, metadata: Record<string, unknown> | undefined, extra: OriginExtra) => {
    const captured = captureToolDispatch(authority, metadata, extra);
    return captured.onprogress ? { ...captured, onprogress: risingProgress(captured.onprogress) } : captured;
  };
  const tools = async (waiting?: ChildToolCallContext) => {
    try { return await (await registry.getClient(packageId, false, waiting)).listTools(waiting); }
    catch (error) { throw await withSignInState(error); }
  };
  const resourceAllowed = (uri: string, toolList: Awaited<ReturnType<typeof tools>>) => {
    const owners = toolList.filter(tool => tool._meta?.ui?.resourceUri === uri);
    return owners.length === 0 || owners.some(tool => allowed(tool.name));
  };
  server.setRequestHandler(ListToolsRequestSchema, guarded(async ({ params }, extra) => {
    assertToolAccess(registry, packageId);
    // A call that needs the tool's details first lists them here: it hears if the listing waits.
    return { tools: (await tools(childCallContext(capture(undefined, params?._meta, extra)))).filter(tool => allowed(tool.name)) };
  }));
  server.setRequestHandler(CallToolRequestSchema, guarded(async ({ params }, extra) => {
    try {
      assertToolAccess(registry, packageId, params.name, params.arguments);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
    }
    try {
      const context = capture(server.getClientCapabilities()?.experimental?.['files/readAuthority'], params._meta, extra);
      assertDispatchActive(context);
      const forwarded = params._meta?.["rebel/forwardedFiles"];
      if (forwarded !== undefined && !forwardedFilesSchema.safeParse(forwarded).success) throw new Error('Invalid forwarded files');
      const config = registry.getPackage(packageId);
      let operands;
      if (forwarded !== undefined && config?.transport === 'stdio') {
        const client = await registry.getClient(packageId, false, childCallContext(context));
        const declaration = getReadInputs(await client.getToolMetadata?.(params.name, childCallContext(context)));
        if (declaration) operands = await expandReadInputs(params.arguments ?? {}, declaration, effectiveInputBases(config, client));
      }
      // Package-home senders have no originating home authority. Their child
      // receives explicit standalone, preserving strict remote-only reads.
      return await runWithForwardedFiles(params.arguments ?? {}, forwarded,
        async args => {
          const startedAt = Date.now();
          const result = await registry.callTool(packageId, params.name, args, context);
          const request = params._meta?.["rebel/returnFiles"];
          if (!request || typeof request !== 'object' || Array.isArray(request) || (request as { version?: unknown }).version !== 1) return result;
          try {
            const envelope = await collectReturnedFiles(result, workspacePath, undefined, startedAt);
            return { ...result, _meta: { ...result._meta, [RETURNED_FILES_META]: envelope } };
          } catch (error) {
            getLogger().warn('Returned file collection failed after tool completion', { code: (error as NodeJS.ErrnoException)?.code });
            return { ...result, _meta: { ...result._meta, [RETURNED_FILES_META]: { version: 1, files: [], references: [], collectionFailed: true } } };
          }
        }, workspacePath, config?.name ?? packageId, operands);
    } catch (error) {
      if (error instanceof FileReadAdmissionError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      // Before the sign-in lookup, which can itself throw once the registry is closed.
      if (error instanceof RegistryClosedError) {
        const refusal = new McpError(ErrorCode.InternalError, error.message, { [HOME_MARKER_KEY]: REGISTRY_CLOSED_MARKER });
        ownRefusals.add(refusal);
        throw refusal;
      }
      const typed = await withSignInState(error);
      if (typed !== error) throw typed;
      if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) throw error;
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
    }
  }));
  server.setRequestHandler(ListResourcesRequestSchema, guarded(async () => {
    assertToolAccess(registry, packageId);
    const client = await registry.getClient(packageId);
    const result = client.listResources ? await client.listResources() : { resources: [] };
    const toolList = await tools();
    return { ...result, resources: result.resources.filter(resource => resourceAllowed(resource.uri, toolList)) };
  }));
  server.setRequestHandler(ReadResourceRequestSchema, guarded(async ({ params }) => {
    assertToolAccess(registry, packageId);
    if (!resourceAllowed(params.uri, await tools())) throw new McpError(ErrorCode.InvalidRequest, "Resource access denied");
    const client = await registry.getClient(packageId);
    if (!client.readResource) throw new McpError(ErrorCode.MethodNotFound, "Resources are not supported");
    return { ...await client.readResource(params.uri) };
  }));
  return server;
}
