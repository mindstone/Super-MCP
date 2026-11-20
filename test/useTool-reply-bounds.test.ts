import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PackageRegistry } from "../src/registry.js";
import type { Catalog } from "../src/catalog.js";

// The reply's size and the paging route, end to end through handleUseTool.
// The result cache is module state, so each test imports a fresh copy.

type HandleUseTool = typeof import("../src/handlers/useTool.js").handleUseTool;
let handleUseTool: HandleUseTool;

const SAFETY_NET_FLOOR = 200_000;

function mocks(toolResult: unknown) {
  const getTool = (packageId: string, toolId: string) =>
    packageId === "pkg1" && toolId === "tool1"
      ? { packageId, tool: { name: toolId, inputSchema: { type: "object" } }, schemaHash: "" }
      : undefined;
  return {
    registry: {
      getPackage: vi.fn().mockReturnValue({ id: "pkg1" }),
      callTool: async () => toolResult,
      notifyActivity: vi.fn(),
    } as unknown as PackageRegistry,
    catalog: {
      ensurePackageLoaded: vi.fn().mockResolvedValue(undefined),
      getPackageStatus: vi.fn().mockReturnValue("ready"),
      getRefreshInFlight: vi.fn().mockReturnValue(false),
      getPackageError: vi.fn().mockReturnValue(undefined),
      getRetryHint: vi.fn().mockReturnValue({ retryAt: null, retryInMs: null, schedule: "none" }),
      getTool: vi.fn().mockImplementation(getTool),
      getToolSchema: vi.fn().mockImplementation((p: string, t: string) => getTool(p, t)?.tool.inputSchema),
    } as unknown as Catalog,
    validator: { validate: vi.fn().mockReturnValue({ valid: true, errors: [], strippedArgs: [] }) },
  };
}

async function call(toolResult: unknown, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const { registry, catalog, validator } = mocks(toolResult);
  const outer = await handleUseTool(
    { package_id: "pkg1", tool_id: "tool1", args, ...extra } as never,
    registry,
    catalog,
    validator as never,
  );
  return outer.content[0].text as string;
}

async function page(resultId: string, offset: number) {
  const { registry, catalog, validator } = mocks(undefined);
  const outer = await handleUseTool(
    { package_id: "_", tool_id: "_", args: {}, result_id: resultId, output_offset: offset } as never,
    registry,
    catalog,
    validator as never,
  );
  return outer.content[0].text as string;
}

// Same rule as Rebel's parseUseToolEnvelopeJson: the JSON document ends at the first blank line.
function leadingJson(text: string): any {
  expect(text.startsWith("{")).toBe(true);
  const end = text.indexOf("\n\n");
  return JSON.parse(end === -1 ? text : text.slice(0, end));
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

// A 150,000-char result with no workspace is cut at 100,000 and cached for paging.
async function cutResultId(marker = ""): Promise<string> {
  const reply = leadingJson(await call(textResult(`${marker}${"p".repeat(150_000)}`)));
  expect(reply.telemetry.output_truncated).toBe(true);
  return reply.telemetry.result_id;
}

let tempWorkspace: string | undefined;
let originalWorkspace: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  ({ handleUseTool } = await import("../src/handlers/useTool.js"));
  originalWorkspace = process.env.REBEL_WORKSPACE_PATH;
  delete process.env.REBEL_WORKSPACE_PATH;
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalWorkspace === undefined) delete process.env.REBEL_WORKSPACE_PATH;
  else process.env.REBEL_WORKSPACE_PATH = originalWorkspace;
  if (tempWorkspace) await fs.rm(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = undefined;
});

async function useWorkspace(): Promise<string> {
  tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "super-mcp-reply-bounds-"));
  process.env.REBEL_WORKSPACE_PATH = tempWorkspace;
  return tempWorkspace;
}

const hugeArgs = () => ({ title: "Made-up quarterly plan", document: "d".repeat(3_000_000) });

describe("the argument echo keeps the reply bounded", () => {
  it("a tiny result with huge arguments: the whole reply is within the limit and says the echo was shortened", async () => {
    const text = await call(textResult("tiny result TINY_MARKER"), hugeArgs());
    expect(text.length).toBeLessThanOrEqual(SAFETY_NET_FLOOR);
    const reply = leadingJson(text);
    expect(reply.args_used.status).toBe("args_shortened");
    expect(reply.args_used.message).toMatch(/shortened/i);
    // The tiny result itself is not given up to make room for the arguments.
    expect(reply.result).toEqual(textResult("tiny result TINY_MARKER"));
  });

  it("a large result saved to a file, with huge arguments: the whole reply is within the limit", async () => {
    await useWorkspace();
    const text = await call(textResult("s".repeat(50_000)), hugeArgs());
    expect(text.length).toBeLessThanOrEqual(SAFETY_NET_FLOOR);
    const reply = leadingJson(text);
    expect(reply.result.status).toBe("materialized");
    expect(reply.args_used.status).toBe("args_shortened");
  });

  it("normal-sized arguments are echoed exactly, in the cut reply and in the saved-file reply", async () => {
    const args = { query: "made-up search", filters: { year: 2026, tags: ["a", "b"] }, note: "n".repeat(5_000) };
    const cut = leadingJson(await call(textResult("c".repeat(150_000)), args));
    expect(cut.telemetry.output_truncated).toBe(true);
    expect(cut.args_used).toEqual(args);

    await useWorkspace();
    const saved = leadingJson(await call(textResult("s".repeat(50_000)), args));
    expect(saved.result.status).toBe("materialized");
    expect(saved.args_used).toEqual(args);
  });
});

describe("the paging id comes early in the JSON", () => {
  it("100,000 non-ASCII chars kept: the reply starts with JSON and carries the paging id before args_used and result", async () => {
    const text = await call(textResult("€".repeat(150_000)), { query: "made-up" });
    const reply = leadingJson(text);
    const resultId = reply.telemetry.result_id;
    expect(typeof resultId).toBe("string");
    expect(reply.paging.result_id).toBe(resultId);
    expect(reply.paging.output_offset).toBe(0);
    expect(reply.paging.hint).toMatch(/result_id/);
    expect(text.indexOf('"paging"')).toBeLessThan(text.indexOf('"args_used"'));
    expect(text.indexOf(resultId)).toBeLessThan(text.indexOf('"result"'));
    // The trailing hint stays.
    expect(text.slice(text.lastIndexOf("\n\n"))).toContain(`result_id: "${resultId}"`);
  });
});

describe("paging a cut result", () => {
  it("joins the pages back into the full cached reply and the original payload", async () => {
    const line = "Made-up line of a long report, numbered for checking.\n";
    const original = line.repeat(Math.ceil(250_000 / line.length)) + "END_OF_REPORT";
    const args = { query: "made-up" };
    const first = leadingJson(await call(textResult(original), args));
    expect(first.telemetry.output_truncated).toBe(true);
    const resultId = first.telemetry.result_id;

    let joined = "";
    let offset = 0;
    let pages = 0;
    for (;;) {
      const chunk = leadingJson(await page(resultId, offset));
      expect(chunk.continuation).toBe(true);
      expect(chunk.offset).toBe(offset);
      joined += chunk.content;
      offset += chunk.length;
      pages += 1;
      if (!chunk.has_more) {
        expect(offset).toBe(chunk.total_chars);
        break;
      }
    }
    expect(pages).toBeGreaterThan(1);

    // The cache holds the serialized untruncated reply, so the pages join to exactly that.
    const cachedReply = {
      package_id: "pkg1",
      tool_id: "tool1",
      args_used: args,
      result: textResult(original),
      telemetry: { duration_ms: first.telemetry.duration_ms, status: "ok" },
    };
    expect(joined).toBe(JSON.stringify(cachedReply, null, 2));
    expect(JSON.parse(joined).result.content[0].text).toBe(original);
  });

  it("an id still pages just under 5 minutes and is gone just over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-20T10:00:00Z").getTime();
    vi.setSystemTime(start);
    const resultId = await cutResultId();

    vi.setSystemTime(start + 5 * 60 * 1000 - 1);
    expect(leadingJson(await page(resultId, 0)).continuation).toBe(true);

    vi.setSystemTime(start + 5 * 60 * 1000 + 1);
    expect(await page(resultId, 0)).toMatch(/expired or not found/);
  });

  it("after more than 50 cached results the oldest id is gone and a recent one still pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-20T10:00:00Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      vi.setSystemTime(start + i);
      ids.push(await cutResultId(`entry-${i}-`));
    }
    expect(await page(ids[0], 0)).toMatch(/expired or not found/);
    const recent = leadingJson(await page(ids[50], 0));
    expect(recent.continuation).toBe(true);
    expect(recent.content).toContain("entry-50-");
  });
});

describe("max_output_chars: null", () => {
  it("returns the exact inner text of a 300,000-char result and writes no file", async () => {
    const workspace = await useWorkspace();
    const original = "u".repeat(299_990) + "END_MARKER";
    const text = await call(textResult(original), {}, { max_output_chars: null });
    const reply = leadingJson(text);
    expect(reply.result.content[0].text).toBe(original);
    await expect(fs.readdir(path.join(workspace, ".rebel", "tool-outputs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});

describe("the argument echo is shortened only for very large arguments", () => {
  const normalArgs = () => ({ query: "made-up search", filters: { year: 2026, tags: ["a", "b"] }, note: "n".repeat(5_000) });
  const largeStructured = () => ({
    content: [{ type: "text", text: "short made-up summary" }],
    structuredContent: { rows: Array.from({ length: 3_000 }, (_, i) => ({ id: i, value: "v".repeat(90) })) },
  });

  it("normal-sized arguments beside a large structured result, no workspace: echoed exactly", async () => {
    const args = normalArgs();
    const reply = leadingJson(await call(largeStructured(), args));
    expect(reply.result.status).toBe("oversized_output");
    expect(reply.args_used).toEqual(args);
  });

  it("normal-sized arguments beside a large structured result, with a workspace: echoed exactly", async () => {
    await useWorkspace();
    const args = normalArgs();
    const reply = leadingJson(await call(largeStructured(), args));
    expect(reply.result.status).toBe("materialized");
    expect(reply.args_used).toEqual(args);
  });

  it("text beside an image that escapes past the limit is saved, so the saved-file reply stays bounded", async () => {
    await useWorkspace();
    const toolResult = {
      content: [
        { type: "text", text: "\n".repeat(99_990) },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    const text = await call(toolResult, hugeArgs(), { max_output_chars: 100_000 });
    expect(text.length).toBeLessThanOrEqual(SAFETY_NET_FLOOR);
    const reply = leadingJson(text);
    expect(reply.result.status).toBe("materialized");
    expect(typeof reply.result.text_file_path).toBe("string");
    expect(reply.args_used.status).toBe("args_shortened");
  });

  it("two documents with the same start and length but a different end give different echoes", async () => {
    const a = leadingJson(await call(textResult("tiny"), { document: "d".repeat(3_000_000) + "A" }));
    const b = leadingJson(await call(textResult("tiny"), { document: "d".repeat(3_000_000) + "B" }));
    expect(a.args_used.status).toBe("args_shortened");
    expect(a.args_used.preview).toBe(b.args_used.preview);
    expect(a.args_used.original_chars).toBe(b.args_used.original_chars);
    expect(a.args_used).not.toEqual(b.args_used);
    expect(a.args_used.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.args_used.message).toMatch(/not what was sent/i);
  });

  it("the same arguments in a different key order give the same echo", async () => {
    const doc = "d".repeat(3_000_000);
    const a = leadingJson(await call(textResult("tiny"), { title: "Made-up", document: doc }));
    const b = leadingJson(await call(textResult("tiny"), { document: doc, title: "Made-up" }));
    expect(a.args_used.status).toBe("args_shortened");
    expect(a.args_used).toEqual(b.args_used);
  });

  it("a dry run with huge arguments shortens the echo; a dry run with normal arguments echoes them whole", async () => {
    const huge = await call(textResult("unused"), hugeArgs(), { dry_run: true });
    expect(huge.length).toBeLessThanOrEqual(SAFETY_NET_FLOOR);
    const hugeReply = leadingJson(huge);
    expect(hugeReply.result).toEqual({ dry_run: true });
    expect(hugeReply.args_used.status).toBe("args_shortened");

    const args = normalArgs();
    expect(leadingJson(await call(textResult("unused"), args, { dry_run: true })).args_used).toEqual(args);
  });
});

describe("the argument echo depends on the arguments alone", () => {
  // An echo of about 150,000 chars: over the default 100,000 limit, under the 200,000 safety net.
  const midArgs = () => ({ title: "Made-up brief", document: "m".repeat(150_000) });
  // About 90,000 chars: under the default limit, so always echoed whole.
  const nearArgs = () => ({ title: "Made-up brief", document: "q".repeat(90_000) });

  it("the same arguments give the same shortened echo beside a tiny result and beside a cut-off one", async () => {
    const tiny = leadingJson(await call(textResult("tiny"), midArgs()));
    const cut = leadingJson(await call(textResult("c".repeat(150_000)), midArgs()));
    expect(cut.telemetry.output_truncated).toBe(true);
    expect(tiny.args_used.status).toBe("args_shortened");
    expect(tiny.args_used).toEqual(cut.args_used);
  });

  it("arguments of about 90,000 chars are echoed whole in every reply shape", async () => {
    const args = nearArgs();
    expect(leadingJson(await call(textResult("tiny"), args)).args_used).toEqual(args);
    const cut = leadingJson(await call(textResult("c".repeat(150_000)), args));
    expect(cut.telemetry.output_truncated).toBe(true);
    expect(cut.args_used).toEqual(args);
    const placeholder = leadingJson(await call({
      content: [{ type: "text", text: "short made-up summary" }],
      structuredContent: { rows: Array.from({ length: 3_000 }, (_, i) => ({ id: i, value: "v".repeat(90) })) },
    }, args));
    expect(placeholder.result.status).toBe("oversized_output");
    expect(placeholder.args_used).toEqual(args);
    expect(leadingJson(await call(textResult("unused"), args, { dry_run: true })).args_used).toEqual(args);

    await useWorkspace();
    const saved = leadingJson(await call(textResult("s".repeat(50_000)), args));
    expect(saved.result.status).toBe("materialized");
    expect(saved.args_used).toEqual(args);
  });

  it("arguments and text beside an image both just under an explicit limit: the saved-file reply stays within the safety net", async () => {
    await useWorkspace();
    const args = { title: "Made-up brief", document: "w".repeat(98_900) };
    const toolResult = {
      content: [
        { type: "text", text: "\n".repeat(49_990) },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    const text = await call(toolResult, args, { max_output_chars: 100_000 });
    expect(text.length).toBeLessThanOrEqual(SAFETY_NET_FLOOR);
    const reply = leadingJson(text);
    expect(reply.result.status).toBe("materialized");
  });

  it("max_output_chars: null echoes huge arguments whole", async () => {
    const args = hugeArgs();
    const reply = leadingJson(await call(textResult("tiny"), args, { max_output_chars: null }));
    expect(reply.args_used).toEqual(args);
  });
});

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
