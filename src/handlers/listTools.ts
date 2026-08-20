import { ListToolsInput, ListToolsOutput, ERROR_CODES, ToolInfo } from "../types.js";
import type {
  CatalogRefreshScheduler,
  CatalogView,
  PackageMetadataView,
} from "../catalog.js";
import { buildToolInfos, getDiscoveryPackageState } from "../catalogFormatters.js";
import { computeSecurityAnnotation, extractRawToolId } from "./annotateToolSecurity.js";
import {
  coerceStringifiedNumber,
  requirePackageId,
} from "../utils/normalizeInput.js";

export async function handleListTools(
  input: ListToolsInput,
  catalog: CatalogView,
  _validator: any,
  packagesView?: PackageMetadataView,
  refreshScheduler?: CatalogRefreshScheduler,
): Promise<any> {
  let {
    package_id,
    detail = "lite",
    page_size = 20,
    page_token,
  } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  page_size = coerceStringifiedNumber(page_size, { handler: "list_tools", field: "page_size" }) as typeof page_size;

  // Fail fast on a package_id that never usefully arrived (missing/empty/
  // "undefined") instead of letting it flow into the catalog and surface as an
  // opaque "Package 'undefined' is unavailable: …". Shared helper keeps the
  // message (and its list_tool_packages guidance) identical across handlers.
  // Residue-chunk9 item 3, origin 260811_degenerate-output-handling#R4.
  package_id = requirePackageId(package_id, { handler: "list_tools" });

  if (detail !== "lite" && detail !== "full") {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: `Invalid detail value: "${detail}". Must be "lite" or "full".`,
    };
  }

  const effectiveSummarize = detail === "full";
  const effectiveIncludeSchemas = detail === "full";

  refreshScheduler?.scheduleRefresh(package_id);
  const state = getDiscoveryPackageState(catalog, package_id);
  const packageStatus = state.catalogStatus;
  if (packageStatus === "auth_required") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' requires authentication. Run 'authenticate(package_id: "${package_id}")'.`,
      data: { package_id, status: packageStatus },
    };
  }
  if (packageStatus === "setup_incomplete") {
    const reason = catalog.getPackageError(package_id) || "setup_incomplete";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is not set up on this instance. Signing in again will not fix it.`,
      data: { package_id, status: packageStatus, reason },
    };
  }
  if (packageStatus === "error") {
    const reason = catalog.getPackageError(package_id) || "See logs for details";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is unavailable: ${reason}`,
      data: { package_id, status: packageStatus },
    };
  }
  if (packageStatus === "connecting") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' catalog is still connecting.`,
      data: {
        package_id,
        status: packageStatus,
        retry_in_ms: state.retryInMs,
        next_retry_at: state.nextRetryAt,
      },
    };
  }

  const toolInfos = buildToolInfos(package_id, catalog.getPackageTools(package_id), {
    summarize: effectiveSummarize,
    include_schemas: effectiveIncludeSchemas,
    include_descriptions: true,
  });

  // Annotate tools with security blocked status
  const catalogId = packagesView?.getPackage(package_id)?.catalogId;
  const tools: ToolInfo[] = toolInfos.map(tool => ({
    ...tool,
    ...computeSecurityAnnotation(package_id, catalogId, extractRawToolId(tool.tool_id)),
  }));

  const startIndex = page_token ? 
    Math.max(0, parseInt(Buffer.from(page_token, 'base64').toString('utf8'))) : 0;
  const endIndex = startIndex + page_size;
  const pagedTools = tools.slice(startIndex, endIndex);
  
  const nextToken = endIndex < tools.length ? 
    Buffer.from(endIndex.toString()).toString('base64') : null;

  const result: ListToolsOutput = {
    tools: pagedTools,
    next_page_token: nextToken,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}
