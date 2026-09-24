import { describe, expect, it } from "vitest";
import { APPROVAL_RULES, approvalFor } from "./approvals.js";
import { registerPlugin, slackResponse, withMockFetch, type RecordedCall } from "./test-utils.js";

type Decision = "allow-once" | "deny";

/**
 * Drive one tool call the way the host does: run the plugin's `before_tool_call`
 * hook, settle any approval it requests with `decision`, and execute the tool only
 * if the hook let the call through.
 */
async function callWithApproval(
  toolName: string,
  params: Record<string, unknown>,
  decision: Decision,
) {
  const { tools, hooks } = registerPlugin();
  const hook = hooks.find((candidate) => candidate.hookName === "before_tool_call")!;
  const result = (await hook.handler({ toolName, params }, { toolName })) as
    | { requireApproval?: { allowedDecisions?: string[] } }
    | undefined;
  const approval = result?.requireApproval;
  if (approval) {
    expect(approval.allowedDecisions).toContain(decision);
    if (decision === "deny") return { approval, executed: false };
  }
  const tool = tools.find((candidate) => candidate.name === toolName)!;
  await tool.execute("test-call", params);
  return { approval, executed: true };
}

const gated: Array<[string, Record<string, unknown>, string]> = [
  [
    "slack_canvas_edit",
    { canvasId: "F0TEST", operation: "replace", markdown: "# New body" },
    "canvases.edit",
  ],
  [
    "slack_bookmark_remove",
    { channelId: "C0TEST", bookmarkId: "Bk0TEST" },
    "bookmarks.remove",
  ],
  [
    "slack_scheduled_cancel",
    { channelId: "C0TEST", scheduledMessageId: "Q0TEST" },
    "chat.deleteScheduledMessage",
  ],
  ["slack_channel_archive", { channelId: "C0TEST", confirm: true }, "conversations.archive"],
  [
    "slack_channel_rename",
    { channelId: "C0TEST", name: "renamed", confirm: true },
    "conversations.rename",
  ],
  ["slack_channel_kickoff", { name: "launch" }, "conversations.create"],
];

describe("approval registry", () => {
  it("covers the destructive tools", () => {
    expect(APPROVAL_RULES.map((rule) => rule.toolName).sort()).toEqual([
      "slack_bookmark_remove",
      "slack_canvas_edit",
      "slack_channel_archive",
      "slack_channel_kickoff",
      "slack_channel_rename",
      "slack_scheduled_cancel",
    ]);
  });

  it.each(gated)("requests allow-once/deny approval with an external-post scope for %s", (
    toolName,
    params,
  ) => {
    const approval = approvalFor(toolName, params);
    expect(approval).toMatchObject({
      pluginId: "slack-workspace",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      scope: { kind: "external-post", visibility: "restricted" },
    });
    expect(approval?.title).toEqual(expect.any(String));
    expect(approval?.description).toEqual(expect.any(String));
  });

  it("names the affected canvas, bookmark, and scheduled message in the request", () => {
    expect(
      approvalFor("slack_canvas_edit", { canvasId: "F0TEST", operation: "replace", markdown: "x" }),
    ).toMatchObject({ scope: { target: "canvas F0TEST" } });
    expect(
      approvalFor("slack_canvas_edit", {
        canvasId: "F0TEST",
        operation: "replace",
        markdown: "x",
        sectionId: "temp:C:abc",
      })?.description,
    ).toContain("temp:C:abc");
    expect(
      approvalFor("slack_bookmark_remove", { channelId: "C0TEST", bookmarkId: "Bk0TEST" }),
    ).toMatchObject({ scope: { target: "channel C0TEST" } });
    expect(
      approvalFor("slack_bookmark_remove", { channelId: "C0TEST", bookmarkId: "Bk0TEST" })
        ?.description,
    ).toContain("Bk0TEST");
    expect(
      approvalFor("slack_scheduled_cancel", { channelId: "C0TEST", scheduledMessageId: "Q0TEST" })
        ?.description,
    ).toContain("Q0TEST");
  });

  it.each(["append", "prepend", "rename"])("does not gate canvas %s", (operation) => {
    expect(
      approvalFor("slack_canvas_edit", { canvasId: "F0TEST", operation, markdown: "x", title: "t" }),
    ).toBeUndefined();
  });

  it("does not gate tools without a rule", () => {
    expect(approvalFor("slack_bookmark_add", { channelId: "C0TEST" })).toBeUndefined();
    expect(approvalFor("slack_identity", {})).toBeUndefined();
  });

  it("describes a malformed call instead of throwing", () => {
    expect(approvalFor("slack_bookmark_remove", {})).toMatchObject({
      scope: { kind: "external-post" },
    });
  });
});

/**
 * Slack methods called, minus the read-only lookups: `auth.test` (canvas URLs) and
 * `conversations.info` (the channel tools' public-channel check).
 */
const writes = (calls: RecordedCall[]) =>
  calls
    .map((call) => call.method)
    .filter((method) => method !== "auth.test" && method !== "conversations.info");

describe("before_tool_call approvals", () => {
  it.each(gated)("a denied %s never reaches Slack", async (toolName, params) => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        const { approval, executed } = await callWithApproval(toolName, params, "deny");
        expect(approval).toBeDefined();
        expect(executed).toBe(false);
        expect(calls).toHaveLength(0);
      },
    );
  });

  it.each(gated)("an approved %s calls Slack once", async (toolName, params, method) => {
    await withMockFetch(
      () => slackResponse({ ok: true }),
      async (calls) => {
        const { approval, executed } = await callWithApproval(toolName, params, "allow-once");
        expect(approval).toBeDefined();
        expect(executed).toBe(true);
        expect(writes(calls)).toEqual([method]);
      },
    );
  });

  it("lets a canvas append through without asking", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        const { approval, executed } = await callWithApproval(
          "slack_canvas_edit",
          { canvasId: "F0TEST", operation: "append", markdown: "more" },
          "deny",
        );
        expect(approval).toBeUndefined();
        expect(executed).toBe(true);
        expect(writes(calls)).toEqual(["canvases.edit"]);
      },
    );
  });
});
