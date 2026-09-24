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

Every tool declares an `outputSchema`. When a tool returns data from Slack, the default is to curate it: map Slack's object down to the few fields the agent acts on, rename them to camelCase, and set `additionalProperties: false`. Curate whenever the raw object is large or noisy, or carries fields the agent has no use for, like ranks, audit user and team IDs, or icon URLs. `slack_search`, `slack_scheduled_list`, `slack_bookmark_list`, `slack_bookmark_add`, and `slack_canvas_sections` all work this way. Pass a Slack value through untouched only when it's small and every field is useful, or when its structure is the point, like search's `paging` object. When you do, say so in the schema description. The rule also lives next to the shared schemas in `src/schemas.ts`.

## Approvals

A `before_tool_call` hook asks a human to approve destructive calls before they reach Slack: `slack_canvas_edit` with `operation: "replace"`, `slack_bookmark_remove`, `slack_scheduled_cancel`, `slack_channel_archive`, and `slack_channel_rename`. Reviewers get `allow-once` or `deny` only; the plugin doesn't persist trust, so it never offers `allow-always`. The rules live in `src/approvals.ts`. When you add an irreversible or disruptive tool, register its rule there in the same change.

Archive and rename also require an explicit `confirm: true` argument. The schema has no default for it, and the tool refuses the call before contacting Slack without it. That guard still holds in cron jobs and other automation where no one is around to approve.

## Channel lifecycle

`slack_channel_create`, `slack_channel_archive`, `slack_channel_rename`, `slack_channel_set_topic`, `slack_channel_set_purpose`, and `slack_channel_invite` work on public channels only. The app holds `channels:manage`, `channels:write.topic`, and `channels:write.invites`, but not their private-channel twins (`groups:write`, `groups:write.topic`, `groups:write.invites`). Each tool that takes an existing channel looks it up with `conversations.info` first. If the channel is private, the tool fails with an error naming the `groups:write*` scope it would need, instead of Slack's bare `missing_scope`.

## Scope doctor

`openclaw slack-workspace doctor` calls the read-only `auth.test` once per configured token and compares the scopes Slack actually granted against what each tool needs. Missing scopes are listed with the tools they break. This catches a Slack app whose manifest gained scopes that were never reinstalled. Pass `--json` for machine-readable output. The command exits non-zero on any gap, unavailable token, or rejected token. The per-tool requirements live in `TOOL_SCOPES` in `src/doctor.ts`. When you add a tool, add its entry there; a test fails if one is missing.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. It builds, checks that `openclaw.plugin.json` matches `openclaw plugins build` output, validates the plugin, and runs the tests. To run the same checks locally before you commit:

```bash
npm run ci
```

If the metadata check fails, run `npm run plugin:build` and commit the updated manifest.
