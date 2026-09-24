import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const now = new Date("2026-09-23T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const day = 24 * 60 * 60;

const describedTool = (name: string) =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === name);

describe("chat.scheduleMessage's per-channel cap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the 30-per-5-minutes-per-channel cap on restricted_too_many", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "restricted_too_many" }),
      async () => {
        await expect(
          runTool("slack_schedule_message", {
            channelId: "C0TEST",
            text: "x",
            postAt: nowSeconds + 60,
          }),
        ).rejects.toThrow(
          "Slack chat.scheduleMessage failed: restricted_too_many (Slack allows at most 30 messages scheduled to post within any 5-minute window in one channel",
        );
      },
    );
  });

  it("states the cap in the schedule and reschedule descriptions", () => {
    for (const name of ["slack_schedule_message", "slack_schedule_reschedule"]) {
      expect(describedTool(name)?.description).toContain(
        "30 messages per 5-minute window per channel",
      );
    }
  });
});

describe("slack_schedule_reschedule", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const slack = (call: RecordedCall) =>
    call.method === "chat.scheduleMessage"
      ? { ok: true, channel: call.body.channel, scheduled_message_id: "Q0NEW" }
      : { ok: true };

  it("schedules the replacement, then cancels the original, in one call", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_schedule_reschedule", {
        channelId: "C0TEST",
        scheduledMessageId: "Q0OLD",
        text: "Standup moved to 10",
        postAt: "2026-09-24T10:00:00-06:00",
        threadTs: "1700000000.000100",
      });
      const postAt = Math.floor(Date.parse("2026-09-24T16:00:00Z") / 1000);
      expect(calls.map((call) => call.method)).toEqual([
        "chat.scheduleMessage",
        "chat.deleteScheduledMessage",
      ]);
      for (const call of calls) expect(call.headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[0].body).toEqual({
        channel: "C0TEST",
        text: "Standup moved to 10",
        post_at: postAt,
        thread_ts: "1700000000.000100",
      });
      expect(calls[1].body).toEqual({ channel: "C0TEST", scheduled_message_id: "Q0OLD" });
      expect(result).toEqual({
        channelId: "C0TEST",
        scheduledMessageId: "Q0NEW",
        replacedScheduledMessageId: "Q0OLD",
        postAt,
        postAtIso: "2026-09-24T16:00:00.000Z",
      });
    });
  });

  it("checks postAt before calling Slack", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_schedule_reschedule", {
          channelId: "C0TEST",
          scheduledMessageId: "Q0OLD",
          text: "x",
          postAt: nowSeconds + 121 * day,
        }),
      ).rejects.toThrow("Slack schedules at most 120 days ahead.");
      expect(calls).toHaveLength(0);
    });
  });

  it("leaves the original alone when the replacement cannot be scheduled", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "restricted_too_many" }),
      async (calls) => {
        await expect(
          runTool("slack_schedule_reschedule", {
            channelId: "C0TEST",
            scheduledMessageId: "Q0OLD",
            text: "x",
            postAt: nowSeconds + 60,
          }),
        ).rejects.toThrow("30 messages scheduled to post within any 5-minute window");
        expect(calls.map((call) => call.method)).toEqual(["chat.scheduleMessage"]);
      },
    );
  });

  it("withdraws the replacement when the original cannot be cancelled", async () => {
    let deletes = 0;
    await withMockFetch(
      (call) => {
        if (call.method === "chat.scheduleMessage") return slack(call);
        deletes += 1;
        return deletes === 1 ? { ok: false, error: "invalid_scheduled_message_id" } : { ok: true };
      },
      async (calls) => {
        await expect(
          runTool("slack_schedule_reschedule", {
            channelId: "C0TEST",
            scheduledMessageId: "Q0OLD",
            text: "x",
            postAt: nowSeconds + 60,
          }),
        ).rejects.toThrow(
          /Could not cancel Q0OLD.*invalid_scheduled_message_id.*withdrew the replacement Q0NEW/,
        );
        expect(calls.map((call) => [call.method, call.body.scheduled_message_id])).toEqual([
          ["chat.scheduleMessage", undefined],
          ["chat.deleteScheduledMessage", "Q0OLD"],
          ["chat.deleteScheduledMessage", "Q0NEW"],
        ]);
      },
    );
  });

  it("names both IDs when neither the original nor the replacement can be cancelled", async () => {
    await withMockFetch(
      (call) =>
        call.method === "chat.scheduleMessage"
          ? slack(call)
          : { ok: false, error: "invalid_scheduled_message_id" },
      async () => {
        await expect(
          runTool("slack_schedule_reschedule", {
            channelId: "C0TEST",
            scheduledMessageId: "Q0OLD",
            text: "x",
            postAt: nowSeconds + 60,
          }),
        ).rejects.toThrow(/Both Q0OLD and Q0NEW are now scheduled/);
      },
    );
  });
});
