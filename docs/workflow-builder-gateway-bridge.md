# Workflow Builder → OpenClaw Gateway bridge

This recipe lets a Slack Workflow Builder workflow hand a prompt to an OpenClaw agent. It posts to the Gateway's `POST /hooks/agent` endpoint, and OpenClaw delivers the agent's reply straight back into Slack. It needs no new Slack scopes and no code in this plugin.

> **Status: written from documentation, not yet run live.** `lostgradient` has no public Gateway origin today (`gateway.publicOrigin` is unset; that's roadmap **O-06**, a manual task), so Slack has nothing to reach. Live verification is tracked separately as roadmap **H-03** and can happen once O-06 is done.

## Two corrections to the original plan

The roadmap entry (H-01) described this as "Send a webhook step → Extract values from JSON → message step". Neither half of that holds up against the current docs:

1. **Workflow Builder has no built-in outbound HTTP step.** "Send a webhook" and "Extract values from JSON" came from [Workflow Buddy](https://github.com/happybara-io/WorkflowBuddy), a third-party app built on Slack's legacy *Steps from Apps* feature. Slack retired that feature on 2024-09-12. Today the supported way to add an outbound HTTP call to Workflow Builder is a **custom step** that a Slack app provides ([docs.slack.dev: Workflow steps](https://docs.slack.dev/workflows/workflow-steps/)). A connector step for a third-party automation service can also do it (see [Slack connectors for Workflow Builder](https://slack.com/help/articles/20155812595219-Slack-connectors-for-Workflow-Builder)).
2. **`/hooks/agent` never returns the agent's reply text.** With `waitForCompletion: true`, the response carries only completion facts: `status`, `replyDisposition` (`visible`/`silent`/`empty`), and delivery flags. OpenClaw's hook reference says outright that "Provider, runtime, model, target, session, diagnostic, output, and summary details are never returned." So no downstream step can extract the answer from JSON. Instead, the request names a Slack destination (`channel` + `to`), and OpenClaw posts the reply there itself.

The working recipe is:

```text
Workflow trigger (webhook, link, form, …)
  → custom step "Ask OpenClaw": POST {publicOrigin}/hooks/agent  (Bearer hooks.token)
       body: { message, agentId, channel: "slack", to: "channel:C…", waitForCompletion }
  → OpenClaw runs the agent and posts the reply to the Slack channel itself
  → optional: "Send a message" step that reports the step's status outputs
```

## What each side expects

### OpenClaw Gateway: `POST /hooks/agent`

Source: the OpenClaw docs shipped in the `openclaw` package (`docs/automation/cron-jobs/webhooks.md` and `docs/gateway/config-hooks.md`).

**Enable hooks.** A human merges this into the Gateway config. Agents working in this repo never edit `~/.openclaw/openclaw.json`.

```json5
{
  hooks: {
    enabled: true,
    token: "<long-random-hook-token>", // dedicated; not the Gateway auth token
    path: "/hooks",
    allowedAgentIds: ["main"],
    allowRequestSessionKey: false,
  },
}
```

`hooks.token` is a plain string; SecretRef objects aren't supported there. It must differ from `gateway.auth.token`, and `openclaw security audit` reports reuse as a critical finding. Then run `openclaw config validate` and `openclaw gateway restart`.

**Request.**

- `POST https://<public-origin>/hooks/agent`
- `Authorization: Bearer <hooks.token>` (or `x-openclaw-token: <hooks.token>`). A `?token=` query parameter is rejected with `400`.
- `Content-Type: application/json`, body at most 256 KiB, sent within 30 seconds.
- Optional `Idempotency-Key: <string ≤ 256 chars>`. A retry with the same key and payload replays the original run instead of starting another one.

| Field               | Use in this recipe                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`           | **Required.** The prompt, built from workflow variables. OpenClaw treats it as external content and safety-wraps it.                                                                                   |
| `name`              | Label for logs and completion events, e.g. `"Workflow: triage request"`.                                                                                                                               |
| `agentId`           | The target agent; must be listed in `hooks.allowedAgentIds`.                                                                                                                                           |
| `channel` + `to`    | Where OpenClaw posts the reply: `"slack"` plus `"channel:C12345678"` or `"user:U12345678"`. You must send both or neither; sending one returns `400`. `"last"` isn't allowed on direct `/hooks/agent`. |
| `accountId`         | Only if the Slack channel plugin has more than one account configured.                                                                                                                                 |
| `waitForCompletion` | `true` holds the HTTP response open until the run settles and adds `completion`; `false` (the default) returns as soon as the run is admitted.                                                         |
| `sessionMode`       | Leave it at `"isolated"` (the default), so each workflow run gets fresh context.                                                                                                                       |
| `timeoutSeconds`    | Optional cap on the agent turn.                                                                                                                                                                        |
| `deliver`           | Leave it at the default `true`. `false` suppresses the reply post, which defeats the purpose.                                                                                                          |

**Responses.**

```jsonc
// waitForCompletion omitted or false: 200 once the run is admitted (≤ 15 s)
{ "ok": true, "runId": "<hook-request-run-id>" }

// waitForCompletion: true — 200 once the run settles
{
  "ok": true,
  "runId": "<hook-request-run-id>",
  "completion": {
    "status": "ok",              // "ok" | "error" | "skipped"
    "replyDisposition": "visible", // "visible" | "silent" | "empty"
    "delivered": true,
    "deliveryAttempted": true
    // optional: "deliveryError": "delivery-failed",
    //           "deliverySuppressionReason": "empty" | "silent" | "heartbeat" | "channel_transform"
  }
}
```

Failures after admission, such as the model erroring or delivery failing, still come back as HTTP `200` with details in `completion`. Only admission failures use non-2xx statuses: `400` bad payload or routing, `401` bad token, `404` hooks disabled or wrong path, `409` session conflict, `413` body too large, `429` repeated failed authentication (honor `Retry-After`), and `502`/`503` for preparation failure, no admission within 15 seconds, or a restarting Gateway. Admission errors are `{ "ok": false, "error": "…" }`, but early method, auth, and path errors can be plain text, so don't assume every error body is JSON.

### Slack: Workflow Builder

Sources: [Create a workflow that starts outside of Slack](https://slack.com/help/articles/360041352714-Build-a-workflow--Create-a-workflow-that-starts-outside-of-Slack) and [Workflow steps](https://docs.slack.dev/workflows/workflow-steps/).

- **Webhook trigger.** It accepts a flat JSON `POST` with up to 20 variables, each typed as text, user ID, user email, or channel ID. Nested JSON isn't supported, and a trigger accepts one request per second. The trigger URL is itself the credential. This plugin's `slack_workflow_trigger_run` tool starts these triggers (see the README's "Workflow triggers" section). Any other trigger (link, form, emoji reaction, schedule) works for this recipe too.
- **Custom step.** A Slack app declares a function (`callback_id`, `input_parameters`, `output_parameters`) in its manifest, subscribes to the `function_executed` bot event, and finishes each run by calling `functions.completeSuccess` with outputs or `functions.completeError` with a message. In Bolt, the `complete()` and `fail()` helpers passed to an `app.function()` handler wrap those two Web API methods, which is what the example below uses. The step then shows up in Workflow Builder's step library, and its outputs become variables for later steps. Custom steps need a paid Slack plan.

## Step by step

### 1. Prerequisites (human, outside this repo)

1. **Public HTTPS origin for the Gateway (O-06).** Slack's servers or your step's host must reach `https://<origin>/hooks/agent`. Expose only the hooks path, using a reverse proxy or tunnel with TLS. OpenClaw's docs say to keep hook endpoints behind loopback, a tailnet, or a trusted reverse proxy.
2. **Enable hooks** with the config above, and use a hook token dedicated to this bridge.
3. **Pick or create a restricted agent** for this bridge. Hook content is safety-wrapped, but that doesn't remove tools or workspace access. Anyone who can start the workflow can send this agent text, so give it only the tools the workflow needs.
4. **Know the destination.** Get the Slack channel ID (right-click the channel → **Copy link**; the ID is the `C…` value at the end of the URL). The OpenClaw Slack bot must be a member of that channel so it can post there.

### 2. Build the "Ask OpenClaw" custom step (a small Slack app)

The bundled OpenClaw Slack channel plugin owns the OpenClaw app's Socket Mode connection, and this tool plugin can't register a `function_executed` handler. So the custom step lives in a **separate small Slack app**. The hook token lives in that app's environment, never in Workflow Builder, which has no secret storage.

Manifest excerpt:

```yaml
settings:
  event_subscriptions:
    bot_events:
      - function_executed
  function_runtime: remote
functions:
  ask_openclaw:
    title: Ask OpenClaw
    description: Send a prompt to an OpenClaw agent; the agent replies in the chosen channel
    input_parameters:
      prompt:
        type: string
        title: Prompt
        is_required: true
      reply_channel:
        type: slack#/types/channel_id
        title: Reply in channel
        is_required: true
    output_parameters:
      status:
        type: string
        title: Run status
      run_id:
        type: string
        title: OpenClaw run ID
      reply_disposition:
        type: string
        title: Reply disposition
```

Handler (Bolt for JavaScript; illustrative, not code this plugin ships):

```js
app.function("ask_openclaw", async ({ inputs, body, complete, fail }) => {
  const response = await fetch(`${process.env.OPENCLAW_ORIGIN}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENCLAW_HOOKS_TOKEN}`,
      "Content-Type": "application/json",
      // One Workflow Builder execution = one OpenClaw run, even if this handler retries.
      "Idempotency-Key": body.event.function_execution_id,
    },
    body: JSON.stringify({
      message: inputs.prompt,
      name: "Workflow Builder: Ask OpenClaw",
      agentId: "main",
      channel: "slack",
      to: `channel:${inputs.reply_channel}`,
      waitForCompletion: true,
    }),
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = undefined; // early auth/path errors can be plain text
  }

  if (!response.ok || !result?.ok) {
    await fail({ error: `OpenClaw hook failed: HTTP ${response.status}` });
    return;
  }

  await complete({
    outputs: {
      status: result.completion?.status ?? "admitted",
      run_id: result.runId,
      reply_disposition: result.completion?.replyDisposition ?? "unknown",
    },
  });
});
```

The error message deliberately leaves out the response body and the token. Don't let either end up in workflow activity logs.

**`waitForCompletion` or not?** With `true`, the step's outputs report whether the run finished and whether a reply was posted, and the step stays open for the whole agent turn. With `false`, the step completes within about 15 seconds of admission and `status` reads `admitted`. The reply still arrives in the channel either way, because OpenClaw posts it. Use `false` if agent turns might run longer than Slack lets a custom step stay open. This recipe hasn't verified Slack's limit on how long a custom step can stay open; it's part of H-03.

Install the app to the workspace. The step then appears in Workflow Builder's step library under the app's name.

### 3. Build the workflow in Workflow Builder

1. **New workflow → Choose an event.** Pick a trigger. For a webhook trigger, choose **From a webhook**, add the variables you need (for example `request` as text and `requester` as a user ID), then click **Done** and **Continue**. Copy the generated URL. To start the workflow from OpenClaw, add that URL to this plugin's `workflowTriggers` config under a name.
2. **Add step → [your app] → Ask OpenClaw.**
   - **Prompt:** compose it from variables, e.g. `Triage this request from {requester}: {request}`.
   - **Reply in channel:** pick the channel from prerequisite 4.
3. **Optional: Add step → Messages → Send a message to a channel.** Report the outputs from step 2, e.g. `OpenClaw run {run_id}: {status} ({reply_disposition})`. Leave it out if the agent's own reply is enough.
4. **Publish.**

### 4. Check it works (after O-06; tracked as H-03)

1. Start the workflow from its trigger. For a webhook trigger, POST a small flat JSON body to the trigger URL (at most one request per second).
2. On the Gateway host, run `openclaw logs --follow` and look for `hook agent run completed` with the `runId` from the step output.
3. Confirm the agent's reply shows up in the destination channel.
4. If it doesn't:
   - `401`: wrong or missing hook token.
   - `404`: hooks disabled or `hooks.path` mismatch.
   - `400` mentioning delivery: `channel`/`to` incomplete or malformed.
   - `status: "ok"` with `delivered: false`: check the log for `deliveryError`, and check that the OpenClaw bot is in the channel.
   - `replyDisposition: "silent"` or `"empty"`: the agent chose not to reply, so there was nothing to post.

## Security notes

- The workflow's trigger URL and the hook token both grant access. Anyone who can start the workflow can send text to the agent. Restrict who can run the workflow and what the agent's tools can do.
- The hook token sits only in the custom-step app's environment. Never put it in Workflow Builder fields, workflow variables, or messages.
- Keep `hooks.allowRequestSessionKey: false` and `hooks.allowedAgentIds` narrow.
- Treat everything the workflow forwards as untrusted input. Never set `allowUnsafeExternalContent`.
