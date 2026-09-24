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

## Approvals

A `before_tool_call` hook asks a human to approve destructive calls before they reach Slack: `slack_canvas_edit` with `operation: "replace"`, `slack_bookmark_remove`, and `slack_scheduled_cancel`. Reviewers get `allow-once` or `deny` only; the plugin doesn't persist trust, so it never offers `allow-always`. The rules live in `src/approvals.ts`. When you add an irreversible or disruptive tool, register its rule there in the same change.

## Scope doctor

`openclaw slack-workspace doctor` calls the read-only `auth.test` once per configured token and compares the scopes Slack actually granted against what each tool needs. Missing scopes are listed with the tools they break. This catches a Slack app whose manifest gained scopes that were never reinstalled. Pass `--json` for machine-readable output. The command exits non-zero on any gap, unavailable token, or rejected token. The per-tool requirements live in `TOOL_SCOPES` in `src/doctor.ts`. When you add a tool, add its entry there; a test fails if one is missing.

## CI

`.github/workflows/ci.yml` runs on every push and pull request. It builds, checks that `openclaw.plugin.json` matches `openclaw plugins build` output, validates the plugin, and runs the tests. To run the same checks locally before you commit:

```bash
npm run ci
```

If the metadata check fails, run `npm run plugin:build` and commit the updated manifest.
