import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const metadata = getToolPluginMetadata(entry)!;
const outputSchema = (name: string) =>
  metadata.tools.find((tool) => tool.name === name)!.outputSchema!;

/** A Slack List item as `slackLists.items.list`/`.info` return it. */
const rawItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  list_id: "F0LIST",
  date_created: 1727000000,
  created_by: "U0AUTHOR",
  updated_by: "U0EDITOR",
  updated_timestamp: "1727000100",
  is_subscribed: false,
  fields: [
    {
      key: "task",
      column_id: "Col0TASK",
      value: `Item ${id}`,
      text: `Item ${id}`,
      rich_text: [{ type: "rich_text", elements: [] }],
    },
    { key: "owner", column_id: "Col0OWNER", value: "U0OWNER", user: ["U0OWNER"] },
  ],
  ...extra,
});

const curatedItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdBy: "U0AUTHOR",
  createdAt: 1727000000,
  updatedAt: "1727000100",
  fields: [
    { columnId: "Col0TASK", key: "task", text: `Item ${id}`, value: `Item ${id}` },
    { columnId: "Col0OWNER", key: "owner", value: "U0OWNER" },
  ],
  ...extra,
});

describe("slack_list_items_list", () => {
  const pages: Record<string, Record<string, unknown>> = {
    "": {
      ok: true,
      items: [rawItem("Rec01"), rawItem("Rec02")],
      response_metadata: { next_cursor: "page2" },
    },
    page2: { ok: true, items: [rawItem("Rec03")], response_metadata: { next_cursor: "" } },
  };
  const paged = (call: RecordedCall) => pages[String(call.body.cursor ?? "")]!;

  it("follows next_cursor across two pages and curates each item", async () => {
    await withMockFetch(paged, async (calls) => {
      const result = await runTool("slack_list_items_list", { listId: "F0LIST" });
      expect(calls.map((call) => call.method)).toEqual([
        "slackLists.items.list",
        "slackLists.items.list",
      ]);
      expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
      expect(calls.map((call) => call.body)).toEqual([
        { list_id: "F0LIST" },
        { list_id: "F0LIST", cursor: "page2" },
      ]);
      expect(result).toEqual({
        listId: "F0LIST",
        items: [curatedItem("Rec01"), curatedItem("Rec02"), curatedItem("Rec03")],
        hasMore: false,
      });
      expect(Value.Check(outputSchema("slack_list_items_list"), result)).toBe(true);
    });
  });

  it("forwards the archived filter, cursor, and limit", async () => {
    await withMockFetch(paged, async (calls) => {
      const result = await runTool("slack_list_items_list", {
        listId: "F0LIST",
        archived: true,
        cursor: "page2",
        limit: 50,
      });
      expect(calls.map((call) => call.body)).toEqual([
        { list_id: "F0LIST", archived: true, cursor: "page2", limit: 50 },
      ]);
      expect(result).toMatchObject({ items: [{ id: "Rec03" }], hasMore: false });
    });
  });

  it("returns the cursor when pages remain after the walk", async () => {
    await withMockFetch(
      (call) => ({
        ok: true,
        items: [rawItem(`Rec${String(call.body.cursor ?? "0")}`)],
        response_metadata: { next_cursor: `${Number(call.body.cursor ?? 0) + 1}` },
      }),
      async (calls) => {
        const result = (await runTool("slack_list_items_list", { listId: "F0LIST" })) as {
          items: unknown[];
          cursor?: string;
          hasMore: boolean;
        };
        expect(calls).toHaveLength(10);
        expect(result.items).toHaveLength(10);
        expect(result).toMatchObject({ cursor: "10", hasMore: true });
        expect(Value.Check(outputSchema("slack_list_items_list"), result)).toBe(true);
      },
    );
  });

  it("marks subtasks with their parent and drops empty fields", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        items: [
          {
            id: "Rec0SUB",
            parent_record_id: "Rec0PARENT",
            fields: [{ key: "task", column_id: "Col0TASK", value: "", text: "" }],
          },
        ],
      }),
      async () => {
        const result = await runTool("slack_list_items_list", { listId: "F0LIST" });
        expect(result).toEqual({
          listId: "F0LIST",
          items: [
            { id: "Rec0SUB", parentItemId: "Rec0PARENT", fields: [{ columnId: "Col0TASK", key: "task" }] },
          ],
          hasMore: false,
        });
        expect(Value.Check(outputSchema("slack_list_items_list"), result)).toBe(true);
      },
    );
  });
});

describe("slack_list_item_info", () => {
  it("returns one item with its subtasks", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        list: { id: "F0LIST", title: "Sprint Board" },
        record: rawItem("Rec0PARENT"),
        subtasks: [
          rawItem("Rec0SUB1", { parent_record_id: "Rec0PARENT" }),
          rawItem("Rec0SUB2", { parent_record_id: "Rec0PARENT" }),
        ],
      }),
      async (calls) => {
        const result = await runTool("slack_list_item_info", {
          listId: "F0LIST",
          itemId: "Rec0PARENT",
        });
        expect(calls.map((call) => call.method)).toEqual(["slackLists.items.info"]);
        expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0]!.body).toEqual({ list_id: "F0LIST", id: "Rec0PARENT" });
        expect(result).toEqual({
          listId: "F0LIST",
          item: curatedItem("Rec0PARENT"),
          subtasks: [
            curatedItem("Rec0SUB1", { parentItemId: "Rec0PARENT" }),
            curatedItem("Rec0SUB2", { parentItemId: "Rec0PARENT" }),
          ],
        });
        expect(Value.Check(outputSchema("slack_list_item_info"), result)).toBe(true);
      },
    );
  });

  it("returns an empty subtasks array when the item has none", async () => {
    await withMockFetch(
      () => ({ ok: true, record: rawItem("Rec0ONE") }),
      async () => {
        const result = await runTool("slack_list_item_info", { listId: "F0LIST", itemId: "Rec0ONE" });
        expect(result).toEqual({ listId: "F0LIST", item: curatedItem("Rec0ONE"), subtasks: [] });
      },
    );
  });
});
