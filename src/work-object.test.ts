import { describe, expect, it } from "vitest";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const TS = "1726000000.000100";
const PERMALINK = "https://example.slack.com/archives/C0TEAM/p1726000000000100";

const ISSUE = {
  channelId: "C0TEAM",
  title: "Checkout fails on Safari",
  url: "https://tracker.example.com/issues/42",
  displayId: "SHOP-42",
  displayType: "Issue",
  status: "In progress",
};

/**
 * Answer chat.getPermalink, and chat.postMessage with ok — or with `entityError` when
 * the post carries entity metadata, as Slack does when Work Objects are rejected.
 */
const slack =
  (entityError?: string) =>
  (call: RecordedCall): Record<string, unknown> => {
    if (call.method === "chat.getPermalink") return { ok: true, permalink: PERMALINK };
    if (entityError && call.body.metadata) return { ok: false, error: entityError };
    return { ok: true, channel: "C0TEAM", ts: TS };
  };

describe("slack_work_object_post", () => {
  it("posts entity metadata with chat.postMessage and no app_unfurl_url", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_work_object_post", ISSUE);
      expect(result).toEqual({ mode: "work_object", channelId: "C0TEAM", ts: TS, permalink: PERMALINK });
      expect(calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.getPermalink"]);
      const body = calls[0].body;
      expect(body.channel).toBe("C0TEAM");
      expect(body.text).toBe("Issue SHOP-42: Checkout fails on Safari (In progress) — https://tracker.example.com/issues/42");
      expect(body.metadata).toEqual({
        entities: [
          {
            entity_type: "slack#/entities/task",
            url: "https://tracker.example.com/issues/42",
            external_ref: { id: "SHOP-42", type: "task" },
            entity_payload: {
              attributes: {
                title: { text: "Checkout fails on Safari" },
                display_id: "SHOP-42",
                display_type: "Issue",
              },
              fields: { status: { value: "In progress" } },
            },
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("app_unfurl_url");
    });
  });

  it("maps entityType, externalId, and productName, and threads the post", async () => {
    await withMockFetch(slack(), async (calls) => {
      await runTool("slack_work_object_post", {
        channelId: "C0TEAM",
        title: "Q3 plan",
        url: "https://docs.example.com/d/abc",
        entityType: "file",
        externalId: "abc",
        productName: "Example Docs",
        threadTs: "1726000000.000001",
        replyBroadcast: true,
      });
      const body = calls[0].body;
      expect(body).toMatchObject({ thread_ts: "1726000000.000001", reply_broadcast: true });
      const [entity] = (body.metadata as { entities: Record<string, unknown>[] }).entities;
      expect(entity).toEqual({
        entity_type: "slack#/entities/file",
        url: "https://docs.example.com/d/abc",
        external_ref: { id: "abc", type: "file" },
        entity_payload: {
          attributes: { title: { text: "Q3 plan" }, display_type: "Document", product_name: "Example Docs" },
        },
      });
    });
  });

  it("falls back to a plain Block Kit card when Slack rejects the entity", async () => {
    await withMockFetch(slack("invalid_metadata"), async (calls) => {
      const result = (await runTool("slack_work_object_post", ISSUE)) as Record<string, unknown>;
      expect(result).toMatchObject({ mode: "fallback", channelId: "C0TEAM", ts: TS, permalink: PERMALINK });
      expect(result.reason).toContain("invalid_metadata");
      expect(calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.postMessage", "chat.getPermalink"]);
      const fallback = calls[1].body;
      expect(fallback).not.toHaveProperty("metadata");
      expect(fallback.text).toBe(calls[0].body.text);
      expect(fallback.blocks).toEqual([
        {
          type: "section",
          text: { type: "mrkdwn", text: "*<https://tracker.example.com/issues/42|Checkout fails on Safari>*" },
        },
        { type: "context", elements: [{ type: "mrkdwn", text: "Issue · SHOP-42 · In progress" }] },
      ]);
    });
  });

  it("escapes Slack control characters in the fallback card", async () => {
    await withMockFetch(slack("invalid_metadata"), async (calls) => {
      await runTool("slack_work_object_post", { ...ISSUE, title: "<!channel> & c" });
      const [section] = calls[1].body.blocks as { text: { text: string } }[];
      expect(section.text.text).toBe("*<https://tracker.example.com/issues/42|&lt;!channel&gt; &amp; c>*");
    });
  });

  it("does not fall back on errors a plain post would hit too", async () => {
    await withMockFetch(slack("channel_not_found"), async (calls) => {
      await expect(runTool("slack_work_object_post", ISSUE)).rejects.toThrow("channel_not_found");
      expect(calls).toHaveLength(1);
    });
  });

  it("refuses a status on an entity type without a status field", async () => {
    await withMockFetch(slack(), async (calls) => {
      await expect(
        runTool("slack_work_object_post", { ...ISSUE, entityType: "file" }),
      ).rejects.toThrow(/status/);
      expect(calls).toHaveLength(0);
    });
  });
});
