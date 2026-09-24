import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tool = () =>
  getToolPluginMetadata(entry)?.tools.find((candidate) => candidate.name === "slack_post_ephemeral");

const posted = { ok: true, message_ts: "1726000000.000100" };

describe("slack_post_ephemeral", () => {
  it("calls chat.postEphemeral with the channel, user, and text", async () => {
    await withMockFetch(() => posted, async (calls) => {
      const result = await runTool("slack_post_ephemeral", {
        channelId: "C0TEAM",
        userId: "U0ALICE",
        text: "Only you can see this.",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("chat.postEphemeral");
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[0].body).toEqual({
        channel: "C0TEAM",
        user: "U0ALICE",
        text: "Only you can see this.",
      });
      expect(result).toEqual({
        channelId: "C0TEAM",
        userId: "U0ALICE",
        ephemeralTs: "1726000000.000100",
      });
    });
  });

  it("passes blocks and threadTs through", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*psst*" } }];
    await withMockFetch(() => posted, async (calls) => {
      await runTool("slack_post_ephemeral", {
        channelId: "C0TEAM",
        userId: "U0ALICE",
        text: "psst",
        blocks,
        threadTs: "1726000000.000001",
      });
      expect(calls[0].body).toEqual({
        channel: "C0TEAM",
        user: "U0ALICE",
        text: "psst",
        blocks,
        thread_ts: "1726000000.000001",
      });
    });
  });

  it("throws when Slack omits message_ts", async () => {
    await withMockFetch(() => ({ ok: true }), async () => {
      await expect(
        runTool("slack_post_ephemeral", { channelId: "C0TEAM", userId: "U0ALICE", text: "hi" }),
      ).rejects.toThrow("returned no message_ts");
    });
  });

  it("returns output that matches its schema", async () => {
    await withMockFetch(() => posted, async () => {
      const result = await runTool("slack_post_ephemeral", {
        channelId: "C0TEAM",
        userId: "U0ALICE",
        text: "hi",
      });
      expect(Value.Check(tool()!.outputSchema!, result)).toBe(true);
    });
  });

  it("does not promise an updatable ts in its output schema", () => {
    const schema = tool()?.outputSchema as {
      properties: Record<string, { description?: string }>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["autoJoined", "channelId", "ephemeralTs", "userId"]);
    expect(schema.properties).not.toHaveProperty("ts");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.ephemeralTs.description).toMatch(/cannot be updated/i);
  });

  it("requires channelId, userId, and text", () => {
    const parameters = tool()!.parameters;
    expect(Value.Check(parameters, { channelId: "C0TEAM", userId: "U0ALICE", text: "hi" })).toBe(true);
    expect(Value.Check(parameters, { channelId: "C0TEAM", text: "hi" })).toBe(false);
    expect(Value.Check(parameters, { channelId: "C0TEAM", userId: "U0ALICE" })).toBe(false);
  });
});
