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

`openclaw.plugin.json` is hand-authored. `npm run plugin:build` refreshes only the fields OpenClaw derives from the entry (id, name, description, `configSchema`, `contracts.tools`) and keeps the rest. Everything else (`configContracts`, `skills`, `toolMetadata`) is maintained by hand; when you add a tool, add its `toolMetadata` entry to both the manifest and `src/tool-metadata.ts`, which a test compares against it.

## Approvals

A `before_tool_call` hook asks a human to approve destructive calls before they reach Slack: `slack_canvas_edit` with `operation: "replace"`, `slack_bookmark_remove`, and `slack_scheduled_cancel`. Reviewers get `allow-once` or `deny` only; the plugin doesn't persist trust, so it never offers `allow-always`. The rules live in `src/approvals.ts`. When you add an irreversible or disruptive tool, register its rule there in the same change.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. It builds, checks that `openclaw.plugin.json` matches `openclaw plugins build` output, validates the plugin, and runs the tests. To run the same checks locally before you commit:

```bash
npm run ci
```

If the metadata check fails, run `npm run plugin:build` and commit the updated manifest.
