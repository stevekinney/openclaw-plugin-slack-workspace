import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const ok = (call: RecordedCall) => ({ ok: true, channel: call.body.channel, ts: "1726000000.000100" });

const tool = () => {
  const found = getToolPluginMetadata(entry)?.tools.find((t) => t.name === "slack_post_rich_text");
  if (!found) throw new Error("slack_post_rich_text is not registered.");
  return found;
};

/** Post `sections` and return the one rich_text block Slack received. */
async function compile(sections: Record<string, unknown>[]) {
  return withMockFetch(ok, async (calls) => {
    await runTool("slack_post_rich_text", { channelId: "C0TEST", sections });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("chat.postMessage");
    const blocks = calls[0].body.blocks as unknown[];
    expect(blocks).toHaveLength(1);
    return blocks[0];
  });
}

const text = (value: string) => ({ type: "text", text: value });
const code = (value: string) => ({ type: "text", text: value, style: { code: true } });

describe("slack_post_rich_text", () => {
  it("compiles a paragraph to a rich_text_section", async () => {
    expect(await compile([{ type: "paragraph", text: "Deploy finished." }])).toEqual({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [text("Deploy finished.")] }],
    });
  });

  it("compiles a bullet_list to a bullet rich_text_list of sections", async () => {
    expect(await compile([{ type: "bullet_list", items: ["api", "web"] }])).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            { type: "rich_text_section", elements: [text("api")] },
            { type: "rich_text_section", elements: [text("web")] },
          ],
        },
      ],
    });
  });

  it("compiles an ordered_list to an ordered rich_text_list of sections", async () => {
    expect(await compile([{ type: "ordered_list", items: ["build", "ship"] }])).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "ordered",
          elements: [
            { type: "rich_text_section", elements: [text("build")] },
            { type: "rich_text_section", elements: [text("ship")] },
          ],
        },
      ],
    });
  });

  it("compiles a quote to a rich_text_quote holding inline elements directly", async () => {
    expect(await compile([{ type: "quote", text: "Ship it." }])).toEqual({
      type: "rich_text",
      elements: [{ type: "rich_text_quote", elements: [text("Ship it.")] }],
    });
  });

  it("compiles code to a rich_text_preformatted block, verbatim", async () => {
    const source = "npm test\n`not inline` & <kept>";
    expect(await compile([{ type: "code", text: source }])).toEqual({
      type: "rich_text",
      elements: [{ type: "rich_text_preformatted", elements: [text(source)] }],
    });
  });

  it("turns `backticks` into inline code in paragraphs, list items, and quotes", async () => {
    const block = (await compile([
      { type: "paragraph", text: "Run `npm test` first" },
      { type: "bullet_list", items: ["`a`"] },
      { type: "quote", text: "use `x`" },
    ])) as { elements: { elements: unknown[] }[] };
    expect(block.elements[0].elements).toEqual([text("Run "), code("npm test"), text(" first")]);
    expect(block.elements[1].elements).toEqual([{ type: "rich_text_section", elements: [code("a")] }]);
    expect(block.elements[2].elements).toEqual([text("use "), code("x")]);
  });

  it("keeps sections in order within one rich_text block", async () => {
    const block = (await compile([
      { type: "paragraph", text: "Steps:" },
      { type: "ordered_list", items: ["one"] },
      { type: "code", text: "x" },
    ])) as { elements: { type: string }[] };
    expect(block.elements.map((element) => element.type)).toEqual([
      "rich_text_section",
      "rich_text_list",
      "rich_text_preformatted",
    ]);
  });

  it("derives an escaped plain-text fallback, or uses the one given", async () => {
    await withMockFetch(ok, async (calls) => {
      const sections = [
        { type: "paragraph", text: "Status <!here>" },
        { type: "bullet_list", items: ["a"] },
        { type: "ordered_list", items: ["b", "c"] },
        { type: "quote", text: "q" },
        { type: "code", text: "x" },
      ];
      await runTool("slack_post_rich_text", { channelId: "C0TEST", sections });
      expect(calls[0].body.text).toBe("Status &lt;!here&gt;\n• a\n1. b\n2. c\n> q\n```x```");
      await runTool("slack_post_rich_text", { channelId: "C0TEST", sections, text: "Status" });
      expect(calls[1].body.text).toBe("Status");
    });
  });

  it("updates in place with updateTs and returns the post result", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_post_rich_text", {
        channelId: "C0TEST",
        updateTs: "1726000000.000100",
        sections: [{ type: "paragraph", text: "done" }],
      });
      expect(calls[0].method).toBe("chat.update");
      expect(calls[0].body.ts).toBe("1726000000.000100");
      expect(result).toEqual({ channelId: "C0TEST", ts: "1726000000.000100", updated: true });
      expect(Value.Check(tool().outputSchema!, result)).toBe(true);
    });
  });

  it("schema requires text for paragraph/quote/code and non-empty items for lists", () => {
    const accepts = (section: Record<string, unknown>) =>
      Value.Check(tool().parameters, { channelId: "C0TEST", sections: [section] });
    expect(accepts({ type: "paragraph", text: "x" })).toBe(true);
    expect(accepts({ type: "bullet_list", items: ["x"] })).toBe(true);
    expect(accepts({ type: "paragraph", items: ["x"] })).toBe(false);
    expect(accepts({ type: "quote", text: "" })).toBe(false);
    expect(accepts({ type: "ordered_list", items: [] })).toBe(false);
    expect(accepts({ type: "bullet_list", items: [""] })).toBe(false);
    expect(accepts({ type: "heading", text: "x" })).toBe(false);
    expect(Value.Check(tool().parameters, { channelId: "C0TEST", sections: [] })).toBe(false);
  });

  it("rejects a section missing its content without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_rich_text", { channelId: "C0TEST", sections: [{ type: "bullet_list" }] }),
      ).rejects.toThrow("Section 0 (bullet_list) needs a non-empty `items` array.");
      expect(calls).toHaveLength(0);
    });
  });
});
