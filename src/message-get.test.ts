import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const card = (ts: string, payload: Record<string, unknown>, eventType = "openclaw_card_v1") => ({
  type: "message",
  ts,
  user: "U0BOT",
  text: `card ${ts}`,
  metadata: { event_type: eventType, event_payload: payload },
});

const HISTORY = [
  { type: "message", ts: "1726000300.000500", user: "U0ALICE", text: "no metadata" },
  card("1726000240.000400", { taskId: "T-2", revision: 1 }),
  card("1726000180.000300", { taskId: "T-1", revision: 3, nested: { phase: "build" } }),
  card("1726000120.000200", { taskId: "T-1" }, "other_event_v1"),
  { ...card("1726000060.000100", { taskId: "T-3" }), thread_ts: "1726000000.000001" },
];

const history = (messages: Record<string, unknown>[] = HISTORY) => (call: RecordedCall) =>
  call.method === "conversations.history" || call.method === "conversations.replies"
    ? { ok: true, messages, has_more: false }
    : { ok: true };

const outputSchema = () =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === "slack_message_get")
    ?.outputSchema;

describe("slack_message_get", () => {
  it("reads channel history with include_all_metadata and returns matching cards", async () => {
    await withMockFetch(history(), async (calls) => {
      const result = await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("conversations.history");
      expect(calls[0].body).toMatchObject({ channel: "C0TEAM", include_all_metadata: "true" });
      expect(result).toEqual({
        messages: [
          {
            channelId: "C0TEAM",
            ts: "1726000240.000400",
            text: "card 1726000240.000400",
            eventType: "openclaw_card_v1",
            eventPayload: { taskId: "T-2", revision: 1 },
          },
          {
            channelId: "C0TEAM",
            ts: "1726000180.000300",
            text: "card 1726000180.000300",
            eventType: "openclaw_card_v1",
            eventPayload: { taskId: "T-1", revision: 3, nested: { phase: "build" } },
          },
          {
            channelId: "C0TEAM",
            ts: "1726000060.000100",
            threadTs: "1726000000.000001",
            text: "card 1726000060.000100",
            eventType: "openclaw_card_v1",
            eventPayload: { taskId: "T-3" },
          },
        ],
        truncated: false,
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("narrows by matchPayload, comparing nested values structurally", async () => {
    await withMockFetch(history(), async () => {
      const byTask = (await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
        matchPayload: { taskId: "T-1" },
      })) as { messages: { ts: string }[] };
      expect(byTask.messages.map((message) => message.ts)).toEqual(["1726000180.000300"]);

      const nested = (await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
        matchPayload: { nested: { phase: "build" } },
      })) as { messages: { ts: string }[] };
      expect(nested.messages.map((message) => message.ts)).toEqual(["1726000180.000300"]);

      const none = (await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
        matchPayload: { taskId: "T-1", revision: 2 },
      })) as { messages: unknown[] };
      expect(none.messages).toEqual([]);
    });
  });

  it("reads a thread through conversations.replies when threadTs is set", async () => {
    await withMockFetch(history(), async (calls) => {
      await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
        threadTs: "1726000000.000001",
      });
      expect(calls[0].method).toBe("conversations.replies");
      expect(calls[0].body).toMatchObject({
        channel: "C0TEAM",
        ts: "1726000000.000001",
        include_all_metadata: "true",
      });
    });
  });

  it("forwards the oldest/latest window", async () => {
    await withMockFetch(history(), async (calls) => {
      await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
        oldest: "1726000000.000000",
        latest: "1726000500.000000",
      });
      expect(calls[0].body).toMatchObject({ oldest: "1726000000.000000", latest: "1726000500.000000" });
    });
  });

  it("stops at limit matches without fetching further pages", async () => {
    let page = 0;
    await withMockFetch(
      () => {
        page++;
        return {
          ok: true,
          messages: [card(`17260000${page}0.000100`, { taskId: "T-1" })],
          response_metadata: { next_cursor: `cursor-${page}` },
        };
      },
      async (calls) => {
        const result = await runTool("slack_message_get", {
          channelId: "C0TEAM",
          eventType: "openclaw_card_v1",
          limit: 1,
        });
        expect(calls).toHaveLength(1);
        expect(result).toMatchObject({ truncated: true });
        expect((result as { messages: unknown[] }).messages).toHaveLength(1);
      },
    );
  });

  it("walks pages until maxPages and reports truncation", async () => {
    let page = 0;
    await withMockFetch(
      (call) => {
        page++;
        expect(call.body.cursor).toBe(page === 1 ? undefined : `cursor-${page - 1}`);
        return {
          ok: true,
          messages: [{ type: "message", ts: `1726000${page}00.000100`, text: "plain" }],
          response_metadata: { next_cursor: `cursor-${page}` },
        };
      },
      async (calls) => {
        const result = await runTool("slack_message_get", {
          channelId: "C0TEAM",
          eventType: "openclaw_card_v1",
          maxPages: 3,
        });
        expect(calls).toHaveLength(3);
        expect(result).toEqual({ messages: [], truncated: true });
      },
    );
  });

  it("ignores messages whose metadata is malformed", async () => {
    const messages = [
      { type: "message", ts: "1.1", metadata: { event_type: "openclaw_card_v1" } },
      { type: "message", ts: "1.2", metadata: "nope" },
      { type: "message", ts: "1.3", metadata: { event_type: "openclaw_card_v1", event_payload: [1] } },
    ];
    await withMockFetch(history(messages), async () => {
      const result = (await runTool("slack_message_get", {
        channelId: "C0TEAM",
        eventType: "openclaw_card_v1",
      })) as { messages: { ts: string }[] };
      expect(result.messages).toEqual([]);
    });
  });
});
