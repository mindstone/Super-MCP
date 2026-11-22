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

describe("Actions run attribution after argument repair", () => {
  const source = { kind: "automation", automationId: "daily", automationName: "Daily report", sessionId: "model-run" };
  const item = { title: "Review report", source };
  const itemSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      source: { type: "object", properties: {
        kind: { const: "automation" }, automationId: { type: "string" },
        automationName: { type: "string" }, sessionId: { type: "string" },
      }, required: ["kind", "automationId", "automationName"], additionalProperties: false },
    },
    required: ["title", "source"], additionalProperties: false,
  };
  const shapes = ["canonical", "Source", "echoed envelope", "stringified batch", "add batch shortcut", "proposed Action"] as const;

  for (const callerSessionId of ["host-run", undefined]) {
    it(`stamps the RebelInternal package alias (${callerSessionId ?? "unknown caller"})`, async () => {
      const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(itemSchema, {
        packageId: "RebelInternal", toolIds: ["rebel_inbox_add"],
      });
      const result = await handleUseTool({
        package_id: "RebelInternal", tool_id: "rebel_inbox_add", args: item,
      }, mockRegistry, mockCatalog, validator, { callerSessionId });
      expect(result.isError).toBe(false);
      expect(mockClient.callTool).toHaveBeenCalledWith("rebel_inbox_add", {
        title: item.title,
        source: { kind: "automation", automationId: "daily", automationName: "Daily report",
          ...(callerSessionId ? { sessionId: callerSessionId } : {}) },
      });
    });

    it.each(shapes)(`uses only host attribution (${callerSessionId ?? "unknown caller"}) for %s`, async shape => {
      const batch = shape === "stringified batch" || shape === "add batch shortcut";
      const toolId = shape === "stringified batch" ? "rebel_inbox_add_many"
        : shape === "proposed Action" ? "rebel_inbox_propose" : "rebel_inbox_add";
      const schema = batch ? {
        type: "object", properties: { items: { type: "array", items: itemSchema } },
        required: ["items"], additionalProperties: false,
      } : itemSchema;
      const args = shape === "Source" ? { title: item.title, Source: source }
        : shape === "echoed envelope" ? { package_id: "RebelInbox", tool_id: toolId, args: item }
          : batch ? { items: shape === "stringified batch" ? JSON.stringify([item]) : [item] } : item;
      const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
        packageId: "RebelInbox", toolIds: [toolId],
      });
      const result = await handleUseTool({
        package_id: "RebelInbox", tool_id: toolId, args,
        // An echoed model metadata field cannot become host call context.
        _meta: { "rebel/callerSessionId": "model-meta-run" },
      } as Parameters<typeof handleUseTool>[0], mockRegistry, mockCatalog, validator, { callerSessionId });
      expect(result.isError).toBe(false);
      const expectedSource = { kind: "automation", automationId: "daily", automationName: "Daily report",
        ...(callerSessionId ? { sessionId: callerSessionId } : {}) };
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
      expect(mockClient.callTool).toHaveBeenCalledWith(toolId,
        batch ? { items: [{ title: item.title, source: expectedSource }] } : { title: item.title, source: expectedSource });
      expect(source.sessionId).toBe("model-run");
    });
  }
});

describe("useTool — an Action an automation run creates links its run", () => {
  const callerAutomation = { automationId: "intro-drafts", automationName: "Intro drafts" };
  const runSource = { kind: "automation", ...callerAutomation, sessionId: "host-run" };
  const brief = { kind: "workspace", path: "Chief-of-Staff/intro.md", label: "Introduction draft" };
  const open = { type: "object" };
  const schema = { type: "object", properties: {
    title: { type: "string" }, source: open, references: { type: "array" },
    items: { type: "array", items: { type: "object" } },
  } };
  const call = async (toolId: string, args: Record<string, unknown>, context: Parameters<typeof handleUseTool>[4]) => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, { packageId: "RebelInbox", toolIds: [toolId] });
    const result = await handleUseTool({ package_id: "RebelInbox", tool_id: toolId, args }, mockRegistry, mockCatalog, validator, context);
    expect(result.isError).toBe(false);
    return mockClient.callTool.mock.calls.at(-1)![1];
  };

  const host = { callerSessionId: "host-run", callerAutomation };
  const schema2 = { ...schema, properties: { ...schema.properties, source: {}, references: {} } };
  const callLoose = async (toolId: string, args: Record<string, unknown>) => {
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema2, { packageId: "RebelInbox", toolIds: [toolId] });
    const result = await handleUseTool({ package_id: "RebelInbox", tool_id: toolId, args }, mockRegistry, mockCatalog, validator, host);
    expect(result.isError).toBe(false);
    return mockClient.callTool.mock.calls.at(-1)![1];
  };

  it.each(["rebel_inbox_add", "rebel_inbox_propose"])("moves a workspace source into references for %s", async toolId => {
    expect(await call(toolId, { title: "Review intro", source: brief }, host))
      .toEqual({ title: "Review intro", source: runSource, references: [brief] });
  });

  it.each(["rebel_inbox_add", "rebel_inbox_propose"])("treats a string source as text, label kept, for %s", async toolId => {
    expect(await callLoose(toolId, { title: "Review intro", source: "  From the sweep " }))
      .toEqual({ title: "Review intro", source: { ...runSource, label: "From the sweep" } });
    expect(await callLoose(toolId, { title: "Review intro", source: "   " }))
      .toEqual({ title: "Review intro", source: runSource });
  });

  it.each([
    ["one reference object", { kind: "url", url: "https://example.com/context" }],
    ["one path string", "other.md"],
  ])("keeps the workspace path beside %s", async (_case, reference) => {
    expect(await callLoose("rebel_inbox_add", { title: "Review intro", source: brief, references: reference }))
      .toEqual({ title: "Review intro", source: runSource, references: [reference, brief] });
    expect(await callLoose("rebel_inbox_add", { title: "Review intro", source: brief, references: brief.path }))
      .toEqual({ title: "Review intro", source: runSource, references: [brief.path] });
  });

  it("gives an automation source the host's run automation, never the model's", async () => {
    expect(await call("rebel_inbox_add", { title: "Review intro", source: {
      kind: "automation", automationId: "model-choice", automationName: "Model choice", sessionId: "model-run", label: "Weekly",
    } }, host)).toEqual({ title: "Review intro", source: { ...runSource, label: "Weekly" } });
  });

  it("applies the rule to each item of a batch", async () => {
    const sent = await callLoose("rebel_inbox_add_many", { items: [
      { title: "No source" },
      { title: "Text", source: { kind: "text", label: "Sweep" } },
      { title: "String", source: "Sweep" },
      { title: "Referenced", source: brief, references: [{ kind: "workspace", path: brief.path }] },
      { title: "Referenced by path", source: brief, references: [brief.path] },
      { title: "One reference", source: brief, references: "other.md" },
      { title: "Model run", source: { kind: "automation", automationId: "x", automationName: "X", sessionId: "guess" } },
      { title: "Role", source: { kind: "role", roleId: "r", roleName: "Chief of staff" } },
      { title: "Meeting", source: { kind: "meeting", meetingId: "m" } },
      { title: "Conversation", source: { kind: "conversation", sessionId: "other" } },
    ] });
    expect(sent).toEqual({ items: [
      { title: "No source", source: runSource },
      { title: "Text", source: { ...runSource, label: "Sweep" } },
      { title: "String", source: { ...runSource, label: "Sweep" } },
      { title: "Referenced", source: runSource, references: [{ kind: "workspace", path: brief.path }] },
      { title: "Referenced by path", source: runSource, references: [brief.path] },
      { title: "One reference", source: runSource, references: ["other.md", brief] },
      { title: "Model run", source: runSource },
      { title: "Role", source: { kind: "role", roleId: "r", roleName: "Chief of staff" } },
      { title: "Meeting", source: { kind: "meeting", meetingId: "m" } },
      { title: "Conversation", source: { kind: "conversation", sessionId: "other" } },
    ] });
  });

  it.each([
    ["no host automation", { callerSessionId: "host-run" }],
    ["an automation without a caller session", { callerAutomation }],
  ])("leaves a workspace or text source as given with %s", async (_case, context) => {
    expect(await call("rebel_inbox_add", { title: "Review intro", source: brief }, context))
      .toEqual({ title: "Review intro", source: brief });
    expect(await call("rebel_inbox_add", { title: "Review intro", source: { kind: "text", label: "Notes" } }, context))
      .toEqual({ title: "Review intro", source: { kind: "text", label: "Notes" } });
    expect(await call("rebel_inbox_add", { title: "Review intro" }, context)).toEqual({ title: "Review intro" });
  });
});

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

  it("repairs a stringified array argument (FOX-7659) and dispatches the parsed array", async () => {
    const schema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
        },
      },
      required: ["sections"],
      additionalProperties: false,
    };
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
      packageId: "RebelCanvas",
      toolIds: ["rebel_canvas_view"],
    });

    const response = await handleUseTool(
      {
        package_id: "RebelCanvas",
        tool_id: "rebel_canvas_view",
        args: { sections: '[{"type":"draft"}]' },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_canvas_view", {
      sections: [{ type: "draft" }],
    });
    const superMcp = (response as { _meta?: Record<string, unknown> })._meta?.superMcp as
      | Record<string, unknown>
      | undefined;
    expect(superMcp?.normalisations).toEqual(["auto_repair_coerce:sections"]);
  });

  // A union branch with no type accepts strings, so a string there is already valid:
  // repairing an unrelated field must never also parse it (FOX-7659 review).
  it("keeps a string an untyped union branch accepts while repairing another field", async () => {
    const schema = {
      type: "object",
      properties: {
        value: { anyOf: [{ type: "array" }, { properties: { x: { type: "number" } } }] },
        count: { type: "integer" },
      },
    };
    const { mockRegistry, mockCatalog, validator, mockClient } = createMocks(schema, {
      packageId: "RebelCanvas",
      toolIds: ["rebel_canvas_view"],
    });

    const response = await handleUseTool(
      {
        package_id: "RebelCanvas",
        tool_id: "rebel_canvas_view",
        args: { value: "[1]", count: "2" },
        max_output_chars: null,
      },
      mockRegistry,
      mockCatalog,
      validator,
    );

    expect(response.isError).toBe(false);
    expect(mockClient.callTool).toHaveBeenCalledWith("rebel_canvas_view", { value: "[1]", count: 2 });
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
