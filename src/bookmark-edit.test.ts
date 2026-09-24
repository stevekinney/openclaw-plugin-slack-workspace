import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const outputSchema = getToolPluginMetadata(entry)!.tools.find(
  (tool) => tool.name === "slack_bookmark_edit",
)?.outputSchema;

/** A bookmark as bookmarks.edit returns it, bookkeeping fields included. */
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
  date_updated: 1700000100,
  rank: "U",
  last_updated_by_user_id: "U0TEST",
  last_updated_by_team_id: "T0TEST",
  shortcut_id: null,
  app_id: null,
  ...overrides,
});

describe("slack_bookmark_edit", () => {
  it("edits the bookmark in place and returns the curated result", async () => {
    await withMockFetch(
      () => ({ ok: true, bookmark: rawBookmark({ title: "Q4 roadmap", emoji: ":map:" }) }),
      async (calls) => {
        const result = await runTool("slack_bookmark_edit", {
          channelId: "C0TEST",
          bookmarkId: "Bk0TEST",
          title: "Q4 roadmap",
          link: "https://example.com/roadmap",
          emoji: ":map:",
        });
        expect(calls.map((call) => call.method)).toEqual(["bookmarks.edit"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({
          channel_id: "C0TEST",
          bookmark_id: "Bk0TEST",
          title: "Q4 roadmap",
          link: "https://example.com/roadmap",
          emoji: ":map:",
        });
        expect(result).toEqual({
          bookmark: {
            id: "Bk0TEST",
            title: "Q4 roadmap",
            link: "https://example.com/roadmap",
            emoji: ":map:",
            type: "link",
          },
        });
        expect(Value.Check(outputSchema!, result)).toBe(true);
      },
    );
  });

  it("sends only the fields being changed", async () => {
    await withMockFetch(
      () => ({ ok: true, bookmark: rawBookmark({ title: "Renamed" }) }),
      async (calls) => {
        await runTool("slack_bookmark_edit", {
          channelId: "C0TEST",
          bookmarkId: "Bk0TEST",
          title: "Renamed",
        });
        expect(calls[0].body).toEqual({
          channel_id: "C0TEST",
          bookmark_id: "Bk0TEST",
          title: "Renamed",
        });
      },
    );
  });

  it("refuses an edit that changes nothing, without calling Slack", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        await expect(
          runTool("slack_bookmark_edit", { channelId: "C0TEST", bookmarkId: "Bk0TEST" }),
        ).rejects.toThrow(/title, link, or emoji/);
        expect(calls).toHaveLength(0);
      },
    );
  });

  it("returns null when Slack omits the bookmark", async () => {
    const result = await withMockFetch(
      () => ({ ok: true }),
      () =>
        runTool("slack_bookmark_edit", {
          channelId: "C0TEST",
          bookmarkId: "Bk0TEST",
          title: "t",
        }),
    );
    expect(result).toEqual({ bookmark: null });
    expect(Value.Check(outputSchema!, result)).toBe(true);
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "not_found" }),
      async () => {
        await expect(
          runTool("slack_bookmark_edit", {
            channelId: "C0TEST",
            bookmarkId: "Bk0GONE",
            title: "t",
          }),
        ).rejects.toThrow(/not_found/);
      },
    );
  });
});
