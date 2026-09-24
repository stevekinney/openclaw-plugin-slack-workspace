# slack-workspace — rules for agents

This repo is an OpenClaw tool plugin that lives inside the user's live OpenClaw
install. Work is driven by `ROADMAP.md`, often by unattended agents running
with permissions skipped. These rules are non-negotiable.

## Stay inside this repository

- Never read or modify anything under `~/.openclaw/` except this repository.
- In particular, never touch `~/.openclaw/openclaw.json`: it holds live tokens
  and the running gateway's configuration.

## No live Slack calls

- Make no live Slack API calls (no `curl` to slack.com, no `slack api`, no
  running the plugin against a real workspace). All tests use mocked `fetch`.
- When a task's acceptance criteria include a live check against
  `lostgradient`, satisfy the mocked half and list the live check under a
  **"Live verification pending"** heading in the PR description.

## Secrets

- Never commit, log, or paste secret values — not in code, tests, fixtures,
  commit messages, or PR descriptions. Tokens come from plugin config or
  SecretRefs only. Use obviously fake placeholders (e.g. `xoxb-test`) in tests.

## Task selection

- Tasks marked `[MANUAL]` or `[DEFERRED]` (checkbox `- [~]`) are for humans.
  Never implement them.
- Do not add tools that duplicate the bundled OpenClaw Slack channel plugin —
  see "Guiding principles" in `ROADMAP.md`.

## Before every commit

```bash
npm test
npm run plugin:validate
```

Both must pass.
