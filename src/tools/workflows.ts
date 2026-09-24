import { Type } from "typebox";
import type { PluginConfig } from "../client.js";
import type { ToolFactory } from "../schemas.js";

/** Longest slice of an error response body worth quoting back to the agent. */
const MAX_ERROR_BODY = 200;

/**
 * The webhook URL configured for `name`. The URL is the credential (anyone holding it
 * can start the workflow), so it's resolved like `resolveToken` and never echoed.
 */
function resolveTriggerUrl(config: PluginConfig, name: string): string {
  const triggers = config.workflowTriggers ?? {};
  const names = Object.keys(triggers);
  if (names.length === 0) {
    throw new Error(
      "No workflow triggers configured. Create a webhook trigger in Workflow Builder and add its URL under plugins.entries.slack-workspace.config.workflowTriggers.<name> (SecretRef).",
    );
  }
  if (!Object.hasOwn(triggers, name)) {
    throw new Error(`No workflow trigger named "${name}". Configured: ${names.join(", ")}.`);
  }
  const configured = triggers[name];
  if (typeof configured !== "string") {
    throw new Error(
      `Workflow trigger "${name}" SecretRef was not resolved by the host. Check the secret store entry and run \`openclaw secrets reload\`.`,
    );
  }
  const url = configured.trim();
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
    throw new Error(
      `Workflow trigger "${name}" must be an https URL, e.g. https://hooks.slack.com/triggers/... Check plugins.entries.slack-workspace.config.workflowTriggers.${name}.`,
    );
  }
  return url;
}

/** Slack answers with JSON (`{"ok":true}`); fall back to the raw text otherwise. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const workflowTools = (tool: ToolFactory) => [
  tool({
    name: "slack_workflow_trigger_run",
    label: "Run Slack workflow",
    description:
      "Start a Slack Workflow Builder workflow by the name it's configured under in workflowTriggers. The payload fills the webhook trigger's variables, which the workflow defines in Workflow Builder; send each value as a string. Only workflows with a configured webhook trigger can be started.",
    parameters: Type.Object({
      name: Type.String({
        minLength: 1,
        description: "The trigger's configured name, e.g. \"standup\".",
      }),
      payload: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "JSON body for the webhook, keyed by the trigger's variable names, e.g. {\"owner\":\"U0123ABCD\",\"topic\":\"Q3 plan\"}. Default {}.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        name: Type.String(),
        status: Type.Integer({ description: "HTTP status Slack returned." }),
        response: Type.Unknown({
          description: "Slack's response body, passed through: parsed JSON, or text if it isn't JSON.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute({ name, payload = {} }, config, context) {
      context.signal?.throwIfAborted();
      const url = resolveTriggerUrl(config, name);
      const started = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: context.signal,
      });
      const text = await response.text();
      const outcome = response.ok ? "ok" : `error=http_${response.status}`;
      // Log the configured name only: the URL is the secret.
      const message = `slack-workspace: workflow trigger ${name} ${outcome} in ${Date.now() - started}ms`;
      if (response.ok) context.api.logger.info(message);
      else {
        context.api.logger.warn(message);
        throw new Error(
          `Workflow trigger "${name}" failed: http_${response.status} ${text.slice(0, MAX_ERROR_BODY)}`.trim(),
        );
      }
      return { name, status: response.status, response: parseBody(text) };
    },
  }),
];
