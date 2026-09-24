import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";
import { extractActionItems, richTextCell } from "./tools/lists.js";
import type { ThreadMessage } from "./tools/canvases.js";

const THREAD_TS = "1726000000.000100";

const THREAD = [
  { ts: THREAD_TS, user: "U0ALICE", text: "Launch sync. Action items:\n- <@U0BOB> to write the docs\n• Book the room\nThanks all" },
  { ts: "1726000060.000200", user: "U0BOB", text: "TODO: update <https://example.com/pr/1|the PR> &amp; rerun CI" },
  { ts: "1726000120.000300", user: "U0CAROL", text: "- [ ] Email <@U0ALICE|alice> the deck\n- [x] Already done\nnot an item" },
  { ts: "1726000180.000400", user: "U0DAN", text: "Sounds good, I'll check the action items later." },
];

const TODO_SCHEMA = [
  { id: "Col0TASK", key: "task", name: "Task", type: "text", is_primary_column: true },
  { id: "Col0DONE", key: "todo_completed", name: "Completed", type: "todo_completed" },
  { id: "Col0WHO", key: "todo_assignee", name: "Assignee", type: "todo_assignee" },
  { id: "Col0DUE", key: "todo_due_date", name: "Due date", type: "todo_due_date" },
];

type Handler = (call: RecordedCall) => Record<string, unknown>;

const slack =
  (overrides: Record<string, Handler> = {}): Handler =>
  (call) => {
    const override = overrides[call.method];
    if (override) return override(call);
    switch (call.method) {
      case "conversations.replies":
        return { ok: true, messages: THREAD, has_more: false };
      case "slackLists.create":
        return { ok: true, list_id: "F0LIST", list_metadata: { schema: TODO_SCHEMA } };
      case "slackLists.items.list":
        return { ok: true, items: [], list: { title: "Launch", list_metadata: { schema: TODO_SCHEMA } } };
      case "slackLists.items.create":
        return { ok: true, item: { id: `Rec${(call.body.initial_fields as unknown[]).length}` } };
      default:
        return { ok: true };
    }
  };

const outputSchema = () =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === "slack_list_from_thread")
    ?.outputSchema;

const message = (text: string): ThreadMessage => ({ ts: THREAD_TS, author: { userId: "U0ALICE" }, text });

/** The plain text of a rich_text cell's elements, with mentions rendered as `@U…`. */
const cellText = (fields: Record<string, unknown>[]) => {
  const cell = fields.find((field) => field.column_id === "Col0TASK") as {
    rich_text: { elements: { elements: Record<string, string>[] }[] }[];
  };
  return cell.rich_text[0]!.elements[0]!.elements
    .map((element) => element.text ?? `@${element.user_id}`)
    .join("");
};

describe("extractActionItems", () => {
  it("finds checklist, TODO-prefixed, and action-item-block lines, with mentions as assignees", () => {
    const items = extractActionItems(
      THREAD.map((raw) => ({ ts: raw.ts, author: { userId: raw.user }, text: raw.text })),
    );
    expect(items).toEqual([
      { task: "<@U0BOB> to write the docs", assignee: "U0BOB" },
      { task: "Book the room" },
      { task: "update <https://example.com/pr/1|the PR> &amp; rerun CI" },
      { task: "Email <@U0ALICE|alice> the deck", assignee: "U0ALICE" },
    ]);
  });

  it("recognizes numbered lists under a Next steps heading and drops duplicates", () => {
    const items = extractActionItems([
      message("*Next steps:*\n1. Ship it\n2) Tell support\n\n3. Write the recap"),
      message("Action item: ship it"),
    ]);
    expect(items).toEqual([{ task: "Ship it" }, { task: "Tell support" }, { task: "Write the recap" }]);
  });

  it("returns nothing for a thread with no action items", () => {
    expect(extractActionItems([message("Just chatting about action items in general.")])).toEqual([]);
  });
});

describe("richTextCell", () => {
  it("turns Slack mrkdwn into rich_text with user, channel, and link elements", () => {
    expect(richTextCell("Col0TASK", "Ask <@U0BOB> in <#C0OPS|ops> about <https://x.test|this> &amp; <!here>")).toEqual({
      column_id: "Col0TASK",
      rich_text: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Ask " },
                { type: "user", user_id: "U0BOB" },
                { type: "text", text: " in " },
                { type: "channel", channel_id: "C0OPS" },
                { type: "text", text: " about " },
                { type: "link", url: "https://x.test", text: "this" },
                { type: "text", text: " & " },
                { type: "text", text: "@here" },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("slack_list_from_thread", () => {
  it("creates a todo_mode list, adds one row per action item, and shares it with the channel", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        name: "Launch follow-ups",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.replies",
        "slackLists.create",
        "slackLists.items.create",
        "slackLists.items.create",
        "slackLists.items.create",
        "slackLists.items.create",
        "slackLists.access.set",
      ]);
      expect(calls[1]!.body).toEqual({
        name: "Launch follow-ups",
        todo_mode: true,
        schema: [{ key: "task", name: "Task", type: "text", is_primary_column: true }],
      });
      const creates = calls.filter((call) => call.method === "slackLists.items.create");
      const fields = creates.map((call) => call.body.initial_fields as Record<string, unknown>[]);
      expect(creates.every((call) => call.body.list_id === "F0LIST")).toBe(true);
      expect(fields.map(cellText)).toEqual([
        "@U0BOB to write the docs",
        "Book the room",
        "update the PR & rerun CI",
        "Email @U0ALICE the deck",
      ]);
      expect(fields[0]).toContainEqual({ column_id: "Col0WHO", user: ["U0BOB"] });
      expect(fields[1]).toHaveLength(1);
      expect(calls.at(-1)!.body).toEqual({ list_id: "F0LIST", channel_ids: ["C0TEAM"], access_level: "write" });
      expect(result).toEqual({
        listId: "F0LIST",
        created: true,
        itemsCreated: 4,
        itemIds: ["Rec2", "Rec1", "Rec1", "Rec2"],
        messageCount: 4,
        truncated: false,
        sharedWith: ["C0TEAM"],
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("names a new list after the thread's date by default", async () => {
    await withMockFetch(slack(), async (calls) => {
      await runTool("slack_list_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS });
      expect(calls[1]!.body.name).toBe("Action items · 2024-09-10");
    });
  });

  it("appends rows to an existing list on a second call, resolving its columns first", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        listId: "F0EXISTING",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.replies",
        "slackLists.items.list",
        "slackLists.items.create",
        "slackLists.items.create",
        "slackLists.items.create",
        "slackLists.items.create",
      ]);
      expect(calls[1]!.body).toMatchObject({ list_id: "F0EXISTING", include_list: true });
      expect(
        calls.slice(2).every((call) => call.body.list_id === "F0EXISTING"),
      ).toBe(true);
      expect(result).toMatchObject({
        listId: "F0EXISTING",
        created: false,
        itemsCreated: 4,
        sharedWith: null,
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("writes caller-supplied items, with assignees and due dates, instead of extracting", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        listId: "F0EXISTING",
        items: [{ task: "Ship it", assignee: "U0DAN", dueDate: "2024-09-20" }],
      });
      const create = calls.find((call) => call.method === "slackLists.items.create")!;
      expect(create.body.initial_fields).toEqual([
        richTextCell("Col0TASK", "Ship it"),
        { column_id: "Col0WHO", user: ["U0DAN"] },
        { column_id: "Col0DUE", date: ["2024-09-20"] },
      ]);
      expect(result).toMatchObject({ itemsCreated: 1 });
    });
  });

  it("puts the task in the first text column when an existing list has no todo columns", async () => {
    const plain = slack({
      "slackLists.items.list": () => ({
        ok: true,
        items: [],
        list: {
          list_metadata: {
            schema: [
              { id: "Col0NUM", key: "n", name: "N", type: "number" },
              { id: "Col0NAME", key: "name", name: "Name", type: "text" },
            ],
          },
        },
      }),
    });
    await withMockFetch(plain, async (calls) => {
      await runTool("slack_list_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        listId: "F0PLAIN",
        items: [{ task: "Ship it", assignee: "U0DAN" }],
      });
      const create = calls.find((call) => call.method === "slackLists.items.create")!;
      expect(create.body.initial_fields).toEqual([richTextCell("Col0NAME", "Ship it")]);
    });
  });

  it("reports a failed row without losing the list, and still shares it", async () => {
    let count = 0;
    const flaky = slack({
      "slackLists.items.create": () =>
        ++count === 2 ? { ok: false, error: "invalid_arguments" } : { ok: true, item: { id: `Rec${count}` } },
    });
    await withMockFetch(flaky, async (calls) => {
      const result = await runTool("slack_list_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS });
      expect(calls.filter((call) => call.method === "slackLists.items.create")).toHaveLength(2);
      expect(calls.at(-1)!.method).toBe("slackLists.access.set");
      expect(result).toMatchObject({
        listId: "F0LIST",
        created: true,
        itemsCreated: 1,
        itemIds: ["Rec1"],
        itemError: "Slack slackLists.items.create failed: invalid_arguments",
        sharedWith: ["C0TEAM"],
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("reports a share failure without losing the list", async () => {
    const failShare = slack({ "slackLists.access.set": () => ({ ok: false, error: "channel_not_found" }) });
    await withMockFetch(failShare, async () => {
      const result = await runTool("slack_list_from_thread", {
        channelId: "C0TEAM",
        threadTs: THREAD_TS,
        userIds: ["U0ALICE"],
        accessLevel: "owner",
      });
      expect(result).toMatchObject({
        listId: "F0LIST",
        itemsCreated: 4,
        sharedWith: null,
        shareError: "Slack slackLists.access.set failed: channel_not_found",
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it.each([
    [{ channelIds: ["C0ONE"], userIds: ["U0ONE"] }, "either channelIds or userIds, not both"],
    [{ accessLevel: "owner" }, "owner access can only be granted to users"],
    [{ items: [{ task: "x", dueDate: "next week" }] }, "YYYY-MM-DD"],
  ])("rejects %o before calling Slack", async (params, text) => {
    await withMockFetch(slack(), async (calls) => {
      await expect(
        runTool("slack_list_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS, ...params }),
      ).rejects.toThrow(text);
      expect(calls).toEqual([]);
    });
  });

  it("creates no list when the thread has no action items", async () => {
    const chatty = slack({
      "conversations.replies": () => ({ ok: true, messages: [{ ts: THREAD_TS, user: "U0A", text: "hi" }] }),
    });
    await withMockFetch(chatty, async (calls) => {
      await expect(
        runTool("slack_list_from_thread", { channelId: "C0TEAM", threadTs: THREAD_TS }),
      ).rejects.toThrow("No action items found");
      expect(calls.map((call) => call.method)).toEqual(["conversations.replies"]);
    });
  });
});
