import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const metadata = getToolPluginMetadata(entry)!;
const outputSchema = (name: string) =>
  metadata.tools.find((tool) => tool.name === name)!.outputSchema!;

/** One column of every writable type, plus one (attachment) this plugin can't write. */
const schema = [
  { id: "Col0TASK", key: "task", name: "Task", type: "text", is_primary_column: true },
  {
    id: "Col0STATUS",
    key: "status",
    name: "Status",
    type: "select",
    options: {
      format: "single_select",
      choices: [
        { value: "not_started", label: "Not Started", color: "red" },
        { value: "done", label: "Done", color: "green" },
      ],
    },
  },
  {
    id: "Col0TAGS",
    key: "tags",
    name: "Tags",
    type: "multi_select",
    options: {
      format: "multi_select",
      choices: [
        { value: "bug", label: "Bug", color: "red" },
        { value: "ui", label: "UI", color: "blue" },
      ],
    },
  },
  { id: "Col0OWNER", key: "owner", name: "Owner", type: "user" },
  { id: "Col0DUE", key: "due", name: "Due", type: "date" },
  { id: "Col0POINTS", key: "points", name: "Points", type: "number" },
  { id: "Col0STARS", key: "stars", name: "Stars", type: "rating" },
  { id: "Col0DONE", key: "done", name: "Done", type: "checkbox" },
  { id: "Col0EMAIL", key: "email", name: "Email", type: "email" },
  { id: "Col0PHONE", key: "phone", name: "Phone", type: "phone" },
  { id: "Col0CHANNEL", key: "channel", name: "Channel", type: "channel" },
  { id: "Col0FILES", key: "files", name: "Files", type: "attachment" },
];

/** Answer the schema read, then the item write under test. */
function slack(write: Record<string, unknown> = { ok: true }) {
  return (call: RecordedCall) =>
    call.method === "slackLists.items.list"
      ? { ok: true, items: [], list: { id: "F0LIST", list_metadata: { schema } } }
      : write;
}

const created = { ok: true, item: { id: "Rec0NEW", list_id: "F0LIST", fields: [] } };

/** Create an item with one field and return the `initial_fields` entry Slack received. */
async function writeShape(column: string, value: unknown) {
  return withMockFetch(slack(created), async (calls) => {
    await runTool("slack_list_item_create", { listId: "F0LIST", fields: { [column]: value } });
    expect(calls.map((call) => call.method)).toEqual([
      "slackLists.items.list",
      "slackLists.items.create",
    ]);
    return (calls[1]!.body.initial_fields as unknown[])[0];
  });
}

describe("column write shapes", () => {
  it("encodes text as a rich_text block", async () => {
    expect(await writeShape("Task", "Ship the launch post")).toEqual({
      column_id: "Col0TASK",
      rich_text: [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Ship the launch post" }] },
          ],
        },
      ],
    });
  });

  it("encodes select as an array of option IDs resolved from labels", async () => {
    expect(await writeShape("status", "not started")).toEqual({
      column_id: "Col0STATUS",
      select: ["not_started"],
    });
  });

  it("encodes multi_select as an array of option IDs", async () => {
    expect(await writeShape("Tags", ["Bug", "ui"])).toEqual({
      column_id: "Col0TAGS",
      select: ["bug", "ui"],
    });
  });

  it("encodes user as an array of user IDs", async () => {
    expect(await writeShape("Owner", "U0ALICE")).toEqual({
      column_id: "Col0OWNER",
      user: ["U0ALICE"],
    });
  });

  it("encodes date as an array of dates", async () => {
    expect(await writeShape("Due", "2026-10-01")).toEqual({
      column_id: "Col0DUE",
      date: ["2026-10-01"],
    });
  });

  it("encodes email as an array of addresses", async () => {
    expect(await writeShape("Email", ["a@example.com", "b@example.com"])).toEqual({
      column_id: "Col0EMAIL",
      email: ["a@example.com", "b@example.com"],
    });
  });

  it("encodes phone as an array of numbers", async () => {
    expect(await writeShape("Phone", "+15555550100")).toEqual({
      column_id: "Col0PHONE",
      phone: ["+15555550100"],
    });
  });

  it("encodes channel as an array of channel IDs", async () => {
    expect(await writeShape("Channel", ["C0GENERAL"])).toEqual({
      column_id: "Col0CHANNEL",
      channel: ["C0GENERAL"],
    });
  });

  it("encodes number as a bare number", async () => {
    expect(await writeShape("Points", 3)).toEqual({ column_id: "Col0POINTS", number: 3 });
  });

  it("encodes rating as a bare number", async () => {
    expect(await writeShape("Stars", "4")).toEqual({ column_id: "Col0STARS", rating: 4 });
  });

  it("encodes checkbox as a bare boolean", async () => {
    expect(await writeShape("Done", true)).toEqual({ column_id: "Col0DONE", checkbox: true });
  });
});

describe("column write validation", () => {
  it.each([
    ["Status", ["Done", "Not Started"], 'Column "Status" is single-select; pass one option.'],
    ["Status", "Blocked", 'No option "Blocked" in column "Status". Options: Not Started, Done.'],
    ["Due", "next week", 'Column "Due" needs dates as YYYY-MM-DD, got "next week".'],
    ["Points", "lots", 'Column "Points" needs a number, got "lots".'],
    ["Done", "yes", 'Column "Done" needs true or false.'],
    ["Task", ["a", "b"], 'Column "Task" needs a single text value.'],
    ["Files", "F0FILE", 'Column "Files" has type attachment, which this tool can\'t write.'],
    ["Priority", "high", 'No column "Priority" in this list.'],
  ])("rejects %s = %j before writing", async (column, value, message) => {
    await withMockFetch(slack(created), async (calls) => {
      await expect(
        runTool("slack_list_item_create", { listId: "F0LIST", fields: { [column]: value } }),
      ).rejects.toThrow(message);
      expect(calls.map((call) => call.method)).toEqual(["slackLists.items.list"]);
    });
  });
});

describe("slack_list_item_create", () => {
  it("creates an item from column names and returns its ID", async () => {
    await withMockFetch(slack(created), async (calls) => {
      const result = await runTool("slack_list_item_create", {
        listId: "F0LIST",
        fields: { Task: "Write docs", Status: "Done" },
      });
      expect(calls[1]!.headers.authorization).toBe("Bearer xoxb-test");
      expect(calls[1]!.body).toEqual({
        list_id: "F0LIST",
        initial_fields: [
          {
            column_id: "Col0TASK",
            rich_text: [
              {
                type: "rich_text",
                elements: [
                  { type: "rich_text_section", elements: [{ type: "text", text: "Write docs" }] },
                ],
              },
            ],
          },
          { column_id: "Col0STATUS", select: ["done"] },
        ],
      });
      expect(result).toEqual({ listId: "F0LIST", itemId: "Rec0NEW" });
      expect(Value.Check(outputSchema("slack_list_item_create"), result)).toBe(true);
    });
  });

  it("creates a subtask under parentItemId", async () => {
    await withMockFetch(slack(created), async (calls) => {
      const result = await runTool("slack_list_item_create", {
        listId: "F0LIST",
        parentItemId: "Rec0PARENT",
        fields: { Task: "Sub-step" },
      });
      expect(calls[1]!.body).toMatchObject({ list_id: "F0LIST", parent_item_id: "Rec0PARENT" });
      expect(result).toEqual({ listId: "F0LIST", itemId: "Rec0NEW", parentItemId: "Rec0PARENT" });
      expect(Value.Check(outputSchema("slack_list_item_create"), result)).toBe(true);
    });
  });

  it("skips the schema read when no fields are given", async () => {
    await withMockFetch(slack(created), async (calls) => {
      await runTool("slack_list_item_create", { listId: "F0LIST" });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.items.create"]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST" });
    });
  });
});

describe("slack_list_item_update", () => {
  it("resolves column names once and sends every cell in one batch", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_item_update", {
        listId: "F0LIST",
        cells: [
          { rowId: "Rec0A", column: "Status", value: "Done" },
          { rowId: "Rec0A", column: "done", value: true },
          { rowId: "Rec0B", column: "Col0POINTS", value: 5 },
        ],
      });
      expect(calls.map((call) => call.method)).toEqual([
        "slackLists.items.list",
        "slackLists.items.update",
      ]);
      expect(calls[1]!.body).toEqual({
        list_id: "F0LIST",
        cells: [
          { row_id: "Rec0A", column_id: "Col0STATUS", select: ["done"] },
          { row_id: "Rec0A", column_id: "Col0DONE", checkbox: true },
          { row_id: "Rec0B", column_id: "Col0POINTS", number: 5 },
        ],
      });
      expect(result).toEqual({ listId: "F0LIST", updated: 3 });
      expect(Value.Check(outputSchema("slack_list_item_update"), result)).toBe(true);
    });
  });
});

describe("slack_list_item_delete", () => {
  it("deletes one item", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_item_delete", { listId: "F0LIST", itemId: "Rec0A" });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.items.delete"]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", id: "Rec0A" });
      expect(result).toEqual({ listId: "F0LIST", itemId: "Rec0A", deleted: true });
      expect(Value.Check(outputSchema("slack_list_item_delete"), result)).toBe(true);
    });
  });
});

describe("slack_list_items_delete_multiple", () => {
  it("deletes several items in one call", async () => {
    await withMockFetch(slack(), async (calls) => {
      const result = await runTool("slack_list_items_delete_multiple", {
        listId: "F0LIST",
        itemIds: ["Rec0A", "Rec0B"],
      });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.items.deleteMultiple"]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", ids: ["Rec0A", "Rec0B"] });
      expect(result).toEqual({ listId: "F0LIST", itemIds: ["Rec0A", "Rec0B"], deleted: 2 });
      expect(Value.Check(outputSchema("slack_list_items_delete_multiple"), result)).toBe(true);
    });
  });
});
