# Slack Workspace

OpenClaw plugin that registers Slack workspace tools and hooks with `definePluginEntry`.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

## Manifest

`openclaw.plugin.json` is hand-authored. `npm run plugin:build` refreshes only the fields OpenClaw derives from the entry (id, name, description, `configSchema`, `contracts.tools`) and keeps the rest. Everything else (`configContracts`, `skills`, `cliCommands`, `toolMetadata`) is maintained by hand; when you add a tool, add its `toolMetadata` entry to both the manifest and `src/tool-metadata.ts`, which a test compares against it.

## Output shaping

Every tool declares an `outputSchema`. When a tool returns data from Slack, the default is to curate it: map Slack's object down to the few fields the agent acts on, rename them to camelCase, and set `additionalProperties: false`. Curate whenever the raw object is large or noisy, or carries fields the agent has no use for, like ranks, audit user and team IDs, or icon URLs. `slack_search`, `slack_scheduled_list`, `slack_bookmark_list`, `slack_bookmark_add`, `slack_bookmark_edit`, `slack_canvas_sections`, and `slack_canvas_list` all work this way. Pass a Slack value through untouched only when it's small and every field is useful, or when its structure is the point, like search's `paging` object. When you do, say so in the schema description. The rule also lives next to the shared schemas in `src/schemas.ts`.

## Approvals

A `before_tool_call` hook asks a human to approve destructive calls before they reach Slack: `slack_canvas_edit` with `operation: "replace"` or `"delete"`, `slack_canvas_delete`, `slack_bookmark_remove`, `slack_scheduled_cancel`, `slack_channel_archive`, `slack_channel_rename`, `slack_list_item_delete`, `slack_list_items_delete_multiple`, and every `slack_channel_kickoff`. Reviewers get `allow-once` or `deny` only; the plugin doesn't persist trust, so it never offers `allow-always`. The rules live in `src/approvals.ts`. When you add an irreversible or disruptive tool, register its rule there in the same change. `slack_canvas_status_update` is exempt on purpose: it exists for unattended scheduled runs, and it only ever rewrites the one section under its own heading, refusing a heading that matches more than one section.

Archive and rename also require an explicit `confirm: true` argument. The schema has no default for it, and the tool refuses the call before contacting Slack without it. That guard still holds in cron jobs and other automation where no one is around to approve.

## Canvas discovery

`slack_canvas_list` finds canvases you don't already have an ID for. Slack stores canvases as files, so the tool calls `files.list` with `types=canvas`, the lookup Slack's canvas docs recommend. It uses the bot token and the `files:read` scope the app already holds, not a search scope. The bot sees only canvases it created or that were shared somewhere it can read. `files.list` pages by `page` and `count` instead of a cursor, so the result carries `page`, `pages`, `total`, and `hasMore`.

## Channel lifecycle

`slack_channel_create`, `slack_channel_archive`, `slack_channel_rename`, `slack_channel_set_topic`, `slack_channel_set_purpose`, and `slack_channel_invite` work on public channels only. The app holds `channels:manage`, `channels:write.topic`, and `channels:write.invites`, but not their private-channel twins (`groups:write`, `groups:write.topic`, `groups:write.invites`). Each tool that takes an existing channel looks it up with `conversations.info` first. If the channel is private, the tool fails with an error naming the `groups:write*` scope it would need, instead of Slack's bare `missing_scope`.

`slack_channel_kickoff` stands up a project room in one call: it creates a public channel, then runs whichever of these you pass: set the topic, set the purpose, invite users, create a canvas shared to the channel, and add a link bookmark. It's composed from the same calls as the single-purpose tools. Once the channel exists, a failed step doesn't stop the rest. Each step lands in `steps` with its error, and `complete` is `false` if any of them failed. If the create call fails, the tool throws, because nothing else can run without a channel. Every kickoff waits for a human's approval.

## Channel membership

`slack_channel_join` and `slack_channel_leave` add and remove the bot from a public channel. Neither waits for approval: both are visible and easy to reverse.

Most tools don't need an explicit join. When a bot-token call fails with `not_in_channel`, the client looks the channel up with `conversations.info`, joins it with `conversations.join` if it's public, and retries the original call once. The tool's result then carries `autoJoined: true`, so the agent knows it's now a member. The client never joins private channels, DMs, or group DMs; those fail with an error asking for an `/invite @OpenClaw`. Archived channels fail with an error that says so. A failed join or a failed retry is never retried again. Set `autoJoin: false` in the plugin config to turn this off, or list channel IDs in `autoJoinDeny` to keep the bot out of specific channels.

`conversations.join` needs the `channels:join` bot scope, which the Slack app doesn't have until roadmap task O-12 adds it. Until then, a join fails with an error naming the scope. Keep in mind what membership does on the host side: with the channel plugin's `groupPolicy: "open"`, every channel the bot joins becomes one where the agent answers @-mentions, and the channel plugin posts an introduction on join unless `channels.slack.joinIntro` is `false`.

## Lists

`slack_list_create` wraps `slackLists.create` with the bot token and the `lists:write` scope. Pass a `schema` of typed columns (`key`, `name`, `type`, optional `primary`, and Slack's column `options` passed through verbatim), or copy an existing list's columns with `copyFromListId`, adding `includeCopiedListRecords` to copy its items too. Slack rejects a call that sets both `schema` and `copyFromListId`, so the tool refuses it before calling Slack. `todoMode` adds Slack's completed, assignee, and due-date columns. Slack has no method to add, remove, or retype columns after creation, so the schema has to cover every column up front. The result carries the new `listId` and each column's `id`, which later item writes need.

`slack_list_schema` reads an existing list's columns with the `lists:read` scope. It calls `slackLists.items.list` with `include_list` and a one-item limit, since that response carries the parent list's schema and `slackLists.items.info` would need an item ID first. Each column comes back with its `id`, `key`, `name`, and `type`, and select and multi-select columns add `options` pairing each option ID with its label. Item writes need those IDs rather than the names people see in Slack.

`slack_list_item_create` and `slack_list_item_update` take column names, so callers don't have to call `slack_list_schema` first. Both read the schema once per call, resolve each name (or column ID or key) and each select label to Slack's IDs, and shape every value for its column type: text becomes a `rich_text` block; user, channel, email, phone, date (`YYYY-MM-DD`), and select values become arrays; number and rating stay bare numbers; checkbox stays a bare boolean. Columns of other types, such as attachments, are refused before anything reaches Slack. `slack_list_item_create` passes `parentItemId` through to add a subtask. `slack_list_item_update` sends all its `cells` in one `slackLists.items.update` call, and the cells can span several items. `slack_list_item_delete` and `slack_list_items_delete_multiple` wrap `slackLists.items.delete` and `.deleteMultiple`, and both wait for approval.

`slack_list_items_list` and `slack_list_item_info` are the read side, with the `lists:read` scope. `slack_list_items_list` wraps `slackLists.items.list` and walks Slack's cursor pages with the shared pagination helper, up to ten pages per call; when `hasMore` is still true, pass the returned `cursor` back to continue. Set `archived: true` to list archived items instead of active ones. `slack_list_item_info` wraps `slackLists.items.info` and returns one item plus its `subtasks`. Both return each item's `id`, `parentItemId` for subtasks, who created it and when, and its `fields`: each cell's `columnId`, `key`, plain `text` where Slack sends one, and Slack's `value` as-is. Cells come back keyed by column ID, so pair them with `slack_list_schema` to get column names.

`slack_list_access_set` and `slack_list_access_delete` wrap `slackLists.access.set` and `.delete` with the `lists:write` scope, and take the same arguments as the canvas access tools: `channelIds` or `userIds` (never both in one call), and for `set`, an `accessLevel` of `read`, `write`, or `owner`. Only users can be owners, so the tool refuses `owner` with `channelIds` before calling Slack. Calling `set` again for the same target changes its level.

`slack_list_from_thread` turns a thread's action items into List rows. It reads the thread with the same `conversations.replies` helper as `slack_canvas_from_thread`, then picks out open checklist entries (`- [ ] …`), lines starting `TODO:` or `Action item:`, and bullets under an "Action items:" or "Next steps:" heading. The first mention in an item becomes its assignee. An agent that has read the thread itself can pass `items` (each a `task` with an optional `assignee` and `dueDate`) and skip the pattern matching. Without `listId`, the tool creates a `todo_mode` list with one primary Task column and shares it with the thread's channel (or the `channelIds`/`userIds` given). With `listId`, it reads that list's schema and appends rows, putting the task in the primary column (or first text column) and the assignee and due date in the to-do columns when the list has them. Slack has no batch item create, so each row is its own `slackLists.items.create` call. If a row or the share fails, the result still carries the `listId`, the rows already added, and an `itemError` or `shareError`. The tool needs `lists:write`, `lists:read` for an existing list, and the history scope for the thread's channel type.

## File uploads

`slack_file_upload` pushes a file the agent generated, like a report, a CSV, or a chart image, to Slack outside a normal chat turn. `files.upload` is retired, so the tool runs Slack's three-step external upload. First, `files.getUploadURLExternal` reserves a URL for the file's byte length. Then the tool POSTs the raw bytes to that pre-signed URL, without the token. (Slack's docs specify POST for this step, not PUT.) Last, `files.completeUploadExternal` finishes the upload and shares the file. With `channelId`, the file lands in that channel, or in the `threadTs` thread, with an optional `initialComment`. Without `channelId`, the file stays private to the bot: it is uploaded but shared nowhere. Text goes in `content` as-is. Binary files like PNGs go in as base64 with `contentEncoding: "base64"`. `filename` sets the extension Slack uses to infer the file type, and it defaults to the title. The result is `{ fileId, permalink, channelId, ts }`. `ts` is the share message's timestamp, and it's null when the file is private or Slack hasn't reported the share yet. The tool needs the `files:write` bot scope.

## Scheduled messages

`slack_schedule_message` wraps `chat.scheduleMessage` with the bot token and the `chat:write` scope. Slack allows 30 messages per 5-minute window per channel, counted by when they're set to post, not when you schedule them. Past that, Slack fails the call with `restricted_too_many`, and the plugin's error hint names the cap so the agent knows to spread the post times out. Both scheduling tools say so in their descriptions, too.

Slack has no method to edit a scheduled message, so `slack_schedule_reschedule` does the delete-and-recreate in one call. It takes the original's `channelId` and `scheduledMessageId`, plus the replacement's full `text`, `postAt`, and optional `blocks` and `threadTs`. Nothing carries over from the original. The tool checks `postAt` before it calls Slack, then schedules the replacement first and cancels the original second. That order means a refused replacement, say from the channel cap, leaves the original pending. If the original can't be cancelled, maybe because it already posted, the tool withdraws the replacement and reports the error, so you never end up with two copies. In the rare case that the withdrawal fails too, the error names both IDs. The result is `{ channelId, scheduledMessageId, replacedScheduledMessageId, postAt, postAtIso }`, and the replacement has a new ID. It isn't gated by an approval the way `slack_scheduled_cancel` is, because it always leaves one message pending.

## Reminders

`slack_remind` is the plugin's reminder tool. Slack's docs for `reminders.add` and `reminders.list` say the reminder methods began retiring in March 2023 and "have become degraded or useless," so the tool doesn't touch them. Instead, it schedules an ordinary message. Pass `userId` to remind a person: the tool calls `conversations.open` to find or open the bot's DM with them, then schedules the reminder there with `chat.scheduleMessage`. Pass `channelId` instead to post the reminder in a channel, which skips the DM step. Set exactly one of the two. `when` takes the same formats and limits as `slack_schedule_message`'s `postAt`: an ISO-8601 datetime with an explicit offset, or Unix seconds, in the future and at most 120 days out. The tool checks `when` before it calls Slack. It uses the bot token with the `im:write` and `chat:write` scopes. The result is `{ channelId, userId?, scheduledMessageId, postAt, postAtIso }`, and because a reminder is just a scheduled message, `slack_scheduled_list` shows it and `slack_scheduled_cancel` cancels it. Each reminder fires once. For a recurring one, set up an `openclaw automations` job that calls the tool.

## Ephemeral messages

`slack_post_ephemeral` wraps `chat.postEphemeral` to send one user a private nudge inside a shared channel or thread, so nobody else sees it. It takes `channelId`, `userId`, `text`, and optional `blocks` and `threadTs`, and it uses the bot token with the `chat:write` scope. The user has to be a member of the channel. The result is `{ channelId, userId, ephemeralTs }`, and it deliberately has no `ts` field: `chat.update` can't target an ephemeral message, so `ephemeralTs` is for reference only and won't work with `slack_blocks_update` or `updateTs`. Ephemeral messages don't persist, either. They vanish when the user reloads Slack.

## Assistant thread titles

`slack_assistant_set_title` wraps `assistant.threads.setTitle` to rename the title Slack shows for an Agent View or Assistant View thread, so the agent can swap the default title for something descriptive once it knows what the conversation is about. It takes `channelId`, `threadTs` (the assistant thread's root), and `title`, and it uses the bot token with the `assistant:write` scope. It only works on those Slack-managed assistant threads, not ordinary channel or DM threads. The bundled Slack channel plugin never calls `setTitle` itself, so this tool doesn't compete with core. The result is `{ channelId, threadTs, title }`.

`slack_assistant_suggest_prompts` wraps `assistant.threads.setSuggestedPrompts` to show up to four tappable follow-up prompts under an Agent View or Assistant View thread. It takes `channelId`, `threadTs`, and `prompts`, an array of one to four `{ title, message }` objects, and it uses the bot token with the `assistant:write` scope. Each call replaces the prompts already shown. The result is `{ channelId, threadTs, prompts }`. This tool is a stopgap: the bundled channel plugin only makes a threadless `setSuggestedPrompts` call to detect Agent View and has no per-thread action yet ([openclaw/openclaw#50481](https://github.com/openclaw/openclaw/issues/50481)). Retire it, or merge it into core, once core ships the equivalent.

## Workflow triggers

`slack_workflow_trigger_run` starts a Workflow Builder workflow from a conversation. Slack has no Web API method that starts a Workflow Builder workflow from a bot token (see roadmap W-01), so the tool uses a webhook trigger instead. Create one in Workflow Builder, which gives you a stable `https://hooks.slack.com/triggers/...` URL, and add it under a name in the plugin config's `workflowTriggers` map. Each entry is a string or a SecretRef, and each one is declared in `configContracts.secretInputs` (`workflowTriggers.*`). The URL is the credential: anyone holding it can start the workflow, so treat it like a token. The tool takes `name` and an optional `payload` object, whose keys are the trigger's variables as defined in Workflow Builder. It POSTs `payload` as JSON, without a Slack token, so it needs no OAuth scope. An unknown name fails before any request and lists the configured names. The result is `{ name, status, response }`, where `response` is Slack's body, parsed as JSON when it is JSON. A non-2xx status fails with the status and the start of the body. Neither the error nor the log line ever includes the URL.

## Workflow Builder → OpenClaw bridge

[`docs/workflow-builder-gateway-bridge.md`](docs/workflow-builder-gateway-bridge.md) covers the opposite direction: a Workflow Builder workflow that hands a prompt to an OpenClaw agent through the Gateway's `POST /hooks/agent` endpoint. OpenClaw posts the agent's reply straight to a Slack channel. It needs no plugin code and no new scopes, but it does need `hooks.enabled`, a public Gateway origin (roadmap O-06), and a small custom-step Slack app, because Workflow Builder has no built-in outbound HTTP step. The recipe hasn't been run live yet; roadmap H-03 tracks that.

## Inbound webhooks

[`docs/inbound-webhooks.md`](docs/inbound-webhooks.md) maps the ways an external system can reach OpenClaw or Slack to when to use each. The options are OpenClaw's Gateway hooks (`/hooks/wake`, `/hooks/agent` with direct Slack delivery, and mapped `/hooks/<name>`), the bundled Webhooks plugin for TaskFlow state (which never starts an agent), and Slack's own `incoming-webhook` URL (which bypasses OpenClaw entirely). None of them needs code in this plugin, which is why it doesn't run an HTTP listener of its own.

## Scope doctor

`openclaw slack-workspace doctor` calls the read-only `auth.test` once per configured token and compares the scopes Slack actually granted against what each tool needs. Missing scopes are listed with the tools they break. This catches a Slack app whose manifest gained scopes that were never reinstalled. Pass `--json` for machine-readable output. The command exits non-zero on any gap, unavailable token, or rejected token. The per-tool requirements live in `TOOL_SCOPES` in `src/doctor.ts`. When you add a tool, add its entry there; a test fails if one is missing.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. It builds, checks that `openclaw.plugin.json` matches `openclaw plugins build` output, validates the plugin, and runs the tests. To run the same checks locally before you commit:

```bash
npm run ci
```

If the metadata check fails, run `npm run plugin:build` and commit the updated manifest.
