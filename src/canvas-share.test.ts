import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { resetWorkspaceCache } from "./client.js";
import { registerPlugin, runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const ORIGIN = "https://example-workspace.slack.com";
const TEAM_ID = "T0TEST";

/** `canvases.create` succeeds; `canvases.access.set` fails. */
const shareFails = (call: RecordedCall) => {
  switch (call.method) {
    case "auth.test":
      return { ok: true, url: `${ORIGIN}/`, team_id: TEAM_ID };
    case "canvases.create":
      return { ok: true, canvas_id: "F0CANVAS" };
    case "canvases.access.set":
      return { ok: false, error: "channel_not_found" };
    default:
      return { ok: true };
  }
};

const createOutputSchema = getToolPluginMetadata(entry)?.tools.find(
  (tool) => tool.name === "slack_canvas_create",
)?.outputSchema;

beforeEach(() => resetWorkspaceCache());

describe("slack_canvas_create partial share failure", () => {
  it("returns the created canvas with shareError instead of throwing when sharing fails", async () => {
    await withMockFetch(shareFails, async (calls) => {
      const result = await runTool("slack_canvas_create", {
        title: "t",
        markdown: "m",
        channelIds: ["C0TEST"],
      });
      expect(result).toEqual({
        canvasId: "F0CANVAS",
        url: `${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`,
        sharedWith: null,
        shareError: expect.stringContaining("channel_not_found"),
      });
      expect(calls.map((call) => call.method)).toContain("canvases.access.set");
      expect(Value.Check(createOutputSchema!, result)).toBe(true);
    });
  });

  it("omits shareError when sharing succeeds", async () => {
    await withMockFetch(
      (call) =>
        call.method === "canvases.access.set" ? { ok: true } : shareFails(call),
      async () => {
        const result = await runTool("slack_canvas_create", {
          title: "t",
          markdown: "m",
          channelIds: ["C0TEST"],
        });
        expect(result).toEqual({
          canvasId: "F0CANVAS",
          url: `${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`,
          sharedWith: ["C0TEST"],
        });
        expect(Value.Check(createOutputSchema!, result)).toBe(true);
      },
    );
  });

  it("rethrows instead of reporting shareError when cancelled during sharing", async () => {
    const controller = new AbortController();
    const tool = registerPlugin().tools.find((tool) => tool.name === "slack_canvas_create")!;
    await withMockFetch(
      (call) => {
        if (call.method === "canvases.access.set") controller.abort(new Error("cancelled"));
        return shareFails(call);
      },
      async (calls) => {
        await expect(
          tool.execute("test-call", { title: "t", markdown: "m", channelIds: ["C0TEST"] }, controller.signal),
        ).rejects.toThrow("cancelled");
        expect(calls.map((call) => call.method)).not.toContain("auth.test");
      },
    );
  });

  it("still throws when canvases.create itself fails", async () => {
    await withMockFetch(
      (call) =>
        call.method === "canvases.create" ? { ok: false, error: "invalid_auth" } : shareFails(call),
      async (calls) => {
        await expect(
          runTool("slack_canvas_create", { title: "t", markdown: "m", channelIds: ["C0TEST"] }),
        ).rejects.toThrow("invalid_auth");
        expect(calls.map((call) => call.method)).not.toContain("canvases.access.set");
      },
    );
  });
});
