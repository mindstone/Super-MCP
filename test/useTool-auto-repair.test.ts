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

function createMocks(schema: unknown = CALENDAR_SCHEMA) {
  const mockClient = {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
  const mockRegistry = {
    getPackage: vi.fn().mockReturnValue({ id: "GoogleWorkspace-test" }),
    getClient: vi.fn().mockResolvedValue(mockClient),
    notifyActivity: vi.fn(),
  } as unknown as PackageRegistry;
  const mockCatalog = {
    ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
    getPackageStatus: vi.fn().mockReturnValue("ready"),
    getToolSchema: vi.fn().mockResolvedValue(schema),
  } as unknown as Catalog;
  // REAL validator — exercises the actual strip-in-place + re-validate contract.
  const validator = new Validator();
  return { mockRegistry, mockCatalog, validator, mockClient };
}

describe("useTool — Stage 0 schema-driven auto-repair", () => {
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
});
