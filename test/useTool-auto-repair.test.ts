// Stage 0 — end-to-end test for the schema-driven validate-before-send
// auto-repair in the useTool dispatch path. Uses the REAL Validator so a
// genuine -33003-class failure (camelCase key + stringified scalar) is repaired
// and re-validated, while a genuinely-wrong call still throws -33003 unchanged.
//
// See: super-mcp/src/handlers/useTool.ts (validate→repair→re-validate seam)

import { describe, it, expect, vi } from "vitest";
import { handleUseTool } from "../src/handlers/useTool.js";
import { PackageRegistry } from "../src/registry.js";
import { Catalog } from "../src/catalog.js";
import { Validator } from "../src/validator.js";

const CALENDAR_SCHEMA = {
  type: "object",
  properties: {
    email: { type: "string" },
    device_timezone: { type: "string" },
    max_results: { type: "integer" },
    return_json: { type: "boolean" },
  },
  required: ["email"],
  additionalProperties: false,
};

function createMocks(
  schema: unknown = CALENDAR_SCHEMA,
  target: { packageId: string; toolIds: string[] } = {
    packageId: "GoogleWorkspace-test",
    toolIds: ["list_workspace_calendar_events", "noop"],
  },
) {
  const { packageId, toolIds } = target;
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn((id: string) => (id === packageId ? { id: packageId } : undefined)),
    getClient: vi.fn().mockResolvedValue(mockClient),
    // Stage 6: useTool now dispatches via registry.callTool (lease + liveness gate);
    // delegate to the same mocked client so existing callTool assertions hold.
    callTool: async (_pkg: string, toolId: string, toolArgs: unknown) => mockClient.callTool(toolId, toolArgs),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const getTool = (packageId: string, toolId: string) =>
    packageId === target.packageId && toolIds.includes(toolId)
      ? { packageId, tool: { name: toolId, inputSchema: schema }, schemaHash: "" }
      : undefined;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getRefreshInFlight: vi.fn().mockReturnValue(false),
    getPackageError: vi.fn().mockReturnValue(undefined),
    getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
    getTool: vi.fn().mockImplementation(getTool),
    getToolSchema: vi.fn().mockImplementation(
      (packageId: string, toolId: string) => getTool(packageId, toolId)?.tool.inputSchema,
    ),
  } as unknown as Catalog;
  // REAL validator — exercises the actual strip-in-place + re-validate contract.
  const validator = new Validator();
  return { mockRegistry, mockCatalog, validator, mockClient };
}

const toolScopedAliasCases = [
  {
    packageId: "Slack-test",
    toolId: "search_slack_messages",
    source: "max_results",
    destination: "count",
    value: 12,
  },
  {
    packageId: "RebelSearchAndConversations",
    toolId: "rebel_search_files",
    source: "max_results",
    destination: "limit",
    value: 7,
  },
  {
    packageId: "RebelSearchAndConversations",
    toolId: "rebel_conversations_send_message",
    source: "message",
    destination: "text",
    value: "Please continue",
  },
  {
    packageId: "RebelSearchAndConversations",
    toolId: "rebel_conversations_start",
    source: "message",
    destination: "text",
    value: "Investigate the renewal",
  },
];

describe("useTool — Stage 0 schema-driven auto-repair", () => {
  it.each(toolScopedAliasCases)(
    "repairs $toolId.$source → $destination and records the key_alias breadcrumb",
    async ({ packageId, toolId, source, destination, value }) => {
      const schema = {
        type: "object",
        properties: { [destination]: { type: typeof value } },
        required: [destination],
        additionalProperties: false,
      };
      const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
        packageId,
        toolIds: [toolId],
      });

      const response = await handleUseTool(
        {
          package_id: packageId,
          tool_id: toolId,
          args: { [source]: value },
        },
        mockRegistry,
        mockCatalog,
        validator,
      );

      expect(response.isError).toBe(false);
      expect(mockClient.callTool).toHaveBeenCalledWith(toolId, { [destination]: value });
      expect(response._meta?.superMcp?.normalisations).toEqual([
        `key_alias:${source}→${destination}`,
      ]);
    },
  );

  it("preserves an explicit destination when its tool-scoped alias source is also present", async () => {
    const schema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    };
    const packageId = "RebelSearchAndConversations";
    const toolId = "rebel_conversations_start";
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
      packageId,
      toolIds: [toolId],
    });

    const response = await handleUseTool(
      {
        package_id: packageId,
        tool_id: toolId,
        args: { message: "Alias value", text: "Explicit value" },
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith(toolId, { text: "Explicit value" });
    expect(response._meta?.superMcp?.normalisations).toEqual([
      "key_alias_skipped:message→text:target_exists",
    ]);
  });

  it("leaves an unrelated tool's declared message field untouched", async () => {
    const schema = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    };
    const packageId = "RebelSearchAndConversations";
    const toolId = "rebel_unrelated_message_tool";
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
      packageId,
      toolIds: [toolId],
    });

    const response = await handleUseTool(
      {
        package_id: packageId,
        tool_id: toolId,
        args: { message: "Keep this field" },
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith(toolId, { message: "Keep this field" });
    expect(response._meta?.superMcp).not.toHaveProperty("normalisations");
  });

  it("repairs deviceTimezone→device_timezone + max_results:'20'→20 and dispatches the repaired args", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-test",
        tool_id: "list_workspace_calendar_events",
        args: {
          email: "user@example.com",
          deviceTimezone: "Europe/London",
          max_results: "20",
          return_json: "true",
        },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_calendar_events", {
      email: "user@example.com",
      device_timezone: "Europe/London",
      max_results: 20,
      return_json: true,
    });

    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp?.normalisations).toEqual([
      "auto_repair_key:deviceTimezone→device_timezone",
      "auto_repair_coerce:max_results",
      "auto_repair_coerce:return_json",
    ]);
  });

  it("a genuinely-wrong call (unknown field with no canonical match) still throws -33003", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    await expect(
      handleUseTool(
        {
          package_id: "GoogleWorkspace-test",
          tool_id: "list_workspace_calendar_events",
          args: { email: "user@example.com", totally_unknown_field: "x" },
          max_output_chars: null,
        },
        mockRegistry,
        mockCatalog,
        validator,
      ),
    ).rejects.toMatchObject({ code: -33003 });

    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("does not auto-repair when a required field is genuinely missing (still -33003)", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    await expect(
      handleUseTool(
        {
          package_id: "GoogleWorkspace-test",
          tool_id: "list_workspace_calendar_events",
          // missing required `email`; deviceTimezone alone can't make it valid
          args: { deviceTimezone: "Europe/London" },
          max_output_chars: null,
        },
        mockRegistry,
        mockCatalog,
        validator,
      ),
    ).rejects.toMatchObject({ code: -33003 });

    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("leaves an already-valid call untouched (no auto_repair breadcrumbs)", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-test",
        tool_id: "list_workspace_calendar_events",
        args: { email: "user@example.com", max_results: 5 },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("list_workspace_calendar_events", {
      email: "user@example.com",
      max_results: 5,
    });
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const superMcp = meta?.superMcp as Record<string, unknown> | undefined;
    expect(superMcp).not.toHaveProperty("normalisations");
  });

  it("does NOT coerce a large id-like string (stays a string; required field present so passes)", async () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string" },
        external_id: { type: "string" }, // declared string — never coerced anyway
      },
      required: ["email"],
      additionalProperties: false,
    };
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema);

    const response = await handleUseTool(
      {
        package_id: "GoogleWorkspace-test",
        tool_id: "noop",
        args: { email: "user@example.com", external_id: "12345678901234567890" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("noop", {
      email: "user@example.com",
      external_id: "12345678901234567890",
    });
  });

  // Cross-family GPT review (Stage 0): a non-canonical integer string for an integer-only
  // field must NOT be silently coerced — it stays -33003 (the model corrects explicitly).
  it("does NOT coerce a non-canonical integer string (max_results:'1e3') — stays -33003", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    await expect(
      handleUseTool(
        {
          package_id: "GoogleWorkspace-test",
          tool_id: "list_workspace_calendar_events",
          args: { email: "user@example.com", max_results: "1e3" },
          max_output_chars: null,
        },
        mockRegistry,
        mockCatalog,
        validator,
      ),
    ).rejects.toMatchObject({ code: -33003 });

    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  // A repair that FIRES (a key gets canonical-normalized) but whose re-validation still
  // FAILS must throw the original ticket and leak NO auto_repair breadcrumbs.
  it("a fired-but-insufficient repair still -33003 and leaks no breadcrumbs", async () => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks();

    // maxResults→max_results normalizes (repair fires), but required `email` is missing,
    // so re-validation still fails → original ticket, no dispatch, no breadcrumb leak.
    await expect(
      handleUseTool(
        {
          package_id: "GoogleWorkspace-test",
          tool_id: "list_workspace_calendar_events",
          args: { maxResults: "20" },
          max_output_chars: null,
        },
        mockRegistry,
        mockCatalog,
        validator,
      ),
    ).rejects.toMatchObject({ code: -33003 });

    expect(mockClient.callTool).not.toHaveBeenCalled();
  });
});

// FOX-9491 — the model sometimes echoes the use_tool envelope inside `args`:
// `args: { package_id, tool_id, args: {...} }`, or `package_id`/`tool_id` beside the
// real arguments. Seen across Rebel's own and third-party tools (Sentry REBEL-61R,
// "Unknown fields: package_id, tool_id[, args]"). The echo names this very call, so
// it is repaired deterministically, and only when the repaired call validates.
describe("useTool — echoed use_tool envelope inside args (FOX-9491)", () => {
  const MEETINGS_SCHEMA = {
    type: "object",
    properties: {
      startDate: { type: "string" },
      endDate: { type: "string" },
    },
    required: ["startDate"],
    additionalProperties: false,
  };
  const target = { packageId: "RebelMeetings", toolIds: ["rebel_meetings_history"] };

  async function call(args: Record<string, unknown>, schema: unknown = MEETINGS_SCHEMA) {
    const mocks = createMocks(schema, target);
    const run = handleUseTool(
      { package_id: "RebelMeetings", tool_id: "rebel_meetings_history", args },
      mocks.mockRegistry,
      mocks.mockCatalog,
      mocks.validator,
    );
    return { run, mockClient: mocks.mockClient };
  }

  it("unwraps a nested envelope that names this call", async () => {
    const { run, mockClient } = await call({
      package_id: "RebelMeetings",
      tool_id: "rebel_meetings_history",
      args: { startDate: "2026-11-01" },
    });
    const response = await run;
    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_meetings_history", {
      startDate: "2026-11-01",
    });
    expect(response._meta?.superMcp?.normalisations).toEqual(["auto_repair_envelope_echo"]);
  });

  it("drops a flat envelope echo beside the real arguments (namespaced tool_id too)", async () => {
    const { run, mockClient } = await call({
      package_id: "RebelMeetings",
      tool_id: "RebelMeetings__rebel_meetings_history",
      startDate: "2026-11-01",
    });
    await run;
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_meetings_history", {
      startDate: "2026-11-01",
    });
  });

  it("leaves the refusal alone when the nested tool_id names a different tool", async () => {
    const { run, mockClient } = await call({
      tool_id: "rebel_meetings_today",
      args: { startDate: "2026-11-01" },
    });
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("leaves the refusal alone when the unwrapped arguments have an unknown field", async () => {
    const { run, mockClient } = await call({
      tool_id: "rebel_meetings_history",
      args: { startDate: "2026-11-01", fromDate: "2026-11-01" },
    });
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("leaves the refusal alone when the unwrapped arguments miss a required field", async () => {
    const { run, mockClient } = await call({
      tool_id: "rebel_meetings_history",
      args: { endDate: "2026-11-01" },
    });
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("leaves the refusal alone when one present envelope key disagrees with the call", async () => {
    const { run, mockClient } = await call({
      package_id: "GoogleWorkspace",
      tool_id: "rebel_meetings_history",
      args: { startDate: "2026-11-01" },
    });
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  it("keeps an inner __proto__ key as data, never as the arguments' prototype", async () => {
    const inner = JSON.parse('{"__proto__": {"startDate": "2026-11-01"}}');
    const { run, mockClient } = await call({ tool_id: "rebel_meetings_history", args: inner });
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });

  // Each veto case sends `count` as a string so the call fails first validation and
  // reaches the Stage 0 repairs; without the veto, the repair would drop the key.
  const withCount = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties: { ...properties, count: { type: "integer" } },
    ...extra,
  });

  it("never drops a tool_id the tool's own schema declares", async () => {
    const schema = withCount({ tool_id: { type: "string" } }, { additionalProperties: false });
    const { run, mockClient } = await call({ tool_id: "rebel_meetings_history", count: "1" }, schema);
    await run;
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_meetings_history", {
      tool_id: "rebel_meetings_history",
      count: 1,
    });
  });

  it("never drops an envelope key whose canonical twin the schema declares", async () => {
    const schema = withCount({ toolId: { type: "string" } }, { additionalProperties: false });
    const { run, mockClient } = await call({ tool_id: "rebel_meetings_history", count: "1" }, schema);
    await run;
    // The canonical-key repair maps it onto the declared property instead.
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_meetings_history", {
      toolId: "rebel_meetings_history",
      count: 1,
    });
  });

  it.each([
    ["additionalProperties: true", { additionalProperties: true }],
    ["anyOf composition", { anyOf: [{ required: ["count"] }] }],
  ])("never touches a schema that could accept the key (%s)", async (_label, extra) => {
    const schema = withCount({}, extra);
    const { run, mockClient } = await call({ package_id: "RebelMeetings", count: "1" }, schema);
    await run;
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_meetings_history", {
      package_id: "RebelMeetings",
      count: 1,
    });
  });

  it("never drops a key that patternProperties accepts, even beside additionalProperties: false", async () => {
    // The validator itself refuses this key today (it strips by `properties` only);
    // the repair must not turn that refusal into a call without the key.
    const schema = withCount({}, {
      additionalProperties: false,
      patternProperties: { "^package_id$": { type: "string" } },
    });
    const { run, mockClient } = await call({ package_id: "RebelMeetings", count: "1" }, schema);
    await expect(run).rejects.toMatchObject({ code: -33003 });
    expect(mockClient.callTool).not.toHaveBeenCalled();
  });
});
