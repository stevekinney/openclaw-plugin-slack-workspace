import { describe, expect, it } from "vitest";
import { runTool, withMockFetch, type MockFetchHandler, type RecordedCall } from "./test-utils.js";

const AUTH = { ok: true, url: "https://lostgradient.slack.com/", team_id: "T0TEAM" };

const CHANNEL_WITH_CANVAS = {
  ok: true,
  channel: { id: "C0CHAN", properties: { canvas: { file_id: "F0STATUS" } } },
};

type Handler = (call: RecordedCall) => Record<string, unknown>;

/** Answer each Slack method from a map; auth.test backs the canvas URL. */
const slack =
  (responses: Record<string, Record<string, unknown> | Handler>): MockFetchHandler =>
  (call) => {
    if (call.method === "auth.test") return AUTH;
    const response = responses[call.method];
    if (!response) throw new Error(`Unexpected Slack call: ${call.method}`);
    return typeof response === "function" ? response(call) : response;
  };

const slackCalls = (calls: RecordedCall[]) => calls.filter((call) => call.method !== "auth.test");

describe("slack_canvas_status_update", () => {
  it("looks the section up fresh on every run and replaces whichever id it returns", async () => {
    // Slack hands back a different id on the second run, as if the section was rebuilt in between.
    const ids = ["temp:C:first", "temp:C:second"];
    let lookups = 0;
    await withMockFetch(
      slack({
        "conversations.info": CHANNEL_WITH_CANVAS,
        "canvases.sections.lookup": () => ({ ok: true, sections: [{ id: ids[lookups++] }] }),
        "canvases.edit": { ok: true },
      }),
      async (calls) => {
        const first = await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "All green.",
        });
        const second = await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "Two failures.",
        });

        expect(slackCalls(calls).map((call) => call.method)).toEqual([
          "conversations.info",
          "canvases.sections.lookup",
          "canvases.edit",
          "conversations.info",
          "canvases.sections.lookup",
          "canvases.edit",
        ]);
        const lookup = calls.find((call) => call.method === "canvases.sections.lookup")!;
        expect(lookup.body).toEqual({
          canvas_id: "F0STATUS",
          criteria: { section_types: ["h2"], contains_text: "Build status" },
        });
        const edits = calls.filter((call) => call.method === "canvases.edit");
        expect(edits.map((call) => call.body)).toEqual([
          {
            canvas_id: "F0STATUS",
            changes: [
              {
                operation: "replace",
                section_id: "temp:C:first",
                document_content: { type: "markdown", markdown: "## Build status\n\nAll green." },
              },
            ],
          },
          {
            canvas_id: "F0STATUS",
            changes: [
              {
                operation: "replace",
                section_id: "temp:C:second",
                document_content: { type: "markdown", markdown: "## Build status\n\nTwo failures." },
              },
            ],
          },
        ]);
        expect(first).toEqual({
          canvasId: "F0STATUS",
          channelId: "C0CHAN",
          action: "replaced",
          sectionId: "temp:C:first",
          url: "https://lostgradient.slack.com/docs/T0TEAM/F0STATUS",
        });
        expect(second).toMatchObject({ action: "replaced", sectionId: "temp:C:second" });
      },
    );
  });

  it("appends the section when the canvas doesn't have it yet", async () => {
    await withMockFetch(
      slack({
        "conversations.info": CHANNEL_WITH_CANVAS,
        "canvases.sections.lookup": { ok: true, sections: [] },
        "canvases.edit": { ok: true },
      }),
      async (calls) => {
        const result = await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "All green.",
          headingLevel: "h3",
        });
        const edit = calls.find((call) => call.method === "canvases.edit")!;
        expect(edit.body).toEqual({
          canvas_id: "F0STATUS",
          changes: [
            {
              operation: "insert_at_end",
              document_content: { type: "markdown", markdown: "### Build status\n\nAll green." },
            },
          ],
        });
        expect(result).toMatchObject({ action: "inserted", sectionId: null });
      },
    );
  });

  it("inserts a missing section after an anchor heading when one is found", async () => {
    await withMockFetch(
      slack({
        "conversations.info": CHANNEL_WITH_CANVAS,
        "canvases.sections.lookup": ({ body }) => {
          const criteria = body.criteria as { contains_text: string };
          return criteria.contains_text === "Overview"
            ? { ok: true, sections: [{ id: "temp:C:overview" }] }
            : { ok: true, sections: [] };
        },
        "canvases.edit": { ok: true },
      }),
      async (calls) => {
        await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "All green.",
          insertAfterHeading: "Overview",
        });
        const lookups = calls.filter((call) => call.method === "canvases.sections.lookup");
        expect(lookups.map((call) => call.body.criteria)).toEqual([
          { section_types: ["h2"], contains_text: "Build status" },
          { section_types: ["any_header"], contains_text: "Overview" },
        ]);
        const edit = calls.find((call) => call.method === "canvases.edit")!;
        expect(edit.body.changes).toEqual([
          {
            operation: "insert_after",
            section_id: "temp:C:overview",
            document_content: { type: "markdown", markdown: "## Build status\n\nAll green." },
          },
        ]);
      },
    );
  });

  it("falls back to appending when the anchor heading is missing", async () => {
    await withMockFetch(
      slack({
        "conversations.info": CHANNEL_WITH_CANVAS,
        "canvases.sections.lookup": { ok: true, sections: [] },
        "canvases.edit": { ok: true },
      }),
      async (calls) => {
        await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "All green.",
          insertAfterHeading: "Overview",
        });
        const edit = calls.find((call) => call.method === "canvases.edit")!;
        expect((edit.body.changes as { operation: string }[])[0]!.operation).toBe("insert_at_end");
      },
    );
  });

  it("creates the channel canvas with the section when the channel has none", async () => {
    await withMockFetch(
      slack({
        "conversations.info": { ok: true, channel: { id: "C0CHAN" } },
        "conversations.canvases.create": { ok: true, canvas_id: "F0NEW" },
      }),
      async (calls) => {
        const result = await runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build status",
          markdown: "All green.",
          title: "Team board",
        });
        expect(slackCalls(calls).map((call) => call.method)).toEqual([
          "conversations.info",
          "conversations.canvases.create",
        ]);
        expect(calls.find((call) => call.method === "conversations.canvases.create")!.body).toEqual({
          channel_id: "C0CHAN",
          title: "Team board",
          document_content: { type: "markdown", markdown: "## Build status\n\nAll green." },
        });
        expect(result).toEqual({
          canvasId: "F0NEW",
          channelId: "C0CHAN",
          action: "created_canvas",
          sectionId: null,
          url: "https://lostgradient.slack.com/docs/T0TEAM/F0NEW",
        });
      },
    );
  });

  it("refuses to guess when the heading matches more than one section", async () => {
    await withMockFetch(
      slack({
        "conversations.info": CHANNEL_WITH_CANVAS,
        "canvases.sections.lookup": { ok: true, sections: [{ id: "temp:C:a" }, { id: "temp:C:b" }] },
      }),
      async (calls) => {
        await expect(
          runTool("slack_canvas_status_update", {
            channelId: "C0CHAN",
            heading: "Status",
            markdown: "All green.",
          }),
        ).rejects.toThrow(/matches 2 sections/);
        expect(calls.some((call) => call.method === "canvases.edit")).toBe(false);
      },
    );
  });

  it("rejects a multi-line heading before calling Slack", async () => {
    await withMockFetch(slack({}), async (calls) => {
      await expect(
        runTool("slack_canvas_status_update", {
          channelId: "C0CHAN",
          heading: "Build\nstatus",
          markdown: "All green.",
        }),
      ).rejects.toThrow(/single line/);
      expect(calls).toHaveLength(0);
    });
  });
});
