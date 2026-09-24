import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const now = new Date("2026-09-23T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const day = 24 * 60 * 60;

const slack = (call: RecordedCall) => {
  if (call.method === "conversations.open") {
    return { ok: true, channel: { id: "D0DM" } };
  }
  return { ok: true, channel: call.body.channel, scheduled_message_id: "Q0TEST" };
};

describe("slack_remind", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a DM with the user, then schedules the reminder into it", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_remind", {
        userId: "U0ALICE",
        text: "Submit the expense report",
        when: "2026-09-24T09:00:00-06:00",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.open",
        "chat.scheduleMessage",
      ]);
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[0].body).toEqual({ users: "U0ALICE" });
      expect(calls[1].headers.authorization).toBe("Bearer xoxb-test");
      const postAt = Math.floor(Date.parse("2026-09-24T15:00:00Z") / 1000);
      expect(calls[1].body).toEqual({
        channel: "D0DM",
        text: "Submit the expense report",
        post_at: postAt,
      });
      expect(result).toEqual({
        channelId: "D0DM",
        userId: "U0ALICE",
        scheduledMessageId: "Q0TEST",
        postAt,
        postAtIso: "2026-09-24T15:00:00.000Z",
      });
    });
  });

  it("schedules straight into a channel without opening a DM", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_remind", {
        channelId: "C0TEAM",
        text: "Standup in 5",
        when: nowSeconds + 60,
      });
      expect(calls.map((call) => call.method)).toEqual(["chat.scheduleMessage"]);
      expect(calls[0].body).toEqual({ channel: "C0TEAM", text: "Standup in 5", post_at: nowSeconds + 60 });
      expect(result).toMatchObject({ channelId: "C0TEAM", scheduledMessageId: "Q0TEST" });
      expect(result).not.toHaveProperty("userId");
    });
  });

  it("refuses both or neither target before calling Slack", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_remind", { userId: "U0A", channelId: "C0B", text: "x", when: nowSeconds + 60 }),
      ).rejects.toThrow(/exactly one of `userId` or `channelId`/);
      await expect(runTool("slack_remind", { text: "x", when: nowSeconds + 60 })).rejects.toThrow(
        /exactly one of `userId` or `channelId`/,
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("validates `when` before opening a DM", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_remind", { userId: "U0A", text: "x", when: nowSeconds - 60 }),
      ).rejects.toThrow("`when` is 60s in the past");
      await expect(
        runTool("slack_remind", { userId: "U0A", text: "x", when: nowSeconds + 121 * day }),
      ).rejects.toThrow("Slack schedules at most 120 days ahead.");
      await expect(
        runTool("slack_remind", { userId: "U0A", text: "x", when: "2026-09-24T09:00:00" }),
      ).rejects.toThrow(/`when` .* has no timezone/);
      expect(calls).toHaveLength(0);
    });
  });

  it("surfaces a conversations.open failure without scheduling", async () => {
    await withMockFetch(
      (call) => (call.method === "conversations.open" ? { ok: false, error: "user_not_found" } : slack(call)),
      async (calls) => {
        await expect(
          runTool("slack_remind", { userId: "U0GONE", text: "x", when: nowSeconds + 60 }),
        ).rejects.toThrow(/user_not_found/);
        expect(calls.map((call) => call.method)).toEqual(["conversations.open"]);
      },
    );
  });

  it("points the agent at OpenClaw automations for recurrence", () => {
    const tool = getToolPluginMetadata(entry)?.tools.find((t) => t.name === "slack_remind");
    expect(tool?.description).toMatch(/openclaw automations/);
  });
});
