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

Every tool declares an `outputSchema`. When a tool returns data from Slack, the default is to curate it: map Slack's object down to the few fields the agent acts on, rename them to camelCase, and set `additionalProperties: false`. Curate whenever the raw object is large or noisy, or carries fields the agent has no use for, like ranks, audit user and team IDs, or icon URLs. `slack_search`, `slack_scheduled_list`, `slack_bookmark_list`, `slack_bookmark_add`, `slack_canvas_sections`, and `slack_canvas_list` all work this way. Pass a Slack value through untouched only when it's small and every field is useful, or when its structure is the point, like search's `paging` object. When you do, say so in the schema description. The rule also lives next to the shared schemas in `src/schemas.ts`.

## Approvals

A `before_tool_call` hook asks a human to approve destructive calls before they reach Slack: `slack_canvas_edit` with `operation: "replace"` or `"delete"`, `slack_canvas_delete`, `slack_bookmark_remove`, `slack_scheduled_cancel`, `slack_channel_archive`, `slack_channel_rename`, and every `slack_channel_kickoff`. Reviewers get `allow-once` or `deny` only; the plugin doesn't persist trust, so it never offers `allow-always`. The rules live in `src/approvals.ts`. When you add an irreversible or disruptive tool, register its rule there in the same change. `slack_canvas_status_update` is exempt on purpose: it exists for unattended scheduled runs, and it only ever rewrites the one section under its own heading, refusing a heading that matches more than one section.

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

## Scope doctor

`openclaw slack-workspace doctor` calls the read-only `auth.test` once per configured token and compares the scopes Slack actually granted against what each tool needs. Missing scopes are listed with the tools they break. This catches a Slack app whose manifest gained scopes that were never reinstalled. Pass `--json` for machine-readable output. The command exits non-zero on any gap, unavailable token, or rejected token. The per-tool requirements live in `TOOL_SCOPES` in `src/doctor.ts`. When you add a tool, add its entry there; a test fails if one is missing.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. It builds, checks that `openclaw.plugin.json` matches `openclaw plugins build` output, validates the plugin, and runs the tests. To run the same checks locally before you commit:

```bash
npm run ci
```

If the metadata check fails, run `npm run plugin:build` and commit the updated manifest.
