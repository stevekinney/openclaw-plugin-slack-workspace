import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tool = () =>
  getToolPluginMetadata(entry)?.tools.find((candidate) => candidate.name === "slack_assistant_set_title");

describe("slack_assistant_set_title", () => {
  it("calls agents.sessions.rename with the channel, thread, and title", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      const result = await runTool("slack_assistant_set_title", {
        channelId: "D0ALICE",
        threadTs: "1726000000.000100",
        title: "Q3 revenue questions",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("agents.sessions.rename");
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
        api: "agents.sessions",
      });
    });
  });

  it.each(["unknown_method", "missing_scope"])(
    "falls back to assistant.threads.setTitle when agents.sessions.rename fails with %s",
    async (code) => {
      await withMockFetch(
        (call) => (call.method === "agents.sessions.rename" ? { ok: false, error: code } : { ok: true }),
        async (calls) => {
          const result = await runTool("slack_assistant_set_title", {
            channelId: "D0ALICE",
            threadTs: "1726000000.000100",
            title: "Q3 revenue questions",
          });
          expect(calls.map((call) => call.method)).toEqual([
            "agents.sessions.rename",
            "assistant.threads.setTitle",
          ]);
          expect(calls[1].headers.authorization).toBe("Bearer xoxb-test");
          expect(calls[1].body).toEqual({
            channel_id: "D0ALICE",
            thread_ts: "1726000000.000100",
            title: "Q3 revenue questions",
          });
          expect(result).toEqual({
            channelId: "D0ALICE",
            threadTs: "1726000000.000100",
            title: "Q3 revenue questions",
            api: "assistant.threads",
          });
        },
      );
    },
  );

  it("does not fall back on other agents.sessions.rename errors", async () => {
    await withMockFetch(() => ({ ok: false, error: "session_not_found" }), async (calls) => {
      await expect(
        runTool("slack_assistant_set_title", { channelId: "D0ALICE", threadTs: "1.2", title: "x" }),
      ).rejects.toThrow("session_not_found");
      expect(calls.map((call) => call.method)).toEqual(["agents.sessions.rename"]);
    });
  });

  it("reports both errors when the legacy fallback fails too", async () => {
    await withMockFetch(
      (call) =>
        call.method === "agents.sessions.rename"
          ? { ok: false, error: "unknown_method" }
          : { ok: false, error: "not_agent_app" },
      async () => {
        await expect(
          runTool("slack_assistant_set_title", { channelId: "D0ALICE", threadTs: "1.2", title: "x" }),
        ).rejects.toThrow(/unknown_method.*not_agent_app/);
      },
    );
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
    expect(
      Value.Check(parameters, { channelId: "D0ALICE", threadTs: "1.2", title: "x".repeat(201) }),
    ).toBe(false);
  });

  it("documents that it only works in Agent View/Assistant View threads", () => {
    expect(tool()!.description).toMatch(/Agent View/);
    expect(tool()!.description).toMatch(/Assistant View/);
  });
});

const suggestTool = () =>
  getToolPluginMetadata(entry)?.tools.find(
    (candidate) => candidate.name === "slack_assistant_suggest_prompts",
  );

const prompt = (n: number) => ({ title: `Prompt ${n}`, message: `Tell me about ${n}` });

describe("slack_assistant_suggest_prompts", () => {
  it("calls assistant.threads.setSuggestedPrompts with the channel, thread, and prompts", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      const prompts = [prompt(1), prompt(2)];
      const result = await runTool("slack_assistant_suggest_prompts", {
        channelId: "D0ALICE",
        threadTs: "1726000000.000100",
        prompts,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("assistant.threads.setSuggestedPrompts");
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[0].body).toEqual({
        channel_id: "D0ALICE",
        thread_ts: "1726000000.000100",
        prompts,
      });
      expect(result).toEqual({ channelId: "D0ALICE", threadTs: "1726000000.000100", prompts });
    });
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(() => ({ ok: false, error: "not_agent_app" }), async () => {
      await expect(
        runTool("slack_assistant_suggest_prompts", {
          channelId: "C0TEAM",
          threadTs: "1.2",
          prompts: [prompt(1)],
        }),
      ).rejects.toThrow("not_agent_app");
    });
  });

  it("returns output that matches its schema", async () => {
    await withMockFetch(() => ({ ok: true }), async () => {
      const result = await runTool("slack_assistant_suggest_prompts", {
        channelId: "D0ALICE",
        threadTs: "1.2",
        prompts: [prompt(1)],
      });
      expect(Value.Check(suggestTool()!.outputSchema!, result)).toBe(true);
    });
  });

  it("accepts one to four {title, message} prompts", () => {
    const parameters = suggestTool()!.parameters;
    const args = (prompts: unknown) => ({ channelId: "D0ALICE", threadTs: "1.2", prompts });
    expect(Value.Check(parameters, args([prompt(1)]))).toBe(true);
    expect(Value.Check(parameters, args([1, 2, 3, 4].map(prompt)))).toBe(true);
    expect(Value.Check(parameters, args([1, 2, 3, 4, 5].map(prompt)))).toBe(false);
    expect(Value.Check(parameters, args([]))).toBe(false);
    expect(Value.Check(parameters, args([{ title: "No message" }]))).toBe(false);
    expect(Value.Check(parameters, args([{ title: "", message: "x" }]))).toBe(false);
    expect(Value.Check(parameters, args([{ title: "x", message: "" }]))).toBe(false);
    expect(Value.Check(parameters, { channelId: "D0ALICE", prompts: [prompt(1)] })).toBe(false);
  });

  it("documents that it only works in Agent View/Assistant View threads", () => {
    expect(suggestTool()!.description).toMatch(/Agent View/);
    expect(suggestTool()!.description).toMatch(/Assistant View/);
  });

  it("documents that prompts appear at the top of the Messages tab", () => {
    expect(suggestTool()!.description).toMatch(/top of the Messages tab/);
  });
});
