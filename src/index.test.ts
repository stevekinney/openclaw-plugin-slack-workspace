import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("slack-workspace", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "slack_identity",
      "slack_search",
      "slack_schedule_message",
      "slack_scheduled_list",
      "slack_scheduled_cancel",
      "slack_post_table",
      "slack_post_plan",
      "slack_post_chart",
      "slack_blocks_send",
      "slack_blocks_update",
      "slack_canvas_create",
      "slack_canvas_edit",
      "slack_canvas_sections",
      "slack_bookmark_list",
      "slack_bookmark_add",
      "slack_bookmark_remove",
    ]);
  });
});
