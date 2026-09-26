import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { approvalFor } from "./approvals.js";
import { callSlack } from "./client.js";
import { runTool, TEST_CONFIG, withMockFetch, type RecordedCall } from "./test-utils.js";

const PUBLIC = { id: "C0TEST", name: "general", is_private: false, is_archived: false };
const PRIVATE = { ...PUBLIC, id: "C0PRIV", name: "secret", is_private: true };
const ARCHIVED = { ...PUBLIC, is_archived: true };
const DM = { id: "D0TEST", is_im: true };

const BOOKMARK = { id: "Bk0TEST", title: "Roadmap", link: "https://example.com", type: "link" };
const NOT_IN_CHANNEL = { ok: false, error: "not_in_channel" };

const methods = (calls: RecordedCall[]) => calls.map((call) => call.method);
const outputSchemaOf = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.outputSchema!;

/**
 * `bookmarks.list` answers `not_in_channel` until `conversations.join` succeeds.
 * Override any method's answer with `overrides`.
 */
function membershipSlack(
  channel: Record<string, unknown>,
  overrides: Record<string, Record<string, unknown>> = {},
) {
  let member = false;
  return ({ method }: RecordedCall) => {
    if (overrides[method]) return overrides[method];
    if (method === "conversations.info") return { ok: true, channel };
    if (method === "conversations.join") {
      member = true;
      return { ok: true, channel };
    }
    if (method === "bookmarks.list") return member ? { ok: true, bookmarks: [BOOKMARK] } : NOT_IN_CHANNEL;
    return { ok: true };
  };
}

const listBookmarks = (channelId = "C0TEST", config: Record<string, unknown> = TEST_CONFIG) =>
  runTool("slack_bookmark_list", { channelId }, config);

describe("auto-join on not_in_channel", () => {
  it("joins a public channel once, retries once, and reports autoJoined", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      const result = await listBookmarks();
      expect(result).toEqual({ bookmarks: [BOOKMARK], autoJoined: true });
      expect(Value.Check(outputSchemaOf("slack_bookmark_list"), result)).toBe(true);
      expect(methods(calls)).toEqual([
        "bookmarks.list",
        "conversations.info",
        "conversations.join",
        "bookmarks.list",
      ]);
      expect(calls[2].body).toEqual({ channel: "C0TEST" });
      expect(calls[2].headers.authorization).toBe("Bearer xoxb-test");
    });
  });

  it("omits autoJoined when the bot was already a member", async () => {
    await withMockFetch(
      () => ({ ok: true, bookmarks: [BOOKMARK] }),
      async (calls) => {
        await expect(listBookmarks()).resolves.toEqual({ bookmarks: [BOOKMARK] });
        expect(methods(calls)).toEqual(["bookmarks.list"]);
      },
    );
  });

  it("never joins a private channel and asks for an invite instead", async () => {
    await withMockFetch(membershipSlack(PRIVATE), async (calls) => {
      await expect(listBookmarks("C0PRIV")).rejects.toThrow("/invite @OpenClaw");
      expect(methods(calls)).toEqual(["bookmarks.list", "conversations.info"]);
    });
  });

  it("never joins a DM", async () => {
    await withMockFetch(membershipSlack(DM), async (calls) => {
      await expect(listBookmarks("D0TEST")).rejects.toThrow("/invite @OpenClaw");
      expect(methods(calls)).not.toContain("conversations.join");
    });
  });

  it("treats a channel the bot cannot look up as needing an invite", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.info": { ok: false, error: "channel_not_found" },
    });
    await withMockFetch(slack, async (calls) => {
      await expect(listBookmarks("C0HIDDEN")).rejects.toThrow("/invite @OpenClaw");
      expect(methods(calls)).not.toContain("conversations.join");
    });
  });

  it("reports a missing channels:read as itself, not as a private channel", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.info": { ok: false, error: "missing_scope", needed: "channels:read" },
    });
    await withMockFetch(slack, async (calls) => {
      const failure = listBookmarks();
      await expect(failure).rejects.toThrow("needs scope: channels:read");
      await expect(failure).rejects.not.toThrow("may be private");
      expect(methods(calls)).not.toContain("conversations.join");
    });
  });

  it("surfaces an archived channel as a clear error without joining", async () => {
    await withMockFetch(membershipSlack(ARCHIVED), async (calls) => {
      await expect(listBookmarks()).rejects.toThrow("is archived");
      expect(methods(calls)).not.toContain("conversations.join");
    });
  });

  it("names channels:join and O-12 when the join lacks the scope, without retrying", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.join": { ok: false, error: "missing_scope", needed: "channels:join" },
    });
    await withMockFetch(slack, async (calls) => {
      const failure = listBookmarks();
      await expect(failure).rejects.toThrow("channels:join");
      await expect(failure).rejects.toThrow("O-12");
      expect(methods(calls)).toEqual(["bookmarks.list", "conversations.info", "conversations.join"]);
    });
  });

  it("retries at most once: a second not_in_channel does not join again", async () => {
    const slack = membershipSlack(PUBLIC);
    const stubborn = (call: RecordedCall) =>
      call.method === "bookmarks.list" ? NOT_IN_CHANNEL : slack(call);
    await withMockFetch(stubborn, async (calls) => {
      await expect(listBookmarks()).rejects.toThrow(/not_in_channel.*auto-joined C0TEST/);
      expect(methods(calls)).toEqual([
        "bookmarks.list",
        "conversations.info",
        "conversations.join",
        "bookmarks.list",
      ]);
    });
  });

  it("does not join when autoJoin is false", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      await expect(listBookmarks("C0TEST", { ...TEST_CONFIG, autoJoin: false })).rejects.toThrow(
        "not_in_channel",
      );
      expect(methods(calls)).toEqual(["bookmarks.list"]);
    });
  });

  it("does not join a channel on the autoJoinDeny list", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      const config = { ...TEST_CONFIG, autoJoinDeny: ["C0TEST"] };
      await expect(listBookmarks("C0TEST", config)).rejects.toThrow("not_in_channel");
      expect(methods(calls)).toEqual(["bookmarks.list"]);
    });
  });

  it("only auto-joins for bot-token calls", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      const context = { autoJoin: { config: TEST_CONFIG, joined: new Set<string>() } };
      await expect(
        callSlack("bookmarks.list", "xoxp-test", { channel_id: "C0TEST" }, context),
      ).rejects.toThrow("not_in_channel");
      expect(methods(calls)).toEqual(["bookmarks.list"]);
    });
  });

  it("also covers calls that name the channel as `channel`", async () => {
    let member = false;
    const slack = ({ method }: RecordedCall) => {
      if (method === "conversations.info") return { ok: true, channel: PUBLIC };
      if (method === "conversations.join") {
        member = true;
        return { ok: true, channel: PUBLIC };
      }
      return member ? { ok: true } : NOT_IN_CHANNEL;
    };
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_channel_set_topic", { channelId: "C0TEST", topic: "t" });
      expect(result).toEqual({ channelId: "C0TEST", topic: "t", autoJoined: true });
      expect(methods(calls)).toEqual([
        "conversations.setTopic",
        "conversations.info",
        "conversations.join",
        "conversations.setTopic",
      ]);
    });
  });
});

describe("slack_channel_join", () => {
  it("joins a public channel", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      const result = await runTool("slack_channel_join", { channelId: "C0TEST" });
      expect(result).toEqual({ channel: { id: "C0TEST", name: "general" }, alreadyMember: false });
      expect(Value.Check(outputSchemaOf("slack_channel_join"), result)).toBe(true);
      expect(methods(calls)).toEqual(["conversations.info", "conversations.join"]);
      expect(calls[1].body).toEqual({ channel: "C0TEST" });
    });
  });

  it("reports when the bot was already a member", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.join": { ok: true, channel: PUBLIC, warning: "already_in_channel" },
    });
    await withMockFetch(slack, async () => {
      await expect(runTool("slack_channel_join", { channelId: "C0TEST" })).resolves.toMatchObject({
        alreadyMember: true,
      });
    });
  });

  it("refuses a private channel without calling conversations.join", async () => {
    await withMockFetch(membershipSlack(PRIVATE), async (calls) => {
      await expect(runTool("slack_channel_join", { channelId: "C0PRIV" })).rejects.toThrow(
        "the bot must be invited (`/invite @OpenClaw`)",
      );
      expect(methods(calls)).toEqual(["conversations.info"]);
    });
  });

  it("refuses an archived channel", async () => {
    await withMockFetch(membershipSlack(ARCHIVED), async (calls) => {
      await expect(runTool("slack_channel_join", { channelId: "C0TEST" })).rejects.toThrow(
        "Channel C0TEST is archived",
      );
      expect(methods(calls)).toEqual(["conversations.info"]);
    });
  });

  it("names channels:join and O-12 on missing_scope", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.join": { ok: false, error: "missing_scope", needed: "channels:join" },
    });
    await withMockFetch(slack, async () => {
      await expect(runTool("slack_channel_join", { channelId: "C0TEST" })).rejects.toThrow(
        /channels:join.*O-12/,
      );
    });
  });

  it("is not approval-gated", () => {
    expect(approvalFor("slack_channel_join", { channelId: "C0TEST" })).toBeUndefined();
  });
});

describe("slack_channel_leave", () => {
  it("leaves a public channel", async () => {
    await withMockFetch(membershipSlack(PUBLIC), async (calls) => {
      const result = await runTool("slack_channel_leave", { channelId: "C0TEST" });
      expect(result).toEqual({ channelId: "C0TEST", left: true });
      expect(Value.Check(outputSchemaOf("slack_channel_leave"), result)).toBe(true);
      expect(methods(calls)).toEqual(["conversations.info", "conversations.leave"]);
      expect(calls[1].body).toEqual({ channel: "C0TEST" });
    });
  });

  it("reports left: false when the bot was not a member", async () => {
    const slack = membershipSlack(PUBLIC, {
      "conversations.leave": { ok: true, not_in_channel: true },
    });
    await withMockFetch(slack, async (calls) => {
      await expect(runTool("slack_channel_leave", { channelId: "C0TEST" })).resolves.toEqual({
        channelId: "C0TEST",
        left: false,
      });
      expect(methods(calls)).not.toContain("conversations.join");
    });
  });

  it("refuses a private channel, which the bot couldn't rejoin on its own", async () => {
    await withMockFetch(membershipSlack(PRIVATE), async (calls) => {
      await expect(runTool("slack_channel_leave", { channelId: "C0PRIV" })).rejects.toThrow(
        "Channel C0PRIV is a private channel. slack_channel_leave only leaves public channels",
      );
      expect(methods(calls)).toEqual(["conversations.info"]);
    });
  });

  it("is not approval-gated", () => {
    expect(approvalFor("slack_channel_leave", { channelId: "C0TEST" })).toBeUndefined();
  });
});

describe("auto-join config", () => {
  const schema = entry.configSchema as { safeParse: (value: unknown) => { success: boolean } };

  it("accepts autoJoin and autoJoinDeny", () => {
    expect(schema.safeParse({ autoJoin: false, autoJoinDeny: ["C0TEST"] }).success).toBe(true);
  });

  it("rejects a non-boolean autoJoin and a non-list autoJoinDeny", () => {
    expect(schema.safeParse({ autoJoin: "yes" }).success).toBe(false);
    expect(schema.safeParse({ autoJoinDeny: "C0TEST" }).success).toBe(false);
  });
});
