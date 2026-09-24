# Inbound webhooks: which one to use

An external system (CI, monitoring, Zapier, n8n, an internal service) wants to tell OpenClaw something, or tell Slack something. You don't need this plugin for any of it. There are three inbound paths, and none of them involves code in this plugin:

1. **OpenClaw Gateway hooks**: `POST /hooks/wake`, `POST /hooks/agent`, and mapped `POST /hooks/<name>`.
2. **OpenClaw's bundled Webhooks plugin**: authenticated routes that create and drive TaskFlow records.
3. **Slack's own incoming webhook**: the `incoming-webhook` scope's `hooks.slack.com/services/...` URL.

This plugin deliberately doesn't add an HTTP listener of its own. OpenClaw core already runs one, and a second would duplicate it (see "Guiding principles" in `ROADMAP.md`).

Sources: the OpenClaw docs shipped in the `openclaw` package (`docs/automation/cron-jobs/webhooks.md`, `docs/gateway/config-hooks.md`, `docs/plugins/webhooks.md`, `docs/gateway/heartbeat.md`), and Slack's [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

## Pick one

| You want…                                                                            | Use                                            | Does an agent run?                                              | How it reaches Slack                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A short, trusted nudge to an agent ("the nightly import finished")                   | `POST /hooks/wake`                             | Yes, on its next or an immediate heartbeat, in its main session | Wherever that agent's heartbeat delivers (`heartbeat.target`: owner DM by default)           |
| An agent to act on an event and post the result in a specific Slack channel or DM    | `POST /hooks/agent` with `channel` + `to`      | Yes, an isolated turn by default                                | OpenClaw posts the reply itself (`channel: "slack"`, `to: "channel:C…"` or `"user:U…"`)      |
| The same, but the sender's payload shape is fixed (a vendor alert you can't reshape) | Mapped `POST /hooks/<name>` (`hooks.mappings`) | Yes, through a `wake` or `agent` action                         | Same as whichever action the mapping produces                                                |
| An external controller to track a multi-step job as TaskFlow state                   | Webhooks plugin route                          | **No**                                                          | It doesn't. Flow state lives in OpenClaw; any Slack message comes from whatever you run next |
| A plain message in one Slack channel, with no agent involved                         | Slack incoming webhook                         | No                                                              | Slack posts it directly; OpenClaw isn't in the path                                          |

For alerting ("page the channel when X breaks"), the usual answer is **`/hooks/agent` with a Slack destination** when you want the agent to look into the alert first, and a **Slack incoming webhook** when you only want the raw alert text in a channel.

## 1. Gateway hooks (`hooks.*`)

Disabled by default. A human enables them in the Gateway config (`hooks.enabled`, a dedicated `hooks.token`, `hooks.allowedAgentIds`). Agents working in this repo never edit `~/.openclaw/openclaw.json`. Every request is a JSON `POST` with `Authorization: Bearer <hooks.token>` (or `x-openclaw-token`). `?token=` is rejected. Callers outside the Gateway host need a reachable origin: loopback, a tailnet, or a trusted HTTPS reverse proxy (roadmap O-06 covers `lostgradient`'s public origin).

**`/hooks/wake`** takes `text` and an optional `mode` (`"now"`, the default, or `"next-heartbeat"`) and `agentId`. It queues a system event in the agent's main session and answers `200 { ok, mode, eventOutcome }`, where `eventOutcome` is `"queued"` or `"coalesced"`. It can't name a Slack destination; any message follows the agent's heartbeat delivery target. Wake text isn't safety-wrapped, so send only short text you control. Use it when the agent already has the context and just needs to know something happened.

**`/hooks/agent`** takes a required `message` and runs a full agent turn, isolated by default. Send `channel: "slack"` and `to` together (one without the other is a `400`), and OpenClaw posts the agent's reply there. The message is treated as external content and safety-wrapped, but that doesn't restrict the agent's tools, so point it at a restricted agent. Add an `Idempotency-Key` header so a retried alert replays the original run instead of starting another. The response never contains the reply text, even with `waitForCompletion: true`; it only reports status and delivery flags. [`workflow-builder-gateway-bridge.md`](workflow-builder-gateway-bridge.md) documents the full request and response shapes.

**Mapped hooks** (`POST /hooks/<name>`) match a custom path in `hooks.mappings`. A template or a trusted local transform turns the incoming payload into a `wake` or `agent` action, and a transform that returns `null` answers `204` without a run. Use one when the sender posts its own fixed JSON shape and can add a Bearer header but can't build `/hooks/agent`'s body.

## 2. Webhooks plugin (`plugins.entries.webhooks`)

Each configured route has its own `secret` (a plain string or a SecretRef, never `hooks.token`) and is bound to one `sessionKey`. The body is an action such as `create_flow`, `run_task`, `set_waiting`, `resume_flow`, `finish_flow`, or `fail_flow`. **None of these starts an agent.** `run_task` creates or links a task _record_; the external system stays the controller and advances the flow's state. The route rejects arbitrary provider payloads, URL-verification challenges, and provider HMAC signatures, so something like Zapier or n8n has to translate the event first.

Use it when an outside orchestrator owns a long-running, multi-step job and you want OpenClaw's TaskFlow records to mirror its state. Don't use it for alerts: nothing reaches Slack, and nothing runs, unless you also call `/hooks/agent` or let an agent act on the flow.

## 3. Slack incoming webhook (`incoming-webhook` scope)

Installing an app with the `incoming-webhook` scope makes Slack issue a `https://hooks.slack.com/services/...` URL bound to one channel picked at install time. POST `{ "text": "…" }` (optionally with `blocks`) and Slack posts it as the app. The URL is the credential, and it can only post to its one channel.

OpenClaw isn't in the path, so no agent reads, triages, or replies to the alert. Use it for fire-and-forget notifications where a human reads the raw text. This plugin has no tool that uses an incoming webhook and won't add one: every post it makes uses the bot token's `chat:write`, which can reach any channel the bot is in. The roadmap flags the app's `incoming-webhook` scope as removable for that reason (**Scope hygiene**, **O-11**). If you want an incoming webhook anyway, a separate small Slack app is a clean place for it.

## Not the same thing

- **Workflow Builder webhook triggers** (`hooks.slack.com/triggers/...`) start a Slack workflow. This plugin's `slack_workflow_trigger_run` tool calls them. They're outbound from OpenClaw, not inbound to it.
- **Internal hooks** (`HOOK.md` handlers, `docs/automation/hooks.md`) react to OpenClaw's own agent events and have no HTTP surface.
