import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { runTool, slackResponse, withMockFetch } from "./test-utils.js";

describe("slack-workspace", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "slack_identity",
      "slack_search",
      "slack_schedule_message",
      "slack_scheduled_list",
      "slack_scheduled_cancel",
      "slack_post_table",
      "slack_post_plan",
      "slack_post_chart",
      "slack_blocks_send",
      "slack_blocks_update",
      "slack_canvas_create",
      "slack_canvas_edit",
      "slack_canvas_sections",
      "slack_bookmark_list",
      "slack_bookmark_add",
      "slack_bookmark_remove",
    ]);
  });
});

const ok = () => ({ ok: true, ts: "1700000000.000100" });
const target = { channelId: "C0TEST" };

describe("slack_post_table", () => {
  it("rejects a row whose width does not match the header, without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_table", {
          ...target,
          caption: "Scores",
          columns: ["name", "score"],
          rows: [
            ["a", 1],
            ["b", 2, "extra"],
          ],
        }),
      ).rejects.toThrow(
        "Row 1 has 3 cells but there are 2 columns. Slack requires every row to match the header width.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("posts a data_table with raw_number cells when widths match", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_post_table", {
        ...target,
        caption: "Scores",
        columns: ["name", "score"],
        rows: [["a", 1]],
      });
      expect(result).toEqual({ channelId: "C0TEST", ts: "1700000000.000100", updated: false });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("chat.postMessage");
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      const [table] = calls[0].body.blocks as { rows: unknown[][] }[];
      expect(table.rows[1]).toEqual([
        { type: "raw_text", text: "a" },
        { type: "raw_number", value: 1, text: "1" },
      ]);
    });
  });
});

describe("slack_post_chart", () => {
  it("rejects a series whose length does not match the categories, without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_chart", {
          ...target,
          title: "Revenue",
          chartType: "bar",
          categories: ["Q1", "Q2", "Q3"],
          series: [
            { name: "2025", values: [1, 2, 3] },
            { name: "2026", values: [4, 5] },
          ],
        }),
      ).rejects.toThrow(
        'Series "2026" has 2 values but there are 3 categories. Slack requires exactly one value per category.',
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a non-pie chart that is missing categories or series", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_chart", { ...target, title: "Trend", chartType: "line", categories: ["Q1"] }),
      ).rejects.toThrow("A line chart requires both `categories` and `series`.");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("slack_schedule_message postAt bounds", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const day = 24 * 60 * 60;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const schedule = (postAt: string | number) =>
    runTool("slack_schedule_message", { ...target, text: "ping", postAt });

  it("rejects a postAt in the past", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(nowSeconds - 60)).rejects.toThrow(
        "`postAt` is 60s in the past. Slack only schedules future messages.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a postAt equal to now", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(now.toISOString())).rejects.toThrow("0s in the past");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a postAt more than 120 days out", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(nowSeconds + 120 * day + 1)).rejects.toThrow(
        "Slack schedules at most 120 days ahead.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects an unparseable postAt", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule("next tuesday")).rejects.toThrow(
        "Could not read `postAt` (next tuesday) as ISO-8601 or Unix seconds.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("schedules exactly 120 days out", async () => {
    const postAt = nowSeconds + 120 * day;
    await withMockFetch(
      () => ({ ok: true, scheduled_message_id: "Q0TEST" }),
      async (calls) => {
        await expect(schedule(postAt)).resolves.toEqual({
          channelId: "C0TEST",
          scheduledMessageId: "Q0TEST",
          postAt,
          postAtIso: "2027-01-21T12:00:00.000Z",
        });
        expect(calls.map((call) => call.method)).toEqual(["chat.scheduleMessage"]);
        expect(calls[0].body.post_at).toBe(postAt);
      },
    );
  });
});

describe("Slack error hints", () => {
  it("names the needed scope on missing_scope", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope", needed: "bookmarks:read" }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: missing_scope (needs scope: bookmarks:read)",
        );
      },
    );
  });

  it("falls back to 'unknown' when missing_scope omits `needed`", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope" }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: missing_scope (needs scope: unknown)",
        );
      },
    );
  });

  it("explains not_allowed_token_type as a bot-vs-user mismatch", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "not_allowed_token_type" }),
      async (calls) => {
        await expect(runTool("slack_search", { query: "roadmap" })).rejects.toThrow(
          "Slack search.messages failed: not_allowed_token_type (this method requires the other token type — bot vs user)",
        );
        // search.* goes out form-encoded with the user token.
        expect(calls[0].headers.authorization).toBe("Bearer xoxp-test");
        expect(calls[0].headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
        expect(calls[0].body).toMatchObject({ query: "roadmap", count: "20" });
      },
    );
  });

  it("appends Block Kit detail messages for other errors", async () => {
    await withMockFetch(
      () => ({
        ok: false,
        error: "invalid_blocks",
        response_metadata: { messages: ["[ERROR] bad block at /blocks/0"] },
      }),
      async () => {
        await expect(
          runTool("slack_blocks_send", { ...target, text: "hi", blocks: [{ type: "nope" }] }),
        ).rejects.toThrow("Slack chat.postMessage failed: invalid_blocks — [ERROR] bad block at /blocks/0");
      },
    );
  });

  it("reports the HTTP status when Slack omits an error code", async () => {
    await withMockFetch(
      () => slackResponse({ ok: false }, { status: 503 }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: http_503",
        );
      },
    );
  });
});
