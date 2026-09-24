import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const outputSchemaOf = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.outputSchema!;

/** A bookmark as bookmarks.list/bookmarks.add return it: mostly bookkeeping fields. */
const rawBookmark = (overrides: Record<string, unknown> = {}) => ({
  id: "Bk0TEST",
  channel_id: "C0TEST",
  title: "Roadmap",
  link: "https://example.com/roadmap",
  emoji: ":books:",
  icon_url: "https://example.com/icon.png",
  type: "link",
  entity_id: null,
  date_created: 1700000000,
  date_updated: 0,
  rank: "U",
  last_updated_by_user_id: "U0TEST",
  last_updated_by_team_id: "T0TEST",
  shortcut_id: null,
  app_id: null,
  app_action_id: null,
  ...overrides,
});

describe("curated output shapes", () => {
  it("slack_bookmark_list keeps only what identifies and opens a bookmark", async () => {
    const result = await withMockFetch(
      () => ({ ok: true, bookmarks: [rawBookmark(), rawBookmark({ id: "Bk0PLAIN", emoji: "" })] }),
      () => runTool("slack_bookmark_list", { channelId: "C0TEST" }),
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "bookmarks": [
          {
            "emoji": ":books:",
            "id": "Bk0TEST",
            "link": "https://example.com/roadmap",
            "title": "Roadmap",
            "type": "link",
          },
          {
            "id": "Bk0PLAIN",
            "link": "https://example.com/roadmap",
            "title": "Roadmap",
            "type": "link",
          },
        ],
      }
    `);
    expect(Value.Check(outputSchemaOf("slack_bookmark_list"), result)).toBe(true);
  });

  it("slack_bookmark_add returns the same curated bookmark shape", async () => {
    const result = await withMockFetch(
      () => ({ ok: true, bookmark: rawBookmark() }),
      () =>
        runTool("slack_bookmark_add", {
          channelId: "C0TEST",
          title: "Roadmap",
          link: "https://example.com/roadmap",
          emoji: ":books:",
        }),
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "bookmark": {
          "emoji": ":books:",
          "id": "Bk0TEST",
          "link": "https://example.com/roadmap",
          "title": "Roadmap",
          "type": "link",
        },
      }
    `);
    expect(Value.Check(outputSchemaOf("slack_bookmark_add"), result)).toBe(true);
  });

  it("slack_bookmark_add returns null when Slack omits the bookmark", async () => {
    const result = await withMockFetch(
      () => ({ ok: true }),
      () =>
        runTool("slack_bookmark_add", { channelId: "C0TEST", title: "t", link: "https://x.test" }),
    );
    expect(result).toEqual({ bookmark: null });
    expect(Value.Check(outputSchemaOf("slack_bookmark_add"), result)).toBe(true);
  });

  it("slack_canvas_sections keeps only the section ID", async () => {
    const result = await withMockFetch(
      () => ({
        ok: true,
        sections: [
          { id: "temp:C:VXX8e648e6984e441c6aa8c61173", extra: "noise" },
          { id: "temp:C:VXXa1b2c3d4e5f6a7b8c9d0e1f2a3" },
        ],
      }),
      () => runTool("slack_canvas_sections", { canvasId: "F0TEST", containsText: "Goals" }),
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "sections": [
          {
            "id": "temp:C:VXX8e648e6984e441c6aa8c61173",
          },
          {
            "id": "temp:C:VXXa1b2c3d4e5f6a7b8c9d0e1f2a3",
          },
        ],
      }
    `);
    expect(Value.Check(outputSchemaOf("slack_canvas_sections"), result)).toBe(true);
  });
});
