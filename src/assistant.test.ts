import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tool = () =>
  getToolPluginMetadata(entry)?.tools.find((candidate) => candidate.name === "slack_assistant_set_title");

describe("slack_assistant_set_title", () => {
  it("calls assistant.threads.setTitle with the channel, thread, and title", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      const result = await runTool("slack_assistant_set_title", {
        channelId: "D0ALICE",
        threadTs: "1726000000.000100",
        title: "Q3 revenue questions",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("assistant.threads.setTitle");
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[0].body).toEqual({
        channel_id: "D0ALICE",
        thread_ts: "1726000000.000100",
        title: "Q3 revenue questions",
      });
      expect(result).toEqual({
        channelId: "D0ALICE",
        threadTs: "1726000000.000100",
        title: "Q3 revenue questions",
      });
    });
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(() => ({ ok: false, error: "not_agent_app" }), async () => {
      await expect(
        runTool("slack_assistant_set_title", { channelId: "C0TEAM", threadTs: "1.2", title: "x" }),
      ).rejects.toThrow("not_agent_app");
    });
  });

  it("returns output that matches its schema", async () => {
    await withMockFetch(() => ({ ok: true }), async () => {
      const result = await runTool("slack_assistant_set_title", {
        channelId: "D0ALICE",
        threadTs: "1.2",
        title: "Topic",
      });
      expect(Value.Check(tool()!.outputSchema!, result)).toBe(true);
    });
  });

  it("requires channelId, threadTs, and a non-empty title", () => {
    const parameters = tool()!.parameters;
    expect(Value.Check(parameters, { channelId: "D0ALICE", threadTs: "1.2", title: "Topic" })).toBe(true);
    expect(Value.Check(parameters, { channelId: "D0ALICE", title: "Topic" })).toBe(false);
    expect(Value.Check(parameters, { channelId: "D0ALICE", threadTs: "1.2" })).toBe(false);
    expect(Value.Check(parameters, { channelId: "D0ALICE", threadTs: "1.2", title: "" })).toBe(false);
  });

  it("documents that it only works in Agent View/Assistant View threads", () => {
    expect(tool()!.description).toMatch(/Agent View/);
    expect(tool()!.description).toMatch(/Assistant View/);
  });
});
