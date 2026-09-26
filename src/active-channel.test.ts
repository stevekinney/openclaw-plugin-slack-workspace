import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { ACTIVE_CHANNEL_NOTE } from "./schemas.js";
import { runTool, TEST_CONFIG, recordingLogger, withMockFetch, type TurnContext } from "./test-utils.js";

const SLACK_TURN: TurnContext = { messageChannel: "slack", nativeChannelId: "C0ACTIVE" };
const NO_TURN_ERROR = /channelId is required: this call is not running inside a Slack conversation/;

const table = { caption: "Deploys", columns: ["service"], rows: [["api"]] };

/** Slack answers every method well enough for any messaging tool to finish. */
const slack = () => ({ ok: true, channel: "C0ACTIVE", ts: "1.2", message_ts: "1.3", messages: [] });

const runInTurn = (name: string, params: Record<string, unknown>, turn: TurnContext) =>
  runTool(name, params, TEST_CONFIG, recordingLogger(), turn);

describe("channelId defaults to the active Slack turn", () => {
  it("slack_post_table posts into the current conversation when channelId is omitted", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runInTurn("slack_post_table", table, SLACK_TURN);
      expect(calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.getPermalink"]);
      expect(calls[0].method).toBe("chat.postMessage");
      expect(calls[0].body.channel).toBe("C0ACTIVE");
      expect(result).toMatchObject({ channelId: "C0ACTIVE", updated: false });
    });
  });

  it("an explicit channelId wins over the active turn", async () => {
    await withMockFetch(
      () => ({ ok: true, channel: "C0OTHER", ts: "1.2" }),
      async (calls) => {
        await runInTurn("slack_post_table", { ...table, channelId: "C0OTHER" }, SLACK_TURN);
        expect(calls[0].body.channel).toBe("C0OTHER");
      },
    );
  });

  it("without an active turn (cron, automations), omitting channelId fails before calling Slack", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(runInTurn("slack_post_table", table, {})).rejects.toThrow(NO_TURN_ERROR);
      expect(calls).toHaveLength(0);
    });
  });

  it("an explicit channelId still works without an active turn", async () => {
    await withMockFetch(slack, async (calls) => {
      await runInTurn("slack_post_table", { ...table, channelId: "C0CRON" }, {});
      expect(calls[0].body.channel).toBe("C0CRON");
    });
  });

  it("ignores another platform's nativeChannelId", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runInTurn("slack_post_table", table, { messageChannel: "discord", nativeChannelId: "123456" }),
      ).rejects.toThrow(NO_TURN_ERROR);
      expect(calls).toHaveLength(0);
    });
  });

  it("requires a nativeChannelId, not just a Slack turn", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(runInTurn("slack_post_table", table, { messageChannel: "slack" })).rejects.toThrow(
        NO_TURN_ERROR,
      );
      expect(calls).toHaveLength(0);
    });
  });

  const cases: [string, string, Record<string, unknown>][] = [
    ["slack_post_plan", "chat.postMessage", { title: "P", tasks: [{ title: "x", status: "pending" }] }],
    ["slack_post_rich_text", "chat.postMessage", { sections: [{ type: "paragraph", text: "x" }] }],
    ["slack_post_chart", "chat.postMessage", { title: "C", chartType: "pie", segments: [{ label: "a", value: 1 }] }],
    ["slack_blocks_send", "chat.postMessage", { text: "t", blocks: [{ type: "divider" }] }],
    ["slack_blocks_update", "chat.update", { ts: "1.2", text: "t", blocks: [{ type: "divider" }] }],
    ["slack_message_get", "conversations.history", { eventType: "openclaw_card_v1" }],
    ["slack_post_ephemeral", "chat.postEphemeral", { userId: "U0ALICE", text: "psst" }],
  ];

  it.each(cases)("%s defaults to the active conversation", async (name, method, params) => {
    await withMockFetch(slack, async (calls) => {
      await runInTurn(name, params, SLACK_TURN);
      expect(calls[0].method).toBe(method);
      expect(calls[0].body.channel).toBe("C0ACTIVE");
    });
  });

  it.each(cases)("%s requires channelId without an active turn", async (name, _method, params) => {
    await withMockFetch(slack, async (calls) => {
      await expect(runInTurn(name, params, {})).rejects.toThrow(NO_TURN_ERROR);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("channelId schema", () => {
  type Schema = { required?: string[]; properties: Record<string, { description?: string }> };
  const parameters = (name: string) =>
    getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.parameters as Schema;

  it("is optional on messaging tools and says when it can be omitted", () => {
    for (const name of ["slack_post_table", "slack_blocks_send", "slack_post_ephemeral"]) {
      expect(parameters(name).required ?? [], name).not.toContain("channelId");
      expect(parameters(name).properties.channelId.description, name).toContain(ACTIVE_CHANNEL_NOTE);
    }
  });

  it("stays required on tools that change a channel itself", () => {
    expect(parameters("slack_channel_archive").required).toContain("channelId");
  });
});
