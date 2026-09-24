import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const tool = getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === "slack_list_create")!;

/** Slack's `list_metadata.schema` echoes each column with its assigned ID. */
const createdList = {
  ok: true,
  list_id: "F0LIST",
  list_metadata: {
    schema: [
      { id: "Col0TASK", key: "task", name: "Task", type: "text", is_primary_column: true },
      {
        id: "Col0STATUS",
        key: "status",
        name: "Status",
        type: "select",
        options: { format: "single_select", choices: [{ value: "todo", label: "To do", color: "red" }] },
      },
      { id: "Col0OWNER", key: "owner", name: "Owner", type: "user" },
    ],
    subtask_schema: [],
  },
};

describe("slack_list_create", () => {
  it("creates a list with a typed column schema and returns its ID and columns", async () => {
    await withMockFetch(
      () => createdList,
      async (calls) => {
        const result = await runTool("slack_list_create", {
          name: "Launch tasks",
          todoMode: true,
          schema: [
            { key: "task", name: "Task", type: "text", primary: true },
            {
              key: "status",
              name: "Status",
              type: "select",
              options: { format: "single_select", choices: [{ value: "todo", label: "To do", color: "red" }] },
            },
            { key: "owner", name: "Owner", type: "user" },
          ],
        });
        expect(calls.map((call) => call.method)).toEqual(["slackLists.create"]);
        expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0]!.body).toEqual({
          name: "Launch tasks",
          todo_mode: true,
          schema: [
            { key: "task", name: "Task", type: "text", is_primary_column: true },
            {
              key: "status",
              name: "Status",
              type: "select",
              options: { format: "single_select", choices: [{ value: "todo", label: "To do", color: "red" }] },
            },
            { key: "owner", name: "Owner", type: "user" },
          ],
        });
        expect(result).toEqual({
          listId: "F0LIST",
          columns: [
            { id: "Col0TASK", key: "task", name: "Task", type: "text", primary: true },
            { id: "Col0STATUS", key: "status", name: "Status", type: "select" },
            { id: "Col0OWNER", key: "owner", name: "Owner", type: "user" },
          ],
        });
        expect(Value.Check(tool.outputSchema!, result)).toBe(true);
      },
    );
  });

  it("copies an existing list as a template, including its records", async () => {
    await withMockFetch(
      () => createdList,
      async (calls) => {
        const result = await runTool("slack_list_create", {
          name: "Sprint 12",
          copyFromListId: "F0TEMPLATE",
          includeCopiedListRecords: true,
        });
        expect(calls[0]!.method).toBe("slackLists.create");
        expect(calls[0]!.body).toEqual({
          name: "Sprint 12",
          copy_from_list_id: "F0TEMPLATE",
          include_copied_list_records: true,
        });
        expect(result).toMatchObject({ listId: "F0LIST" });
      },
    );
  });

  it("returns no columns when Slack omits list_metadata", async () => {
    await withMockFetch(
      () => ({ ok: true, list_id: "F0LIST" }),
      async () => {
        const result = await runTool("slack_list_create", { name: "Bare" });
        expect(result).toEqual({ listId: "F0LIST", columns: [] });
        expect(Value.Check(tool.outputSchema!, result)).toBe(true);
      },
    );
  });

  it.each([
    [
      "schema with copyFromListId",
      { schema: [{ key: "task", name: "Task", type: "text" }], copyFromListId: "F0TEMPLATE" },
      "Set schema or copyFromListId, not both.",
    ],
    [
      "includeCopiedListRecords without copyFromListId",
      { includeCopiedListRecords: true },
      "includeCopiedListRecords needs copyFromListId.",
    ],
  ])("refuses %s before calling Slack", async (_label, params, message) => {
    await withMockFetch(
      () => createdList,
      async (calls) => {
        await expect(runTool("slack_list_create", { name: "Bad", ...params })).rejects.toThrow(message);
        expect(calls).toHaveLength(0);
      },
    );
  });

  it("rejects an unknown column type at the schema", () => {
    expect(
      Value.Check(tool.parameters, { name: "L", schema: [{ key: "k", name: "K", type: "spreadsheet" }] }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, { name: "L", schema: [{ key: "k", name: "K", type: "text" }] }),
    ).toBe(true);
  });

  it("surfaces invalid_primary_column with a hint", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "invalid_primary_column" }),
      async () => {
        await expect(
          runTool("slack_list_create", {
            name: "L",
            schema: [{ key: "n", name: "N", type: "number", primary: true }],
          }),
        ).rejects.toThrow("a list's primary column must be a text column");
      },
    );
  });
});
