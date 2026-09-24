import { describe, expect, it } from "vitest";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const slack = () => ({ ok: true, sections: [{ id: "temp:C:abc" }] });

/** The `criteria` sent on the single `canvases.sections.lookup` call. */
const lookupCriteria = (calls: RecordedCall[]) => {
  const lookups = calls.filter((call) => call.method === "canvases.sections.lookup");
  expect(lookups).toHaveLength(1);
  expect(lookups[0]!.body.canvas_id).toBe("F0CANVAS");
  return lookups[0]!.body.criteria;
};

describe("slack_canvas_sections filters", () => {
  it("containsText alone maps to criteria.contains_text", async () => {
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_canvas_sections", {
        canvasId: "F0CANVAS",
        containsText: "Goals",
      });
      expect(lookupCriteria(calls)).toEqual({ contains_text: "Goals" });
      expect(result).toEqual({ sections: [{ id: "temp:C:abc" }] });
    });
  });

  it("sectionTypes alone maps to criteria.section_types", async () => {
    await withMockFetch(slack, async (calls) => {
      await runTool("slack_canvas_sections", {
        canvasId: "F0CANVAS",
        sectionTypes: ["h1", "h2"],
      });
      expect(lookupCriteria(calls)).toEqual({ section_types: ["h1", "h2"] });
    });
  });

  it("combines sectionTypes and containsText in one criteria object", async () => {
    await withMockFetch(slack, async (calls) => {
      await runTool("slack_canvas_sections", {
        canvasId: "F0CANVAS",
        sectionTypes: ["any_header"],
        containsText: "Goals",
      });
      expect(lookupCriteria(calls)).toEqual({
        section_types: ["any_header"],
        contains_text: "Goals",
      });
    });
  });

  it.each([{}, { sectionTypes: [] }, { containsText: "" }])(
    "fails before calling Slack when no filter is set (%o)",
    async (params) => {
      await withMockFetch(slack, async (calls) => {
        await expect(
          runTool("slack_canvas_sections", { canvasId: "F0CANVAS", ...params }),
        ).rejects.toThrow("needs sectionTypes or containsText");
        expect(calls).toHaveLength(0);
      });
    },
  );
});
