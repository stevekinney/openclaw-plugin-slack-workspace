import { describe, expect, it } from "vitest";
import { runTool, withMockFetch } from "./test-utils.js";

describe("slack_canvas_delete", () => {
  it("deletes the canvas and reports it", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        const result = await runTool("slack_canvas_delete", { canvasId: "F0CANVAS" });
        expect(calls.map((call) => call.method)).toEqual(["canvases.delete"]);
        expect(calls[0]!.body).toEqual({ canvas_id: "F0CANVAS" });
        expect(result).toEqual({ deleted: true, canvasId: "F0CANVAS" });
      },
    );
  });

  it.each([
    ["canvas_not_found", "no canvas with this ID"],
    ["access_denied", "lacks permission on the canvas"],
  ])("surfaces %s with a hint", async (error, hint) => {
    await withMockFetch(
      () => ({ ok: false, error }),
      async () => {
        const failure = runTool("slack_canvas_delete", { canvasId: "F0MISSING" });
        await expect(failure).rejects.toThrow(`canvases.delete failed: ${error}`);
        await expect(failure).rejects.toThrow(hint);
      },
    );
  });
});
