import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { findListColumn, findListOption, type ListColumn } from "./tools/lists.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tool = getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === "slack_list_schema")!;

/** `slackLists.items.list` with `include_list=true` nests the schema under `list.list_metadata`. */
const itemsWithList = {
  ok: true,
  items: [{ id: "Rec0ONE", list_id: "F0LIST", fields: [] }],
  list: {
    id: "F0LIST",
    title: "Sprint Board",
    list_metadata: {
      schema: [
        { id: "Col0TASK", key: "task", name: "Task", type: "text", is_primary_column: true },
        {
          id: "Col0STATUS",
          key: "status",
          name: "Status",
          type: "select",
          is_primary_column: false,
          options: {
            format: "single_select",
            choices: [
              { value: "not_started", label: "Not Started", color: "red" },
              { value: "done", label: "Done", color: "green" },
            ],
          },
        },
        {
          id: "Col0OWNER",
          key: "owner",
          name: "Owner",
          type: "user",
          is_primary_column: false,
          options: { format: "multi_entity", show_member_name: true },
        },
      ],
    },
  },
  response_metadata: { next_cursor: "" },
};

const columns: ListColumn[] = [
  { id: "Col0TASK", key: "task", name: "Task", type: "text", primary: true },
  {
    id: "Col0STATUS",
    key: "status",
    name: "Status",
    type: "select",
    options: [
      { id: "not_started", label: "Not Started" },
      { id: "done", label: "Done" },
    ],
  },
  { id: "Col0OWNER", key: "owner", name: "Owner", type: "user" },
];

describe("slack_list_schema", () => {
  it("reads the schema via slackLists.items.list and curates text, select, and user columns", async () => {
    await withMockFetch(
      () => itemsWithList,
      async (calls) => {
        const result = await runTool("slack_list_schema", { listId: "F0LIST" });
        expect(calls.map((call) => call.method)).toEqual(["slackLists.items.list"]);
        expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0]!.body).toEqual({ list_id: "F0LIST", include_list: true, limit: 1 });
        expect(result).toEqual({ listId: "F0LIST", title: "Sprint Board", columns });
        expect(Value.Check(tool.outputSchema!, result)).toBe(true);
      },
    );
  });

  it("returns multi_select choices as options too", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        items: [],
        list: {
          id: "F0LIST",
          list_metadata: {
            schema: [
              {
                id: "Col0TAGS",
                key: "tags",
                name: "Tags",
                type: "multi_select",
                options: { choices: [{ value: "bug", label: "Bug", color: "red" }] },
              },
            ],
          },
        },
      }),
      async () => {
        const result = await runTool("slack_list_schema", { listId: "F0LIST" });
        expect(result).toEqual({
          listId: "F0LIST",
          columns: [
            {
              id: "Col0TAGS",
              key: "tags",
              name: "Tags",
              type: "multi_select",
              options: [{ id: "bug", label: "Bug" }],
            },
          ],
        });
        expect(Value.Check(tool.outputSchema!, result)).toBe(true);
      },
    );
  });

  it("fails clearly when Slack returns no list schema", async () => {
    await withMockFetch(
      () => ({ ok: true, items: [] }),
      async () => {
        await expect(runTool("slack_list_schema", { listId: "F0LIST" })).rejects.toThrow(
          "Slack returned no schema for list F0LIST.",
        );
      },
    );
  });
});

describe("findListColumn", () => {
  it("matches a column by ID, key, or case-insensitive name", () => {
    expect(findListColumn(columns, "Col0STATUS").id).toBe("Col0STATUS");
    expect(findListColumn(columns, "owner").id).toBe("Col0OWNER");
    expect(findListColumn(columns, "  status ").id).toBe("Col0STATUS");
  });

  it("names the available columns when nothing matches", () => {
    expect(() => findListColumn(columns, "Priority")).toThrow(
      'No column "Priority" in this list. Columns: Task, Status, Owner.',
    );
  });
});

describe("findListOption", () => {
  const status = columns[1]!;

  it("matches an option by ID or case-insensitive label", () => {
    expect(findListOption(status, "done")).toBe("done");
    expect(findListOption(status, "not started")).toBe("not_started");
  });

  it("names the available options when nothing matches", () => {
    expect(() => findListOption(status, "Blocked")).toThrow(
      'No option "Blocked" in column "Status". Options: Not Started, Done.',
    );
  });

  it("refuses a column that has no options", () => {
    expect(() => findListOption(columns[0]!, "x")).toThrow('Column "Task" is not a select column.');
  });
});
