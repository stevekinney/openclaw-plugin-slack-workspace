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
  slack_search_context: read,
  slack_schedule_message: write,
  slack_schedule_reschedule: write,
  slack_remind: write,
  slack_scheduled_list: read,
  slack_scheduled_cancel: write,
  slack_post_table: write,
  slack_post_plan: write,
  slack_post_chart: write,
  slack_post_rich_text: write,
  slack_blocks_send: write,
  slack_blocks_update: idempotentWrite,
  slack_message_get: read,
  slack_message_delete: write,
  slack_post_ephemeral: write,
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
  // Sets the given fields to fixed values; repeating it lands the same bookmark.
  slack_bookmark_edit: idempotentWrite,
  slack_bookmark_remove: write,
  slack_channel_list: read,
  slack_channel_members: read,
  slack_channel_create: write,
  slack_channel_archive: write,
  slack_channel_unarchive: write,
  slack_channel_rename: write,
  slack_channel_set_topic: idempotentWrite,
  slack_channel_set_purpose: idempotentWrite,
  slack_channel_invite: write,
  slack_channel_join: idempotentWrite,
  slack_channel_leave: idempotentWrite,
  slack_channel_kickoff: write,
  slack_list_create: write,
  // Sets the given fields to fixed values; repeating it lands the same list.
  slack_list_update: idempotentWrite,
  slack_list_schema: read,
  slack_list_item_create: write,
  // Sets each cell to a fixed value; repeating it lands the same result.
  slack_list_item_update: idempotentWrite,
  slack_list_item_delete: write,
  slack_list_items_delete_multiple: write,
  slack_list_items_list: read,
  slack_list_item_info: read,
  slack_list_access_set: idempotentWrite,
  slack_list_access_delete: idempotentWrite,
  slack_list_from_thread: write,
  slack_file_upload: write,
  // Overwrites the title with the given string; repeating the same call lands the same result.
  slack_assistant_set_title: idempotentWrite,
  // Replaces the thread's prompts wholesale, so repeating the call lands the same result.
  slack_assistant_suggest_prompts: idempotentWrite,
  // Each call starts a new workflow run.
  slack_workflow_trigger_run: write,
  slack_usergroup_list: read,
  slack_usergroup_members: read,
  // A second add with the same external ID is refused by Slack, so it is not replay-safe.
  slack_remote_file_add: write,
  // Sets the given fields to fixed values; repeating it lands the same file.
  slack_remote_file_update: idempotentWrite,
  slack_remote_file_remove: write,
  // Each share posts the file into the channels again.
  slack_remote_file_share: write,
};
