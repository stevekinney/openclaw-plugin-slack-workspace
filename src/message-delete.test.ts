import { describe, expect, it } from "vitest";
import { approvalFor } from "./approvals.js";
import { registerPlugin, runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const TS = "1726000000.000100";
const AUTH = { ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEST", url: "https://test.slack.com/" };

/** Answer auth.test as the bot, history/replies with `messages`, and chat.delete with ok. */
const slack = (messages: Record<string, unknown>[]) => (call: RecordedCall) => {
  if (call.method === "auth.test") return AUTH;
  if (call.method === "conversations.history" || call.method === "conversations.replies") {
    return { ok: true, messages, has_more: false };
  }
  return { ok: true, channel: "C0TEAM", ts: TS };
};

const methods = (calls: RecordedCall[]) => calls.map((call) => call.method);

describe("slack_message_delete", () => {
  it("deletes a message this bot posted", async () => {
    await withMockFetch(slack([{ type: "message", ts: TS, bot_id: "B0BOT", text: "scratch" }]), async (calls) => {
      await expect(runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS })).resolves.toEqual({
        deleted: true,
        channelId: "C0TEAM",
        ts: TS,
      });
      expect(methods(calls)).toEqual(["auth.test", "conversations.history", "chat.delete"]);
      expect(calls[1].body).toMatchObject({
        channel: "C0TEAM",
        oldest: TS,
        latest: TS,
        inclusive: "true",
        limit: "1",
      });
      expect(calls[2].body).toEqual({ channel: "C0TEAM", ts: TS });
    });
  });

  it("recognizes the bot by its user ID too", async () => {
    await withMockFetch(slack([{ type: "message", ts: TS, user: "U0BOT" }]), async (calls) => {
      await runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS });
      expect(methods(calls)).toContain("chat.delete");
    });
  });

  it("looks up a thread reply with conversations.replies", async () => {
    await withMockFetch(
      slack([
        { type: "message", ts: "1726000000.000001", user: "U0ALICE" },
        { type: "message", ts: TS, bot_id: "B0BOT", thread_ts: "1726000000.000001" },
      ]),
      async (calls) => {
        await runTool("slack_message_delete", {
          channelId: "C0TEAM",
          ts: TS,
          threadTs: "1726000000.000001",
        });
        expect(methods(calls)).toEqual(["auth.test", "conversations.replies", "chat.delete"]);
        expect(calls[1].body).toMatchObject({ channel: "C0TEAM", ts: "1726000000.000001" });
      },
    );
  });

  it("refuses another author's message before calling chat.delete", async () => {
    await withMockFetch(slack([{ type: "message", ts: TS, user: "U0ALICE", text: "mine" }]), async (calls) => {
      await expect(runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS })).rejects.toThrow(
        /not posted by this bot/,
      );
      expect(methods(calls)).not.toContain("chat.delete");
    });
  });

  it("refuses another bot's message", async () => {
    await withMockFetch(slack([{ type: "message", ts: TS, bot_id: "B0OTHER", user: "U0OTHER" }]), async (calls) => {
      await expect(runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS })).rejects.toThrow(
        /not posted by this bot/,
      );
      expect(methods(calls)).not.toContain("chat.delete");
    });
  });

  it("refuses a message it can't find, pointing at threadTs", async () => {
    await withMockFetch(slack([]), async (calls) => {
      await expect(runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS })).rejects.toThrow(
        /threadTs/,
      );
      expect(methods(calls)).not.toContain("chat.delete");
    });
  });

  it("ignores a neighboring message with a different ts", async () => {
    await withMockFetch(
      slack([{ type: "message", ts: "1726000000.000999", bot_id: "B0BOT" }]),
      async (calls) => {
        await expect(runTool("slack_message_delete", { channelId: "C0TEAM", ts: TS })).rejects.toThrow();
        expect(methods(calls)).not.toContain("chat.delete");
      },
    );
  });
});

describe("slack_message_delete approval", () => {
  it("asks a human, naming the channel and message", () => {
    const approval = approvalFor("slack_message_delete", { channelId: "C0TEAM", ts: TS });
    expect(approval).toMatchObject({
      title: "Delete Slack message",
      scope: { kind: "external-post", target: "channel C0TEAM" },
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(approval?.description).toContain(TS);
  });

  it("a denied delete never calls Slack", async () => {
    await withMockFetch(slack([{ type: "message", ts: TS, bot_id: "B0BOT" }]), async (calls) => {
      const { hooks } = registerPlugin();
      const hook = hooks.find((candidate) => candidate.hookName === "before_tool_call")!;
      const params = { channelId: "C0TEAM", ts: TS };
      const result = (await hook.handler(
        { toolName: "slack_message_delete", params },
        { toolName: "slack_message_delete" },
      )) as { requireApproval?: { allowedDecisions?: string[] } } | undefined;
      expect(result?.requireApproval?.allowedDecisions).toContain("deny");
      expect(calls).toHaveLength(0);
    });
  });
});
