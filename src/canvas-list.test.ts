import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const outputSchema = () =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === "slack_canvas_list")!.outputSchema!;

/** A canvas as `files.list?types=canvas` returns it: a file object with filetype quip. */
const rawCanvas = (overrides: Record<string, unknown> = {}) => ({
  id: "F0CANVAS",
  created: 1726000000,
  timestamp: 1726000000,
  updated: 1726003600,
  name: "Roadmap",
  title: "Roadmap",
  mimetype: "application/vnd.slack-docs",
  filetype: "quip",
  pretty_type: "Canvas",
  user: "U0OWNER",
  editable: true,
  size: 1024,
  mode: "quip",
  is_external: false,
  is_public: true,
  url_private: "https://files.slack.com/files-pri/T0TEAM-F0CANVAS/roadmap",
  permalink: "https://lostgradient.slack.com/docs/T0TEAM/F0CANVAS",
  channels: ["C0PUBLIC"],
  groups: ["G0PRIVATE"],
  ims: [],
  comments_count: 0,
  ...overrides,
});

describe("slack_canvas_list", () => {
  it("lists canvases via files.list filtered to the canvas type", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        files: [rawCanvas(), rawCanvas({ id: "F0BARE", title: "", name: "Untitled", updated: undefined, permalink: undefined, channels: [], groups: [] })],
        paging: { count: 100, total: 2, page: 1, pages: 1 },
      }),
      async (calls) => {
        const result = await runTool("slack_canvas_list", {});
        expect(calls.map((call) => call.method)).toEqual(["files.list"]);
        expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0]!.body).toEqual({ types: "canvas" });
        expect(result).toEqual({
          canvases: [
            {
              canvasId: "F0CANVAS",
              title: "Roadmap",
              createdBy: "U0OWNER",
              created: 1726000000,
              updated: 1726003600,
              url: "https://lostgradient.slack.com/docs/T0TEAM/F0CANVAS",
              channelIds: ["C0PUBLIC", "G0PRIVATE"],
            },
            {
              canvasId: "F0BARE",
              title: "Untitled",
              createdBy: "U0OWNER",
              created: 1726000000,
              url: null,
              channelIds: [],
            },
          ],
          page: 1,
          pages: 1,
          total: 2,
          hasMore: false,
        });
        expect(Value.Check(outputSchema(), result)).toBe(true);
      },
    );
  });

  it("passes channel, user, and paging filters through", async () => {
    await withMockFetch(
      () => ({ ok: true, files: [rawCanvas()], paging: { count: 1, total: 3, page: 2, pages: 3 } }),
      async (calls) => {
        const result = await runTool("slack_canvas_list", {
          channelId: "C0PUBLIC",
          userId: "U0OWNER",
          page: 2,
          count: 1,
        });
        expect(calls[0]!.body).toEqual({
          types: "canvas",
          channel: "C0PUBLIC",
          user: "U0OWNER",
          page: "2",
          count: "1",
        });
        expect(result).toMatchObject({ page: 2, pages: 3, total: 3, hasMore: true });
      },
    );
  });

  it("treats a response without paging as a single page", async () => {
    await withMockFetch(
      () => ({ ok: true, files: [] }),
      async () => {
        const result = await runTool("slack_canvas_list", {});
        expect(result).toEqual({ canvases: [], page: 1, pages: 1, total: 0, hasMore: false });
        expect(Value.Check(outputSchema(), result)).toBe(true);
      },
    );
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope", needed: "files:read" }),
      async () => {
        await expect(runTool("slack_canvas_list", {})).rejects.toThrow(
          "files.list failed: missing_scope (needs scope: files:read)",
        );
      },
    );
  });
});
