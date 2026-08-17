import { ListToolsInput, ListToolsOutput, ERROR_CODES, ToolInfo } from "../types.js";
import { Catalog } from "../catalog.js";
import { PackageRegistry } from "../registry.js";
import { computeSecurityAnnotation, extractRawToolId } from "./annotateToolSecurity.js";
import { coerceStringifiedNumber } from "../utils/normalizeInput.js";

export async function handleListTools(
  input: ListToolsInput,
  catalog: Catalog,
  _validator: any,
  registry?: PackageRegistry
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

  // Required-parameter pre-validation: list_tools cannot operate without a
  // package_id. Guarding up front turns the misleading "Package 'undefined' is
  // unavailable" (ensurePackageLoaded falling through to the status branch)
  // into an actionable contract error naming the absent field.
  if (typeof package_id !== "string" || package_id.trim().length === 0) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: "Missing required parameter: package_id",
      data: { field: "package_id" },
    };
  }

  if (detail !== "lite" && detail !== "full") {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: `Invalid detail value: "${detail}". Must be "lite" or "full".`,
    };
  }

  const effectiveSummarize = detail === "full";
  const effectiveIncludeSchemas = detail === "full";

  await catalog.ensurePackageLoaded(package_id);
  const packageStatus = catalog.getPackageStatus(package_id);
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

  const toolInfos = await catalog.buildToolInfos(package_id, {
    summarize: effectiveSummarize,
    include_schemas: effectiveIncludeSchemas,
    include_descriptions: true,
  });

  // Annotate tools with security blocked status
  const catalogId = registry?.getPackage(package_id)?.catalogId;
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
