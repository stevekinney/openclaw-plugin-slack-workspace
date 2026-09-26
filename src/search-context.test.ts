import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, slackResponse, withMockFetch } from "./test-utils.js";

const toolNamed = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!;

/** A message hit as assistant.search.context returns it, context messages included. */
const contextHit = {
  author_name: "Steve",
  author_user_id: "U0STEVE",
  team_id: "T0TEST",
  channel_id: "C0ROADMAP",
  channel_name: "roadmap",
  message_ts: "1758800000.000100",
  content: "We decided to ship search on the user token.",
  is_author_bot: false,
  permalink: "https://example.slack.com/archives/C0ROADMAP/p1758800000000100",
  blocks: [{ type: "rich_text" }],
  context_messages: {
    before: [{ user_id: "U0ALICE", ts: "1758799990.000100", text: "What about search?", blocks: [] }],
    after: [{ user_id: "U0BOB", ts: "1758800010.000100", text: "Sounds good.", blocks: [] }],
  },
};

/** A legacy search.messages hit. */
const legacyHit = {
  ts: "1758800000.000100",
  text: "We decided to ship search on the user token.",
  user: "U0STEVE",
  username: "steve",
  channel: { id: "C0ROADMAP", name: "roadmap", is_private: false },
  permalink: "https://example.slack.com/archives/C0ROADMAP/p1758800000000100",
  score: 0.9,
};

const legacyResponse = {
  ok: true,
  messages: { total: 1, paging: { count: 10, page: 1 }, matches: [legacyHit] },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("slack_search_context", () => {
  it("returns ranked messages with their context and permalinks", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        results: { messages: [contextHit] },
        response_metadata: { next_cursor: "cursor-2" },
      }),
      async (calls) => {
        const result = await runTool("slack_search_context", {
          query: "what did we decide about search?",
        });
        expect(calls.map((call) => call.method)).toEqual(["assistant.search.context"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxp-test");
        // User-token calls carry no action_token.
        expect(calls[0].body).toEqual({
          query: "what did we decide about search?",
          content_types: "messages",
          channel_types: "public_channel,private_channel,mpim,im",
          include_context_messages: "true",
          limit: "10",
          sort: "score",
          sort_dir: "desc",
        });
        expect(result).toEqual({
          mode: "context",
          query: "what did we decide about search?",
          messages: [
            {
              channelId: "C0ROADMAP",
              channelName: "roadmap",
              ts: "1758800000.000100",
              userId: "U0STEVE",
              userName: "Steve",
              isBot: false,
              text: "We decided to ship search on the user token.",
              permalink: "https://example.slack.com/archives/C0ROADMAP/p1758800000000100",
              context: {
                before: [{ ts: "1758799990.000100", userId: "U0ALICE", text: "What about search?" }],
                after: [{ ts: "1758800010.000100", userId: "U0BOB", text: "Sounds good." }],
              },
            },
          ],
          nextCursor: "cursor-2",
        });
        expect(Value.Check(toolNamed("slack_search_context").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("searches files, channels and users on request", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        results: {
          messages: [],
          files: [
            {
              uploader_user_id: "U0STEVE",
              author_user_id: "U0STEVE",
              author_name: "Steve",
              team_id: "T0TEST",
              file_id: "F0SPEC",
              date_created: 1758800000,
              date_updated: 1758800100,
              title: "Search spec",
              file_type: "canvas",
              permalink: "https://example.slack.com/docs/T0TEST/F0SPEC",
              content: "Spec body",
            },
          ],
          channels: [
            {
              team_id: "T0TEST",
              creator_user_id: "U0STEVE",
              creator_name: "Steve",
              date_created: 1758700000,
              date_updated: 1758700100,
              name: "search",
              topic: "Search work",
              purpose: "",
              permalink: "https://example.slack.com/archives/C0SEARCH",
            },
          ],
          users: [{ user_id: "U0ALICE", full_name: "Alice" }],
        },
      }),
      async (calls) => {
        const result = await runTool("slack_search_context", {
          query: "search",
          contentTypes: ["messages", "files", "channels", "users"],
          channelTypes: ["public_channel"],
          includeContextMessages: false,
          limit: 5,
          after: 1758000000,
          before: 1759000000,
          sort: "timestamp",
          sortDir: "asc",
          cursor: "cursor-1",
        });
        expect(calls[0].body).toEqual({
          query: "search",
          content_types: "messages,files,channels,users",
          channel_types: "public_channel",
          include_context_messages: "false",
          limit: "5",
          after: "1758000000",
          before: "1759000000",
          sort: "timestamp",
          sort_dir: "asc",
          cursor: "cursor-1",
        });
        expect(result).toEqual({
          mode: "context",
          query: "search",
          messages: [],
          files: [
            {
              id: "F0SPEC",
              title: "Search spec",
              fileType: "canvas",
              userId: "U0STEVE",
              userName: "Steve",
              created: 1758800000,
              updated: 1758800100,
              permalink: "https://example.slack.com/docs/T0TEST/F0SPEC",
              content: "Spec body",
            },
          ],
          channels: [
            {
              name: "search",
              topic: "Search work",
              creatorId: "U0STEVE",
              created: 1758700000,
              permalink: "https://example.slack.com/archives/C0SEARCH",
            },
          ],
          users: [{ user_id: "U0ALICE", full_name: "Alice" }],
        });
        expect(Value.Check(toolNamed("slack_search_context").outputSchema!, result)).toBe(true);
      },
    );
  });

  describe("falls back to search.messages", () => {
    const triggers = [
      { ok: false, error: "missing_scope", needed: "search:read.public" },
      { ok: false, error: "not_allowed_token_type" },
      { ok: false, error: "unknown_method" },
      { ok: false, error: "feature_not_enabled" },
      { ok: false, error: "assistant_search_context_disabled" },
    ];

    it.each(triggers)("on $error, returning mode: legacy", async (failure) => {
      await withMockFetch(
        (call) => (call.method === "assistant.search.context" ? failure : legacyResponse),
        async (calls) => {
          const result = (await runTool("slack_search_context", {
            query: "search decision",
            limit: 5,
          })) as Record<string, unknown>;
          expect(calls.map((call) => call.method)).toEqual([
            "assistant.search.context",
            "search.messages",
          ]);
          expect(calls[1].headers.authorization).toBe("Bearer xoxp-test");
          expect(calls[1].body).toEqual({
            query: "search decision",
            count: "5",
            sort: "score",
            sort_dir: "desc",
          });
          expect(result).toMatchObject({
            mode: "legacy",
            query: "search decision",
            messages: [
              {
                channelId: "C0ROADMAP",
                channelName: "roadmap",
                ts: "1758800000.000100",
                userId: "U0STEVE",
                userName: "steve",
                text: "We decided to ship search on the user token.",
                permalink: "https://example.slack.com/archives/C0ROADMAP/p1758800000000100",
              },
            ],
          });
          expect(result.reason).toContain(failure.error);
          expect(result.reason).not.toContain("\n");
          expect(result.doctorHint).toContain("openclaw slack-workspace doctor");
          expect(Value.Check(toolNamed("slack_search_context").outputSchema!, result)).toBe(true);
        },
      );
    });

    it("reports both failures when the legacy search fails too", async () => {
      await withMockFetch(
        (call) =>
          call.method === "assistant.search.context"
            ? { ok: false, error: "missing_scope", needed: "search:read.public" }
            : { ok: false, error: "missing_scope", needed: "search:read" },
        async () => {
          await expect(runTool("slack_search_context", { query: "x" })).rejects.toThrow(
            /assistant\.search\.context failed: missing_scope.*search\.messages failed: missing_scope/s,
          );
        },
      );
    });
  });

  it("does not fall back on other Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "invalid_cursor" }),
      async (calls) => {
        await expect(
          runTool("slack_search_context", { query: "x", cursor: "stale" }),
        ).rejects.toThrow(/invalid_cursor/);
        expect(calls.map((call) => call.method)).toEqual(["assistant.search.context"]);
      },
    );
  });

  it("retries a rate-limited call after Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    await withMockFetch(
      () =>
        attempt++ === 0
          ? slackResponse({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "6" } })
          : { ok: true, results: { messages: [contextHit] } },
      async (calls) => {
        const pending = runTool("slack_search_context", { query: "x" });
        await vi.advanceTimersByTimeAsync(6000);
        const result = (await pending) as { mode: string; messages: unknown[] };
        expect(result.mode).toBe("context");
        expect(result.messages).toHaveLength(1);
        expect(calls.map((call) => call.method)).toEqual([
          "assistant.search.context",
          "assistant.search.context",
        ]);
      },
    );
  });

  it("surfaces a long rate limit instead of falling back to legacy search", async () => {
    await withMockFetch(
      () =>
        slackResponse({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "60" } }),
      async (calls) => {
        await expect(runTool("slack_search_context", { query: "x" })).rejects.toThrow(
          "Slack assistant.search.context failed: ratelimited (Slack asked to wait 60s; try again later)",
        );
        expect(calls.map((call) => call.method)).toEqual(["assistant.search.context"]);
      },
    );
  });

  it("describes results as turn-local and not to be stored", () => {
    const { description } = toolNamed("slack_search_context");
    expect(description).toMatch(/turn-local/i);
    expect(description).toMatch(/do not store/i);
  });

  it("limits a page to Slack's maximum of 20 results", () => {
    const { parameters } = toolNamed("slack_search_context");
    expect(Value.Check(parameters, { query: "x", limit: 20 })).toBe(true);
    expect(Value.Check(parameters, { query: "x", limit: 21 })).toBe(false);
    expect(Value.Check(parameters, { query: "x", contentTypes: [] })).toBe(false);
  });
});

describe("slack_search", () => {
  it("points to slack_search_context", () => {
    expect(toolNamed("slack_search").description).toContain("slack_search_context");
  });
});
