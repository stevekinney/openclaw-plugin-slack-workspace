import { beforeEach, describe, expect, it } from "vitest";
import { canvasPermalink, resetWorkspaceCache } from "./client.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const TEAM_ID = "T0TEST";
const ORIGIN = "https://example-workspace.slack.com";

/** Answer `auth.test` and the canvas methods the way Slack documents them. */
const slack = (call: RecordedCall) => {
  switch (call.method) {
    case "auth.test":
      return { ok: true, url: `${ORIGIN}/`, team: "Example", team_id: TEAM_ID, user_id: "U0BOT" };
    case "canvases.create":
      // Documented response: `{ok, canvas_id}` only — no url.
      return { ok: true, canvas_id: "F0CANVAS" };
    default:
      return { ok: true };
  }
};

beforeEach(() => resetWorkspaceCache());

describe("canvasPermalink", () => {
  it("builds a workspace-scoped URL: <workspace origin>/docs/<team id>/<canvas id>", () => {
    expect(canvasPermalink({ origin: ORIGIN, teamId: TEAM_ID }, "F0CANVAS")).toBe(
      "https://example-workspace.slack.com/docs/T0TEST/F0CANVAS",
    );
  });
});

describe("canvas tool URLs", () => {
  it("slack_canvas_create returns a permalink built from auth.test's workspace url and team id", async () => {
    await withMockFetch(slack, async () => {
      const result = (await runTool("slack_canvas_create", { title: "t", markdown: "m" })) as {
        url: string;
      };
      expect(result.url).toBe(`${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`);
      expect(result.url).not.toMatch(/^https:\/\/slack\.com\/docs\//);
    });
  });

  it("slack_canvas_edit returns the same permalink shape", async () => {
    await withMockFetch(slack, async () => {
      const result = (await runTool("slack_canvas_edit", {
        canvasId: "F0OTHER",
        operation: "append",
        markdown: "m",
      })) as { url: string };
      expect(result.url).toBe(`${ORIGIN}/docs/${TEAM_ID}/F0OTHER`);
    });
  });

  it("calls auth.test once per token, not once per canvas operation", async () => {
    await withMockFetch(slack, async (calls) => {
      await runTool("slack_canvas_create", { title: "t", markdown: "m" });
      await runTool("slack_canvas_edit", { canvasId: "F0CANVAS", operation: "rename", title: "x" });
      await runTool("slack_canvas_edit", { canvasId: "F0CANVAS", operation: "append", markdown: "m" });
      expect(calls.filter((call) => call.method === "auth.test")).toHaveLength(1);
    });
  });

  it("reuses the workspace slack_identity already looked up for the bot token", async () => {
    await withMockFetch(slack, async (calls) => {
      await runTool("slack_identity", {});
      await runTool("slack_canvas_create", { title: "t", markdown: "m" });
      expect(calls.map((call) => call.method)).toEqual(["auth.test", "canvases.create"]);
    });
  });

  it("returns a null url instead of a broken link when auth.test fails, keeping the canvas id", async () => {
    await withMockFetch(
      (call) =>
        call.method === "auth.test" ? { ok: false, error: "invalid_auth" } : slack(call),
      async () => {
        const result = await runTool("slack_canvas_create", { title: "t", markdown: "m" });
        expect(result).toEqual({ canvasId: "F0CANVAS", url: null, sharedWith: null });
      },
    );
  });

  it("retries auth.test on the next call after a failure instead of caching the error", async () => {
    let fail = true;
    await withMockFetch(
      (call) => {
        if (call.method === "auth.test" && fail) {
          fail = false;
          return { ok: false, error: "invalid_auth" };
        }
        return slack(call);
      },
      async () => {
        await runTool("slack_canvas_create", { title: "t", markdown: "m" });
        const result = (await runTool("slack_canvas_create", { title: "t", markdown: "m" })) as {
          url: string;
        };
        expect(result.url).toBe(`${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`);
      },
    );
  });
});
