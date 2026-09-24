import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import {
  recordingLogger,
  registerPlugin,
  runTool,
  slackResponse,
  TEST_CONFIG,
  withMockFetch,
} from "./test-utils.js";

describe("slack-workspace", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "slack_identity",
      "slack_search",
      "slack_schedule_message",
      "slack_remind",
      "slack_scheduled_list",
      "slack_scheduled_cancel",
      "slack_post_table",
      "slack_post_plan",
      "slack_post_rich_text",
      "slack_post_chart",
      "slack_blocks_send",
      "slack_blocks_update",
      "slack_message_get",
      "slack_post_ephemeral",
      "slack_canvas_create",
      "slack_canvas_edit",
      "slack_canvas_sections",
      "slack_canvas_list",
      "slack_canvas_access_set",
      "slack_canvas_access_delete",
      "slack_canvas_delete",
      "slack_canvas_channel_get_or_create",
      "slack_canvas_status_update",
      "slack_canvas_from_thread",
      "slack_bookmark_list",
      "slack_bookmark_add",
      "slack_bookmark_remove",
      "slack_channel_create",
      "slack_channel_archive",
      "slack_channel_rename",
      "slack_channel_set_topic",
      "slack_channel_set_purpose",
      "slack_channel_invite",
      "slack_channel_join",
      "slack_channel_leave",
      "slack_channel_kickoff",
      "slack_list_create",
      "slack_list_schema",
      "slack_list_item_create",
      "slack_list_item_update",
      "slack_list_item_delete",
      "slack_list_items_delete_multiple",
      "slack_list_items_list",
      "slack_list_item_info",
      "slack_list_access_set",
      "slack_list_access_delete",
      "slack_list_from_thread",
      "slack_file_upload",
      "slack_assistant_set_title",
      "slack_assistant_suggest_prompts",
      "slack_workflow_trigger_run",
    ]);
  });

  it("registers the same tools it declares, through api.registerTool", () => {
    expect(registerPlugin().tools.map((tool) => tool.name)).toEqual(
      getToolPluginMetadata(entry)?.tools.map((tool) => tool.name),
    );
  });

  it("registers a before_tool_call hook scoped to its own tools", () => {
    const { tools, hooks } = registerPlugin();
    const hook = hooks.find((candidate) => candidate.hookName === "before_tool_call");
    expect(hook).toBeDefined();
    expect(hook?.opts?.matcher).toEqual(tools.map((tool) => tool.name));
  });

  it("lets non-destructive tool calls through without asking", async () => {
    const { hooks } = registerPlugin();
    const hook = hooks.find((candidate) => candidate.hookName === "before_tool_call")!;
    const decision = await hook.handler(
      { toolName: "slack_bookmark_add", params: { channelId: "C0TEST", title: "t", link: "l" } },
      {},
    );
    expect(decision).toBeUndefined();
  });
});

const ok = () => ({ ok: true, ts: "1700000000.000100" });
const target = { channelId: "C0TEST" };

describe("slack_post_table", () => {
  it("rejects a row whose width does not match the header, without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_table", {
          ...target,
          caption: "Scores",
          columns: ["name", "score"],
          rows: [
            ["a", 1],
            ["b", 2, "extra"],
          ],
        }),
      ).rejects.toThrow(
        "Row 1 has 3 cells but there are 2 columns. Slack requires every row to match the header width.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a table over Slack's 10,000-character aggregate limit, without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_table", {
          ...target,
          caption: "Notes",
          columns: ["id", "note"],
          // 2 header chars + 4 header chars + 100 × (3 + 97) = 10,006 characters.
          rows: Array.from({ length: 100 }, (_, index) => [
            String(index).padStart(3, "0"),
            "x".repeat(97),
          ]),
        }),
      ).rejects.toThrow(
        "Table cells total 10006 characters; Slack caps a data_table at 10000. Trim long cells or split the rows across tables.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("accepts a table exactly at the 10,000-character aggregate limit", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", {
        ...target,
        caption: "Notes",
        columns: ["id", "note"],
        // Same as the over-limit table, with the first note 6 characters shorter.
        rows: Array.from({ length: 100 }, (_, index) => [
          String(index).padStart(3, "0"),
          "x".repeat(index === 0 ? 91 : 97),
        ]),
      });
      expect(calls).toHaveLength(1);
    });
  });

  it("posts a data_table with raw_number cells when widths match", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_post_table", {
        ...target,
        caption: "Scores",
        columns: ["name", "score"],
        rows: [["a", 1]],
      });
      expect(result).toEqual({ channelId: "C0TEST", ts: "1700000000.000100", updated: false });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("chat.postMessage");
      expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      const [table] = calls[0].body.blocks as { rows: unknown[][] }[];
      expect(table.rows[1]).toEqual([
        { type: "raw_text", text: "a" },
        { type: "raw_number", value: 1, text: "1" },
      ]);
    });
  });

  it("returns the DM channel Slack resolved from a user ID, not the input", async () => {
    await withMockFetch(
      () => ({ ok: true, channel: "D0RESOLVED", ts: "1700000000.000100" }),
      async (calls) => {
        const result = await runTool("slack_post_table", {
          channelId: "U0TEST",
          caption: "Scores",
          columns: ["name"],
          rows: [["a"]],
        });
        expect(calls[0].body.channel).toBe("U0TEST");
        expect(result).toEqual({ channelId: "D0RESOLVED", ts: "1700000000.000100", updated: false });
      },
    );
  });

  it("returns the channel Slack reports from chat.update", async () => {
    await withMockFetch(
      () => ({ ok: true, channel: "D0RESOLVED", ts: "1700000000.000100" }),
      async (calls) => {
        const result = await runTool("slack_post_table", {
          channelId: "U0TEST",
          updateTs: "1700000000.000100",
          caption: "Scores",
          columns: ["name"],
          rows: [["a"]],
        });
        expect(calls[0].method).toBe("chat.update");
        expect(result).toEqual({ channelId: "D0RESOLVED", ts: "1700000000.000100", updated: true });
      },
    );
  });

  it("builds a plain-text fallback from the first rows, not just the caption", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", {
        ...target,
        caption: "Scores",
        columns: ["name", "score"],
        rows: [
          ["ada", 91],
          ["bob", 78],
          ["cy", 85],
          ["dee", 60],
          ["eve", 99],
        ],
      });
      expect(calls[0].body.text).toBe(
        "Scores (5 rows)\nname: ada, score: 91\nname: bob, score: 78\nname: cy, score: 85\n…and 2 more rows",
      );
    });
  });

  it("escapes Slack control characters in the fallback so cells cannot trigger mentions", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", {
        ...target,
        caption: "A & B",
        columns: ["who"],
        rows: [["<!channel>"]],
      });
      expect(calls[0].body.text).toBe("A &amp; B (1 row)\nwho: &lt;!channel&gt;");
    });
  });
});

describe("slack_post_plan", () => {
  it("passes every task status through to the plan block", async () => {
    await withMockFetch(ok, async (calls) => {
      const statuses = ["pending", "in_progress", "complete", "error"];
      await runTool("slack_post_plan", {
        ...target,
        title: "Deploy",
        tasks: statuses.map((status) => ({ title: status, status })),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body.text).toBe("Deploy — 1/4 complete");
      const [plan] = calls[0].body.blocks as { tasks: { task_id: string; status: string }[] }[];
      expect(plan.tasks.map((task) => task.status)).toEqual(statuses);
      expect(plan.tasks.map((task) => task.task_id)).toEqual(["task_1", "task_2", "task_3", "task_4"]);
    });
  });
});

describe("slack_post_chart", () => {
  it("rejects a series whose length does not match the categories, without calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_chart", {
          ...target,
          title: "Revenue",
          chartType: "bar",
          categories: ["Q1", "Q2", "Q3"],
          series: [
            { name: "2025", values: [1, 2, 3] },
            { name: "2026", values: [4, 5] },
          ],
        }),
      ).rejects.toThrow(
        'Series "2026" has 2 values but there are 3 categories. Slack requires exactly one value per category.',
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a non-pie chart that is missing categories or series", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_post_chart", { ...target, title: "Trend", chartType: "line", categories: ["Q1"] }),
      ).rejects.toThrow("A line chart requires both `categories` and `series`.");
      expect(calls).toHaveLength(0);
    });
  });

  it("builds a fallback listing the largest pie segments with their values", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_chart", {
        ...target,
        title: "Traffic",
        chartType: "pie",
        segments: [
          { label: "a", value: 5 },
          { label: "b", value: 40 },
          { label: "c", value: 10 },
          { label: "d", value: 30 },
          { label: "e", value: 1 },
          { label: "f", value: 20 },
          { label: "g", value: 2 },
        ],
      });
      expect(calls[0].body.text).toBe(
        "Traffic (pie chart)\nb: 40, d: 30, f: 20, c: 10, a: 5, …and 2 more",
      );
    });
  });

  it("builds a fallback listing each series' values by category", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_chart", {
        ...target,
        title: "Revenue",
        chartType: "bar",
        categories: ["Q1", "Q2", "Q3"],
        series: [
          { name: "2025", values: [1, 2, 3] },
          { name: "2026", values: [4, 5, 6.5] },
        ],
      });
      expect(calls[0].body.text).toBe(
        "Revenue (bar chart)\n2025: Q1 1, Q2 2, Q3 3\n2026: Q1 4, Q2 5, Q3 6.5",
      );
    });
  });
});

describe("link unfurling on proactive posts", () => {
  const table = { ...target, caption: "Links", columns: ["url"], rows: [["https://example.com"]] };
  const blocks = { ...target, text: "hi", blocks: [{ type: "divider" }] };

  it.each([
    ["slack_post_table", table],
    ["slack_blocks_send", blocks],
  ])("%s turns unfurling off by default", async (name, args) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, args);
      expect(calls[0].body).toMatchObject({ unfurl_links: false, unfurl_media: false });
    });
  });

  it.each([
    ["slack_post_table", table],
    ["slack_blocks_send", blocks],
  ])("%s forwards explicit unfurl overrides", async (name, args) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, { ...args, unfurlLinks: true, unfurlMedia: true });
      expect(calls[0].body).toMatchObject({ unfurl_links: true, unfurl_media: true });
    });
  });

  it("does not send unfurl flags to chat.update, which does not accept them", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", { ...table, updateTs: "1700000000.000100" });
      expect(calls[0].method).toBe("chat.update");
      expect(calls[0].body).not.toHaveProperty("unfurl_links");
      expect(calls[0].body).not.toHaveProperty("unfurl_media");
    });
  });
});

describe("reply broadcast on structured posts", () => {
  const thread = { ...target, threadTs: "1700000000.000100" };
  const table = { ...thread, caption: "T", columns: ["a"], rows: [["1"]] };
  const plan = { ...thread, title: "P", tasks: [{ title: "x", status: "pending" }] };
  const chart = {
    ...thread,
    title: "C",
    chartType: "pie",
    segments: [{ label: "a", value: 1 }],
  };

  it.each([
    ["slack_post_table", table],
    ["slack_post_plan", plan],
    ["slack_post_chart", chart],
  ])("%s sends reply_broadcast when replyBroadcast is set", async (name, args) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, { ...args, replyBroadcast: true });
      expect(calls[0].method).toBe("chat.postMessage");
      expect(calls[0].body).toMatchObject({
        thread_ts: "1700000000.000100",
        reply_broadcast: true,
      });
    });
  });

  it("omits reply_broadcast by default", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", table);
      expect(calls[0].body).not.toHaveProperty("reply_broadcast");
    });
  });

  it.each([
    ["slack_post_table", { ...table, threadTs: undefined }],
    ["slack_blocks_send", { ...target, text: "t", blocks: [{ type: "divider" }] }],
  ])("%s omits reply_broadcast without threadTs", async (name, args) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, { ...args, replyBroadcast: true });
      expect(calls[0].method).toBe("chat.postMessage");
      expect(calls[0].body).not.toHaveProperty("reply_broadcast");
    });
  });

  it("does not send reply_broadcast to chat.update", async () => {
    await withMockFetch(ok, async (calls) => {
      await runTool("slack_post_table", {
        ...table,
        replyBroadcast: true,
        updateTs: "1700000000.000200",
      });
      expect(calls[0].method).toBe("chat.update");
      expect(calls[0].body).not.toHaveProperty("reply_broadcast");
    });
  });
});

describe("message metadata on posts", () => {
  const table = { ...target, caption: "T", columns: ["a"], rows: [["1"]] };
  const plan = { ...target, title: "P", tasks: [{ title: "x", status: "pending" }] };
  const chart = { ...target, title: "C", chartType: "pie", segments: [{ label: "a", value: 1 }] };
  const blocks = { ...target, text: "t", blocks: [{ type: "divider" }] };
  const update = { ...blocks, ts: "1700000000.000100" };
  const metadata = { eventType: "openclaw_card_v1", eventPayload: { taskId: "T-1", revision: 2 } };
  const wire = { event_type: "openclaw_card_v1", event_payload: { taskId: "T-1", revision: 2 } };

  const cases: [string, Record<string, unknown>, string][] = [
    ["slack_post_table", table, "chat.postMessage"],
    ["slack_post_plan", plan, "chat.postMessage"],
    ["slack_post_chart", chart, "chat.postMessage"],
    ["slack_post_table", { ...table, updateTs: "1700000000.000100" }, "chat.update"],
    ["slack_blocks_send", blocks, "chat.postMessage"],
    ["slack_blocks_update", update, "chat.update"],
  ];

  it.each(cases)("%s forwards metadata (case %#)", async (name, args, method) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, { ...args, metadata });
      expect(calls[0].method).toBe(method);
      expect(calls[0].body.metadata).toEqual(wire);
    });
  });

  it.each(cases)("%s omits metadata when unset (case %#)", async (name, args, method) => {
    await withMockFetch(ok, async (calls) => {
      await runTool(name, args);
      expect(calls[0].method).toBe(method);
      expect(calls[0].body).not.toHaveProperty("metadata");
    });
  });
});

describe("slack_schedule_message postAt bounds", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const day = 24 * 60 * 60;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const schedule = (postAt: string | number) =>
    runTool("slack_schedule_message", { ...target, text: "ping", postAt });

  it("rejects a postAt in the past", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(nowSeconds - 60)).rejects.toThrow(
        "`postAt` is 60s in the past. Slack only schedules future messages.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a postAt equal to now", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(now.toISOString())).rejects.toThrow("0s in the past");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a postAt more than 120 days out", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule(nowSeconds + 120 * day + 1)).rejects.toThrow(
        "Slack schedules at most 120 days ahead.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects an unparseable postAt", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule("next tuesday")).rejects.toThrow(
        "Could not read `postAt` (next tuesday) as ISO-8601 or Unix seconds.",
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("treats an all-digit string as Unix seconds", async () => {
    const postAt = nowSeconds + day;
    await withMockFetch(
      () => ({ ok: true, scheduled_message_id: "Q0TEST" }),
      async (calls) => {
        await expect(schedule(String(postAt))).resolves.toMatchObject({
          postAt,
          postAtIso: "2026-09-24T12:00:00.000Z",
        });
        expect(calls[0].body.post_at).toBe(postAt);
      },
    );
  });

  it("rejects an ISO datetime without a timezone offset", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(schedule("2026-09-24T09:00:00")).rejects.toThrow(
        "`postAt` (2026-09-24T09:00:00) has no timezone, so it is ambiguous. Add `Z` or an offset like `-06:00`, or pass Unix seconds.",
      );
      await expect(schedule("2026-09-24")).rejects.toThrow("has no timezone");
      expect(calls).toHaveLength(0);
    });
  });

  it("accepts ISO datetimes with Z or a numeric offset", async () => {
    await withMockFetch(
      () => ({ ok: true, scheduled_message_id: "Q0TEST" }),
      async (calls) => {
        await schedule("2026-09-24T09:00:00Z");
        await schedule("2026-09-24T09:00:00.000-06:00");
        await schedule("2026-09-24T09:00:00+0530");
        expect(calls.map((call) => call.body.post_at)).toEqual([
          Date.parse("2026-09-24T09:00:00Z") / 1000,
          Date.parse("2026-09-24T15:00:00Z") / 1000,
          Date.parse("2026-09-24T03:30:00Z") / 1000,
        ]);
      },
    );
  });

  it("schedules exactly 120 days out", async () => {
    const postAt = nowSeconds + 120 * day;
    await withMockFetch(
      () => ({ ok: true, scheduled_message_id: "Q0TEST" }),
      async (calls) => {
        await expect(schedule(postAt)).resolves.toEqual({
          channelId: "C0TEST",
          scheduledMessageId: "Q0TEST",
          postAt,
          postAtIso: "2027-01-21T12:00:00.000Z",
        });
        expect(calls.map((call) => call.method)).toEqual(["chat.scheduleMessage"]);
        expect(calls[0].body.post_at).toBe(postAt);
      },
    );
  });

  it("returns the DM channel Slack resolved from a user ID, not the input", async () => {
    await withMockFetch(
      () => ({ ok: true, channel: "D0RESOLVED", scheduled_message_id: "Q0TEST" }),
      async (calls) => {
        const result = await runTool("slack_schedule_message", {
          channelId: "U0TEST",
          text: "ping",
          postAt: nowSeconds + day,
        });
        expect(calls[0].body.channel).toBe("U0TEST");
        expect(result).toMatchObject({ channelId: "D0RESOLVED", scheduledMessageId: "Q0TEST" });
      },
    );
  });
});

describe("slack_scheduled_list pagination", () => {
  const entry = (id: string) => ({ id, channel_id: "C0TEST", post_at: 1790000000, text: id });
  const pages: Record<string, Record<string, unknown>> = {
    "": {
      ok: true,
      scheduled_messages: [entry("Q1"), entry("Q2")],
      response_metadata: { next_cursor: "page2" },
    },
    page2: { ok: true, scheduled_messages: [entry("Q3")], response_metadata: { next_cursor: "" } },
  };
  const byCursor = (call: { body: Record<string, unknown> }) =>
    pages[String(call.body.cursor ?? "")];

  it("follows next_cursor across pages until exhausted", async () => {
    await withMockFetch(byCursor, async (calls) => {
      const result = await runTool("slack_scheduled_list", { channelId: "C0TEST" });
      expect(calls.map((call) => call.body)).toEqual([
        { channel: "C0TEST" },
        { channel: "C0TEST", cursor: "page2" },
      ]);
      expect(result).toEqual({
        scheduled: ["Q1", "Q2", "Q3"].map((id) => ({
          id,
          channelId: "C0TEST",
          postAt: 1790000000,
          postAtIso: "2026-09-21T14:13:20.000Z",
          text: id,
        })),
        hasMore: false,
      });
    });
  });

  it("forwards cursor and limit, and resumes from a caller's cursor", async () => {
    await withMockFetch(byCursor, async (calls) => {
      const result = await runTool("slack_scheduled_list", { cursor: "page2", limit: 50 });
      expect(calls.map((call) => call.body)).toEqual([{ cursor: "page2", limit: 50 }]);
      expect(result).toMatchObject({ scheduled: [{ id: "Q3" }], hasMore: false });
    });
  });

  it("returns a cursor with hasMore when the page cap is reached", async () => {
    let n = 0;
    await withMockFetch(
      () => ({
        ok: true,
        scheduled_messages: [entry(`Q${n}`)],
        response_metadata: { next_cursor: `c${++n}` },
      }),
      async (calls) => {
        const result = (await runTool("slack_scheduled_list", {})) as {
          scheduled: unknown[];
          cursor?: string;
          hasMore: boolean;
        };
        expect(calls).toHaveLength(10);
        expect(result.scheduled).toHaveLength(10);
        expect(result).toMatchObject({ cursor: "c10", hasMore: true });
      },
    );
  });
});

describe("Slack error hints", () => {
  it("names the needed scope on missing_scope", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope", needed: "bookmarks:read" }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: missing_scope (needs scope: bookmarks:read)",
        );
      },
    );
  });

  it("falls back to 'unknown' when missing_scope omits `needed`", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope" }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: missing_scope (needs scope: unknown)",
        );
      },
    );
  });

  it("explains not_allowed_token_type as a bot-vs-user mismatch", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "not_allowed_token_type" }),
      async (calls) => {
        await expect(runTool("slack_search", { query: "roadmap" })).rejects.toThrow(
          "Slack search.messages failed: not_allowed_token_type (this method requires the other token type — bot vs user)",
        );
        // search.* goes out form-encoded with the user token.
        expect(calls[0].headers.authorization).toBe("Bearer xoxp-test");
        expect(calls[0].headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
        expect(calls[0].body).toMatchObject({ query: "roadmap", count: "20" });
      },
    );
  });

  it("appends Block Kit detail messages for other errors", async () => {
    await withMockFetch(
      () => ({
        ok: false,
        error: "invalid_blocks",
        response_metadata: { messages: ["[ERROR] bad block at /blocks/0"] },
      }),
      async () => {
        await expect(
          runTool("slack_blocks_send", { ...target, text: "hi", blocks: [{ type: "nope" }] }),
        ).rejects.toThrow("Slack chat.postMessage failed: invalid_blocks — [ERROR] bad block at /blocks/0");
      },
    );
  });

  it("reports the HTTP status when Slack omits an error code", async () => {
    await withMockFetch(
      () => slackResponse({ ok: false }, { status: 503 }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: http_503",
        );
      },
    );
  });
});

describe("Slack HTTP client hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises a clear error for a non-JSON 500 instead of a raw SyntaxError", async () => {
    await withMockFetch(
      () =>
        new Response("<html><body>Internal Server Error</body></html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      async () => {
        const failure = runTool("slack_bookmark_list", target);
        await expect(failure).rejects.toThrow(
          "Slack bookmarks.list failed: http_500 (non-JSON response, content-type text/html)",
        );
        await expect(failure).rejects.not.toBeInstanceOf(SyntaxError);
      },
    );
  });

  const rateLimited = (retryAfter?: string) =>
    slackResponse(
      { ok: false, error: "ratelimited" },
      { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
    );

  it("retries an HTTP 429 after its Retry-After delay, then succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    await withMockFetch(
      () => (attempt++ === 0 ? rateLimited("2") : { ok: true, bookmarks: [] }),
      async (calls) => {
        const pending = runTool("slack_bookmark_list", target);
        await vi.advanceTimersByTimeAsync(1999);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ bookmarks: [] });
        expect(calls).toHaveLength(2);
      },
    );
  });

  it("retries a 200 `ratelimited` body the same way", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    await withMockFetch(
      () =>
        attempt++ === 0
          ? slackResponse({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "1" } })
          : { ok: true, bookmarks: [] },
      async (calls) => {
        const pending = runTool("slack_bookmark_list", target);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toEqual({ bookmarks: [] });
        expect(calls).toHaveLength(2);
      },
    );
  });

  it("gives up after 2 retries", async () => {
    vi.useFakeTimers();
    await withMockFetch(
      () => rateLimited("1"),
      async (calls) => {
        const pending = runTool("slack_bookmark_list", target);
        const settled = expect(pending).rejects.toThrow("Slack bookmarks.list failed: ratelimited");
        await vi.advanceTimersByTimeAsync(10_000);
        await settled;
        expect(calls).toHaveLength(3);
      },
    );
  });

  it("does not wait out a Retry-After longer than the cap", async () => {
    await withMockFetch(
      () => rateLimited("600"),
      async (calls) => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          "Slack bookmarks.list failed: ratelimited (Slack asked to wait 600s; try again later)",
        );
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("stops retrying when the call is aborted during backoff", async () => {
    vi.useFakeTimers();
    const { tools } = registerPlugin({ botToken: "xoxb-test" });
    const bookmarkList = tools.find((tool) => tool.name === "slack_bookmark_list")!;
    const controller = new AbortController();
    await withMockFetch(
      () => rateLimited("5"),
      async (calls) => {
        const pending = bookmarkList.execute("test-call", target, controller.signal);
        const settled = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        await settled;
        expect(calls).toHaveLength(1);
      },
    );
  });

  it.each([
    ["cant_update_message", "only messages posted by this app's bot token can be updated"],
    [
      "free_teams_cannot_create_standalone_canvases",
      "free workspaces cannot create standalone canvases",
    ],
    ["channel_canvas_already_exists", "this channel already has a canvas"],
    ["canvas_too_large", "the canvas exceeds Slack's size limit"],
    ["canvas_editing_locked", "the canvas is locked for editing"],
    ["invalid_primary_column", "a list's primary column must be a text column"],
    ["over_column_maximum", "the list has more columns than Slack allows"],
  ])("adds a one-line hint for %s", async (error, hint) => {
    await withMockFetch(
      () => ({ ok: false, error }),
      async () => {
        await expect(runTool("slack_bookmark_list", target)).rejects.toThrow(
          `Slack bookmarks.list failed: ${error} (${hint}`,
        );
      },
    );
  });

  it("logs method, elapsed time, and outcome without the token or response body", async () => {
    const logger = recordingLogger();
    await withMockFetch(
      (call) =>
        call.method === "bookmarks.list"
          ? { ok: true, bookmarks: [{ id: "Bk0SECRETBODY" }] }
          : { ok: false, error: "channel_not_found" },
      async () => {
        await runTool("slack_bookmark_list", target, TEST_CONFIG, logger);
        await expect(
          runTool("slack_bookmark_remove", { ...target, bookmarkId: "Bk1" }, TEST_CONFIG, logger),
        ).rejects.toThrow("channel_not_found");
      },
    );
    expect(logger.lines).toHaveLength(2);
    expect(logger.lines[0].message).toMatch(/^slack-workspace: bookmarks\.list ok in \d+ms$/);
    expect(logger.lines[1]).toMatchObject({ level: "warn" });
    expect(logger.lines[1].message).toMatch(
      /^slack-workspace: bookmarks\.remove error=channel_not_found in \d+ms$/,
    );
    const everything = logger.lines.map((line) => line.message).join("\n");
    expect(everything).not.toContain("xoxb-test");
    expect(everything).not.toContain("xoxp-test");
    expect(everything).not.toContain("Bk0SECRETBODY");
  });
});
