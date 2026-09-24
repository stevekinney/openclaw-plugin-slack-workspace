import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { TOOL_METADATA } from "./tool-metadata.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tools = getToolPluginMetadata(entry)?.tools ?? [];
const toolNamed = (name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool named ${name}.`);
  return tool;
};
const accepts = (name: string, params: Record<string, unknown>) =>
  Value.Check(toolNamed(name).parameters, params);

const READ_ONLY = [
  "slack_identity",
  "slack_search",
  "slack_scheduled_list",
  "slack_canvas_sections",
  "slack_bookmark_list",
];

describe("outputSchema", () => {
  it("is declared by all 30 tools", () => {
    expect(tools).toHaveLength(30);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });
});

describe("tool metadata", () => {
  it("has exactly one entry per tool", () => {
    expect(Object.keys(TOOL_METADATA).sort()).toEqual(tools.map((tool) => tool.name).sort());
  });

  it("exposes every tool to the messaging profile", () => {
    for (const [name, metadata] of Object.entries(TOOL_METADATA)) {
      expect(metadata.profiles, name).toEqual(["messaging"]);
    }
  });

  it("marks read-only tools replay-safe and every other tool side-effecting", () => {
    for (const [name, metadata] of Object.entries(TOOL_METADATA)) {
      expect(metadata.sideEffecting, name).toBe(!READ_ONLY.includes(name));
      if (READ_ONLY.includes(name)) expect(metadata.replaySafe, name).toBe(true);
    }
    expect(TOOL_METADATA.slack_post_table.replaySafe).toBe(false);
    expect(TOOL_METADATA.slack_canvas_edit.replaySafe).toBe(false);
  });

  it("is present in the committed manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    expect(manifest.toolMetadata).toEqual(TOOL_METADATA);
  });
});

describe("integer parameters", () => {
  it("slack_search rejects fractional count and page", () => {
    expect(accepts("slack_search", { query: "x", count: 20, page: 2 })).toBe(true);
    expect(accepts("slack_search", { query: "x", count: 2.5 })).toBe(false);
    expect(accepts("slack_search", { query: "x", page: 1.5 })).toBe(false);
  });

  it("slack_post_table rejects a fractional pageSize", () => {
    const table = { channelId: "C0TEST", caption: "c", columns: ["a"], rows: [["1"]] };
    expect(accepts("slack_post_table", { ...table, pageSize: 10 })).toBe(true);
    expect(accepts("slack_post_table", { ...table, pageSize: 10.5 })).toBe(false);
  });
});

describe("slack_post_chart length limits", () => {
  const bar = (overrides: Record<string, unknown> = {}) => ({
    channelId: "C0TEST",
    title: "Revenue",
    chartType: "bar",
    categories: ["Q1"],
    series: [{ name: "2026", values: [1] }],
    ...overrides,
  });

  it("accepts a 50-character title and rejects 51", () => {
    expect(accepts("slack_post_chart", bar({ title: "t".repeat(50) }))).toBe(true);
    expect(accepts("slack_post_chart", bar({ title: "t".repeat(51) }))).toBe(false);
  });

  it("accepts 20-character labels and rejects 21 on categories, series names, and pie segments", () => {
    const ok = "l".repeat(20);
    const long = "l".repeat(21);
    expect(accepts("slack_post_chart", bar({ categories: [ok] }))).toBe(true);
    expect(accepts("slack_post_chart", bar({ categories: [long] }))).toBe(false);
    expect(accepts("slack_post_chart", bar({ series: [{ name: ok, values: [1] }] }))).toBe(true);
    expect(accepts("slack_post_chart", bar({ series: [{ name: long, values: [1] }] }))).toBe(
      false,
    );
    const pie = (label: string) =>
      bar({ chartType: "pie", segments: [{ label, value: 1 }], categories: undefined });
    expect(accepts("slack_post_chart", pie(ok))).toBe(true);
    expect(accepts("slack_post_chart", pie(long))).toBe(false);
  });

  it("rejects duplicate series names without calling Slack", async () => {
    await withMockFetch(
      () => ({ ok: true, ts: "1" }),
      async (calls) => {
        await expect(
          runTool(
            "slack_post_chart",
            bar({
              categories: ["Q1"],
              series: [
                { name: "2026", values: [1] },
                { name: "2026", values: [2] },
              ],
            }),
          ),
        ).rejects.toThrow('Series name "2026" appears more than once. Slack requires unique names.');
        expect(calls).toHaveLength(0);
      },
    );
  });
});

describe("slack_post_plan task status", () => {
  const plan = (status: string) => ({
    channelId: "C0TEST",
    title: "Deploy",
    tasks: [{ title: "Build", status }],
  });

  it("accepts pending, in_progress, complete, and error", () => {
    for (const status of ["pending", "in_progress", "complete", "error"]) {
      expect(accepts("slack_post_plan", plan(status)), status).toBe(true);
    }
  });

  it("rejects statuses Slack does not document", () => {
    for (const status of ["failed", "done", "not_started", ""]) {
      expect(accepts("slack_post_plan", plan(status)), status).toBe(false);
    }
  });
});
