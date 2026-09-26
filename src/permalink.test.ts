import { describe, expect, it } from "vitest";
import { recordingLogger, runTool, TEST_CONFIG, withMockFetch, type RecordedCall } from "./test-utils.js";

const PERMALINK = "https://example.slack.com/archives/C0TEAM/p1726000000000100";

/** Answer the post or update, then the permalink lookup (or its failure). */
const handler =
  (permalink: "ok" | "fail") =>
  (call: RecordedCall): Record<string, unknown> => {
    if (call.method === "chat.getPermalink") {
      return permalink === "ok"
        ? { ok: true, channel: call.body.channel, permalink: PERMALINK }
        : { ok: false, error: "message_not_found" };
    }
    return { ok: true, channel: "C0TEAM", ts: "1726000000.000100" };
  };

const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];

const cases: [string, Record<string, unknown>][] = [
  ["slack_post_table", { channelId: "C0TEAM", caption: "t", columns: ["a"], rows: [["1"]] }],
  ["slack_post_table (update)", { channelId: "C0TEAM", caption: "t", columns: ["a"], rows: [["1"]], updateTs: "1726000000.000100" }],
  ["slack_post_plan", { channelId: "C0TEAM", title: "Plan", tasks: [{ id: "1", title: "Do it", status: "pending" }] }],
  ["slack_post_rich_text", { channelId: "C0TEAM", text: "hi", sections: [{ type: "paragraph", text: "hi" }] }],
  ["slack_post_chart", { channelId: "C0TEAM", title: "Chart", chartType: "bar", categories: ["a"], series: [{ name: "s", values: [1] }] }],
  ["slack_blocks_send", { channelId: "C0TEAM", text: "hi", blocks }],
  ["slack_blocks_update", { channelId: "C0TEAM", ts: "1726000000.000100", text: "hi", blocks }],
];

describe("permalinks from posting tools", () => {
  it.each(cases)("%s looks up and returns the permalink", async (label, params) => {
    const name = label.split(" ")[0];
    await withMockFetch(handler("ok"), async (calls) => {
      const result = (await runTool(name, params)) as Record<string, unknown>;
      const lookup = calls.find((call) => call.method === "chat.getPermalink");
      expect(lookup?.body).toEqual({ channel: "C0TEAM", message_ts: "1726000000.000100" });
      expect(lookup?.headers.authorization).toBe("Bearer xoxb-test");
      expect(result.permalink).toBe(PERMALINK);
      expect(result.ts).toBe("1726000000.000100");
    });
  });

  it.each(cases)("%s still succeeds without a permalink when the lookup fails", async (label, params) => {
    const name = label.split(" ")[0];
    const logger = recordingLogger();
    await withMockFetch(handler("fail"), async () => {
      const result = (await runTool(name, params, TEST_CONFIG, logger)) as Record<string, unknown>;
      expect(result.ts).toBe("1726000000.000100");
      expect(result).not.toHaveProperty("permalink");
    });
    expect(
      logger.lines.some((line) => line.level === "warn" && line.message.includes("chat.getPermalink")),
    ).toBe(true);
  });
});
