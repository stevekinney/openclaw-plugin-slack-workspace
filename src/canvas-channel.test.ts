import { describe, expect, it } from "vitest";
import { runTool, withMockFetch, type MockFetchHandler, type RecordedCall } from "./test-utils.js";

const AUTH = { ok: true, url: "https://lostgradient.slack.com/", team_id: "T0TEAM" };

/** Answer each Slack method from a fixed map; auth.test backs the canvas URL. */
const slack =
  (responses: Record<string, Record<string, unknown> | (() => Record<string, unknown>)>): MockFetchHandler =>
  ({ method }) => {
    if (method === "auth.test") return AUTH;
    const response = responses[method];
    if (!response) throw new Error(`Unexpected Slack call: ${method}`);
    return typeof response === "function" ? response() : response;
  };

const channelWith = (canvas?: Record<string, unknown>) => ({
  ok: true,
  channel: { id: "C0CHAN", ...(canvas ? { properties: { canvas } } : {}) },
});

const slackMethods = (calls: RecordedCall[]) =>
  calls.map((call) => call.method).filter((method) => method !== "auth.test");

describe("slack_canvas_channel_get_or_create", () => {
  it("returns the existing channel canvas without creating one", async () => {
    await withMockFetch(
      slack({ "conversations.info": channelWith({ file_id: "F0EXISTING", is_empty: false }) }),
      async (calls) => {
        const result = await runTool("slack_canvas_channel_get_or_create", {
          channelId: "C0CHAN",
          title: "Status",
          markdown: "# Status",
        });
        expect(slackMethods(calls)).toEqual(["conversations.info"]);
        expect(calls[0]!.body).toEqual({ channel: "C0CHAN" });
        expect(result).toEqual({
          canvasId: "F0EXISTING",
          channelId: "C0CHAN",
          created: false,
          url: "https://lostgradient.slack.com/docs/T0TEAM/F0EXISTING",
        });
      },
    );
  });

  it("creates the channel canvas when the channel has none", async () => {
    await withMockFetch(
      slack({
        "conversations.info": channelWith(),
        "conversations.canvases.create": { ok: true, canvas_id: "F0NEW" },
      }),
      async (calls) => {
        const result = await runTool("slack_canvas_channel_get_or_create", {
          channelId: "C0CHAN",
          title: "Status",
          markdown: "# Status\n\nAll green.",
        });
        expect(slackMethods(calls)).toEqual(["conversations.info", "conversations.canvases.create"]);
        const create = calls.find((call) => call.method === "conversations.canvases.create")!;
        expect(create.body).toEqual({
          channel_id: "C0CHAN",
          title: "Status",
          document_content: { type: "markdown", markdown: "# Status\n\nAll green." },
        });
        expect(result).toEqual({
          canvasId: "F0NEW",
          channelId: "C0CHAN",
          created: true,
          url: "https://lostgradient.slack.com/docs/T0TEAM/F0NEW",
        });
      },
    );
  });

  it("creates an empty canvas when no title or markdown is given", async () => {
    await withMockFetch(
      slack({
        "conversations.info": channelWith(),
        "conversations.canvases.create": { ok: true, canvas_id: "F0NEW" },
      }),
      async (calls) => {
        await runTool("slack_canvas_channel_get_or_create", { channelId: "C0CHAN" });
        const create = calls.find((call) => call.method === "conversations.canvases.create")!;
        expect(create.body).toEqual({ channel_id: "C0CHAN" });
      },
    );
  });

  it("resolves the winner's canvas when another caller created it first", async () => {
    let infoCalls = 0;
    await withMockFetch(
      slack({
        "conversations.info": () =>
          ++infoCalls === 1 ? channelWith() : channelWith({ file_id: "F0RACED" }),
        "conversations.canvases.create": { ok: false, error: "channel_canvas_already_exists" },
      }),
      async (calls) => {
        const result = await runTool("slack_canvas_channel_get_or_create", { channelId: "C0CHAN" });
        expect(slackMethods(calls)).toEqual([
          "conversations.info",
          "conversations.canvases.create",
          "conversations.info",
        ]);
        expect(result).toMatchObject({ canvasId: "F0RACED", created: false });
      },
    );
  });

  it("surfaces other create failures", async () => {
    await withMockFetch(
      slack({
        "conversations.info": channelWith(),
        "conversations.canvases.create": { ok: false, error: "missing_scope", needed: "canvases:write" },
      }),
      async () => {
        await expect(
          runTool("slack_canvas_channel_get_or_create", { channelId: "C0CHAN" }),
        ).rejects.toThrow("conversations.canvases.create failed: missing_scope (needs scope: canvases:write)");
      },
    );
  });

  it("surfaces a conversations.info failure without creating anything", async () => {
    await withMockFetch(
      slack({ "conversations.info": { ok: false, error: "channel_not_found" } }),
      async (calls) => {
        await expect(
          runTool("slack_canvas_channel_get_or_create", { channelId: "C0MISSING" }),
        ).rejects.toThrow("conversations.info failed: channel_not_found");
        expect(slackMethods(calls)).toEqual(["conversations.info"]);
      },
    );
  });
});
