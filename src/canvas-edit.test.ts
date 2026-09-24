import { describe, expect, it } from "vitest";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const slack = (call: RecordedCall) =>
  call.method === "auth.test"
    ? { ok: true, url: "https://example-workspace.slack.com/", team_id: "T0TEST", user_id: "U0BOT" }
    : { ok: true };

/** The `changes` array sent on the single `canvases.edit` call. */
const editChanges = (calls: RecordedCall[]) => {
  const edits = calls.filter((call) => call.method === "canvases.edit");
  expect(edits).toHaveLength(1);
  expect(edits[0]!.body.canvas_id).toBe("F0CANVAS");
  return edits[0]!.body.changes;
};

describe("slack_canvas_edit section operations", () => {
  it.each(["insert_after", "insert_before"])(
    "%s sends the section id and markdown as one change",
    async (operation) => {
      await withMockFetch(slack, async (calls) => {
        const result = await runTool("slack_canvas_edit", {
          canvasId: "F0CANVAS",
          operation,
          sectionId: "temp:C:abc",
          markdown: "## Inserted",
        });
        expect(editChanges(calls)).toEqual([
          {
            operation,
            section_id: "temp:C:abc",
            document_content: { type: "markdown", markdown: "## Inserted" },
          },
        ]);
        expect(result).toMatchObject({ canvasId: "F0CANVAS", operation });
      });
    },
  );

  it("delete sends only the section id", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_canvas_edit", {
        canvasId: "F0CANVAS",
        operation: "delete",
        sectionId: "temp:C:abc",
      });
      expect(editChanges(calls)).toEqual([{ operation: "delete", section_id: "temp:C:abc" }]);
      expect(result).toMatchObject({ canvasId: "F0CANVAS", operation: "delete" });
    });
  });

  it.each([
    ["insert_after", { markdown: "m" }],
    ["insert_before", { markdown: "m" }],
    ["delete", {}],
  ])("%s without sectionId fails before calling Slack", async (operation, extra) => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_canvas_edit", { canvasId: "F0CANVAS", operation, ...extra }),
      ).rejects.toThrow(`${operation} requires sectionId`);
      expect(calls).toHaveLength(0);
    });
  });

  it.each(["insert_after", "insert_before"])(
    "%s without markdown fails before calling Slack",
    async (operation) => {
      await withMockFetch(slack, async (calls) => {
        await expect(
          runTool("slack_canvas_edit", { canvasId: "F0CANVAS", operation, sectionId: "temp:C:abc" }),
        ).rejects.toThrow(`${operation} requires markdown`);
        expect(calls).toHaveLength(0);
      });
    },
  );
});
