/**
 * Manifest `toolMetadata` for every tool. `openclaw.plugin.json` is hand-authored;
 * a test keeps its `toolMetadata` identical to this map.
 *
 * `sideEffecting`: the call can change Slack state, so failed attempts must stay visible.
 * `replaySafe`: repeating the call after an incomplete model turn does no harm.
 */
type ToolMetadata = {
  sideEffecting: boolean;
  replaySafe: boolean;
  profiles: ["messaging"];
};

const read: ToolMetadata = { sideEffecting: false, replaySafe: true, profiles: ["messaging"] };
const write: ToolMetadata = { sideEffecting: true, replaySafe: false, profiles: ["messaging"] };
/** Rewrites a message to a fixed state; repeating it lands the same result. */
const idempotentWrite: ToolMetadata = { ...write, replaySafe: true };

export const TOOL_METADATA: Record<string, ToolMetadata> = {
  slack_identity: read,
  slack_search: read,
  slack_schedule_message: write,
  slack_scheduled_list: read,
  slack_scheduled_cancel: write,
  slack_post_table: write,
  slack_post_plan: write,
  slack_post_chart: write,
  slack_blocks_send: write,
  slack_blocks_update: idempotentWrite,
  slack_canvas_create: write,
  slack_canvas_edit: write,
  slack_canvas_sections: read,
  slack_canvas_list: read,
  slack_canvas_access_set: idempotentWrite,
  slack_canvas_access_delete: idempotentWrite,
  slack_canvas_delete: write,
  // Creates only when missing, so a repeat resolves the same canvas.
  slack_canvas_channel_get_or_create: idempotentWrite,
  // Rewrites one section to a fixed state, found fresh by heading each time.
  slack_canvas_status_update: idempotentWrite,
  slack_canvas_from_thread: write,
  slack_bookmark_list: read,
  slack_bookmark_add: write,
  slack_bookmark_remove: write,
  slack_channel_create: write,
  slack_channel_archive: write,
  slack_channel_rename: write,
  slack_channel_set_topic: idempotentWrite,
  slack_channel_set_purpose: idempotentWrite,
  slack_channel_invite: write,
  slack_channel_join: idempotentWrite,
  slack_channel_leave: idempotentWrite,
  slack_channel_kickoff: write,
};
