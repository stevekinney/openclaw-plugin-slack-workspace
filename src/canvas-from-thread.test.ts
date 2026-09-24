import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { resetWorkspaceCache } from "./client.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";
import { fetchThread, threadMarkdown } from "./tools/canvases.js";

const ORIGIN = "https://example-workspace.slack.com";
const TEAM_ID = "T0TEST";
const THREAD_TS = "1726000000.000100";

const THREAD = [
  { ts: THREAD_TS, user: "U0ALICE", text: "Should we ship <https://example.com/pr/1|the PR> today?" },
  { ts: "1726000060.000200", user: "U0BOB", text: "Yes, <@U0ALICE>. Tests pass &amp; <#C0OPS|ops> is ready." },
  { ts: "1726000120.000300", bot_id: "B0BOT", username: "deploybot", text: "Deploy queued\nstep 2" },
];

type Handler = (call: RecordedCall) => Record<string, unknown>;

const slack =
  (overrides: Record<string, Handler> = {}): Handler =>
  (call) => {
    const override = overrides[call.method];
    if (override) return override(call);
    switch (call.method) {
      case "auth.test":
        return { ok: true, url: `${ORIGIN}/`, team_id: TEAM_ID };
      case "conversations.replies":
        return { ok: true, messages: THREAD, has_more: false };
      case "canvases.create":
        return { ok: true, canvas_id: "F0CANVAS" };
      default:
        return { ok: true };
    }
  };

const outputSchema = () =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === "slack_canvas_from_thread")
    ?.outputSchema;

beforeEach(() => resetWorkspaceCache());

describe("fetchThread", () => {
  it("walks every page of conversations.replies", async () => {
    const pages: Record<string, Record<string, unknown>> = {
      "": { ok: true, messages: THREAD.slice(0, 2), response_metadata: { next_cursor: "next" } },
      next: { ok: true, messages: THREAD.slice(2), response_metadata: { next_cursor: "" } },
    };
    await withMockFetch(
      (call) => pages[String(call.body.cursor ?? "")]!,
      async (calls) => {
        const thread = await fetchThread("xoxb-test", "C0TEAM", THREAD_TS, {});
        expect(calls.map((call) => call.method)).toEqual([
          "conversations.replies",
          "conversations.replies",
        ]);
        expect(calls[0]!.body).toMatchObject({ channel: "C0TEAM", ts: THREAD_TS });
        expect(calls[1]!.body).toMatchObject({ cursor: "next" });
        expect(thread.truncated).toBe(false);
        expect(thread.messages).toEqual([
          { ts: THREAD_TS, author: { userId: "U0ALICE" }, text: THREAD[0]!.text },
          { ts: "1726000060.000200", author: { userId: "U0BOB" }, text: THREAD[1]!.text },
          { ts: "1726000120.000300", author: { name: "deploybot" }, text: THREAD[2]!.text },
        ]);
      },
    );
  });

  it("reports truncation when the page cap is hit", async () => {
    await withMockFetch(
      () => ({ ok: true, messages: THREAD.slice(0, 1), response_metadata: { next_cursor: "more" } }),
      async (calls) => {
        const thread = await fetchThread("xoxb-test", "C0TEAM", THREAD_TS, {}, { maxPages: 1 });
        expect(calls).toHaveLength(1);
        expect(thread.truncated).toBe(true);
      },
    );
  });
});

describe("threadMarkdown", () => {
  it("renders a summary, a source line, and each message as a quoted block", () => {
    const markdown = threadMarkdown({
      channelId: "C0TEAM",
      messages: [
        { ts: THREAD_TS, author: { userId: "U0ALICE" }, text: THREAD[0]!.text },
        { ts: "1726000060.000200", author: { userId: "U0BOB" }, text: THREAD[1]!.text },
        { ts: "1726000120.000300", author: { name: "deploybot" }, text: THREAD[2]!.text },
      ],
      summary: "We agreed to ship.",
      permalink: `${ORIGIN}/archives/C0TEAM/p1726000000000100`,
      truncated: false,
    });
    expect(markdown).toBe(
      [
        "## Summary",
        "",
        "We agreed to ship.",
        "",
        "## Thread",
        "",
        `3 messages in ![](#C0TEAM) · [Open in Slack](${ORIGIN}/archives/C0TEAM/p1726000000000100)`,
        "",
        "**![](@U0ALICE)** · 2024-09-10 20:26 UTC",
        "> Should we ship [the PR](https://example.com/pr/1) today?",
        "",
        "**![](@U0BOB)** · 2024-09-10 20:27 UTC",
        "> Yes, ![](@U0ALICE). Tests pass & ![](#C0OPS) is ready.",
        "",
        "**deploybot** · 2024-09-10 20:28 UTC",
        "> Deploy queued",
        "> step 2",
      ].join("\n"),
    );
  });

  it("nests sections under a title heading and flags truncation", () => {
    const markdown = threadMarkdown({
      channelId: "C0TEAM",
      messages: [{ ts: THREAD_TS, author: { userId: "U0ALICE" }, text: "" }],
      heading: "Launch thread",
      permalink: null,
      truncated: true,
    });
    expect(markdown).toBe(
      [
        "## Launch thread",
        "",
        "### Thread",
        "",
        "1 message in ![](#C0TEAM) · only the first 1 were fetched",
        "",
        "**![](@U0ALICE)** · 2024-09-10 20:26 UTC",
        "> _(no text)_",
      ].join("\n"),
    );
  });
});

describe("slack_canvas_from_thread", () => {
  it("fetches the thread, creates a canvas, and shares it with the thread's channel", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_canvas_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        title: "Ship decision",
        summary: "We agreed to ship.",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.replies",
        "auth.test",
        "canvases.create",
        "canvases.access.set",
      ]);
      const create = calls[2]!.body as { title: string; document_content: { markdown: string } };
      expect(create.title).toBe("Ship decision");
      expect(create.document_content.markdown).toContain("We agreed to ship.");
      expect(create.document_content.markdown).toContain(
        `[Open in Slack](${ORIGIN}/archives/C0TEAM/p1726000000000100)`,
      );
      expect(calls[3]!.body).toEqual({
        canvas_id: "F0CANVAS",
        channel_ids: ["C0TEAM"],
        access_level: "write",
      });
      expect(result).toEqual({
        canvasId: "F0CANVAS",
        created: true,
        url: `${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`,
        messageCount: 3,
        truncated: false,
        sharedWith: ["C0TEAM"],
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("shares with the listed users at the requested level", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_canvas_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        userIds: ["U0ALICE"],
        accessLevel: "owner",
      });
      const share = calls.find((call) => call.method === "canvases.access.set");
      expect(share!.body).toEqual({
        canvas_id: "F0CANVAS",
        user_ids: ["U0ALICE"],
        access_level: "owner",
      });
      expect(result).toMatchObject({ sharedWith: ["U0ALICE"] });
      const create = calls.find((call) => call.method === "canvases.create");
      expect(create!.body.title).toBe("Thread summary · 2024-09-10");
    });
  });

  it("appends into an existing canvas under a title heading without resharing by default", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_canvas_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        canvasId: "F0EXISTING",
        title: "Ship decision",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.replies",
        "auth.test",
        "canvases.edit",
      ]);
      const edit = calls[2]!.body as {
        canvas_id: string;
        changes: { operation: string; document_content: { markdown: string } }[];
      };
      expect(edit.canvas_id).toBe("F0EXISTING");
      expect(edit.changes[0]!.operation).toBe("insert_at_end");
      expect(edit.changes[0]!.document_content.markdown.startsWith("## Ship decision\n")).toBe(true);
      expect(result).toEqual({
        canvasId: "F0EXISTING",
        created: false,
        url: `${ORIGIN}/docs/${TEAM_ID}/F0EXISTING`,
        messageCount: 3,
        truncated: false,
        sharedWith: null,
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("shares an appended canvas when targets are given", async () => {
    await withMockFetch(slack(), async (calls) => {
      await runTool("slack_canvas_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        canvasId: "F0EXISTING",
        channelIds: ["C0OTHER"],
        accessLevel: "read",
      });
      expect(calls.at(-1)).toMatchObject({
        method: "canvases.access.set",
        body: { canvas_id: "F0EXISTING", channel_ids: ["C0OTHER"], access_level: "read" },
      });
    });
  });

  it("reports a share failure without losing the canvas", async () => {
    const failShare = slack({
      "canvases.access.set": () => ({ ok: false, error: "channel_not_found" }),
    });
    await withMockFetch(failShare, async () => {
      const result = await runTool("slack_canvas_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
      });
      expect(result).toMatchObject({
        canvasId: "F0CANVAS",
        created: true,
        sharedWith: null,
        shareError: "Slack canvases.access.set failed: channel_not_found",
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it.each([
    [{ channelIds: ["C0ONE"], userIds: ["U0ONE"] }, "either channelIds or userIds, not both"],
    [{ channelIds: ["C0ONE"], accessLevel: "owner" }, "owner access can only be granted to users"],
    [{ accessLevel: "owner" }, "owner access can only be granted to users"],
  ])("rejects %o before calling Slack", async (params, message) => {
    await withMockFetch(slack(), async (calls) => {
      await expect(
        runTool("slack_canvas_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS, ...params }),
      ).rejects.toThrow(message);
      expect(calls).toEqual([]);
    });
  });

  it("fails without writing a canvas when the thread is empty or missing", async () => {
    await withMockFetch(slack({ "conversations.replies": () => ({ ok: true, messages: [] }) }), async (calls) => {
      await expect(
        runTool("slack_canvas_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS }),
      ).rejects.toThrow("No messages found");
      expect(calls.map((call) => call.method)).toEqual(["conversations.replies"]);
    });
    await withMockFetch(
      slack({ "conversations.replies": () => ({ ok: false, error: "thread_not_found" }) }),
      async (calls) => {
        await expect(
          runTool("slack_canvas_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS }),
        ).rejects.toThrow("conversations.replies failed: thread_not_found");
        expect(calls.map((call) => call.method)).toEqual(["conversations.replies"]);
      },
    );
  });
});
