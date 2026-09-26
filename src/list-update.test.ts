import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const outputSchema = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.outputSchema!;

const ok = () => ({ ok: true });

describe("slack_list_update", () => {
  it("renames a list", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_update", { listId: "F0LIST", name: "Sprint Board" });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.update"]);
      expect(calls[0]!.body).toEqual({ id: "F0LIST", name: "Sprint Board" });
      expect(result).toEqual({ listId: "F0LIST", updated: ["name"] });
      expect(Value.Check(outputSchema("slack_list_update"), result)).toBe(true);
    });
  });

  it("sends the description as a rich_text block", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_update", {
        listId: "F0LIST",
        description: "Owned by <@U0OWNER>",
      });
      expect(calls[0]!.body).toEqual({
        id: "F0LIST",
        description_blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Owned by " },
                  { type: "user", user_id: "U0OWNER" },
                ],
              },
            ],
          },
        ],
      });
      expect(result).toEqual({ listId: "F0LIST", updated: ["description"] });
    });
  });

  it.each([true, false])("sets todo_mode to %s", async (todoMode) => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_update", { listId: "F0LIST", todoMode });
      expect(calls[0]!.body).toEqual({ id: "F0LIST", todo_mode: todoMode });
      expect(result).toEqual({ listId: "F0LIST", updated: ["todoMode"] });
    });
  });

  it("changes several fields in one call", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_update", {
        listId: "F0LIST",
        name: "Q3",
        description: "Quarter plan",
        todoMode: true,
      });
      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]!.body).sort()).toEqual(["description_blocks", "id", "name", "todo_mode"]);
      expect(result).toEqual({ listId: "F0LIST", updated: ["name", "description", "todoMode"] });
    });
  });

  it("refuses a call that changes nothing before calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(runTool("slack_list_update", { listId: "F0LIST" })).rejects.toThrow(
        "name, description, or todoMode",
      );
      expect(calls).toEqual([]);
    });
  });

  it("surfaces list_not_found", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "list_not_found" }),
      async () => {
        await expect(runTool("slack_list_update", { listId: "F0GONE", name: "x" })).rejects.toThrow(
          "slackLists.update failed: list_not_found",
        );
      },
    );
  });
});
