import { Type, type Static, type TSchema } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { AutoJoinState, PluginConfig, SlackCallContext, SlackResponse } from "./client.js";
import type { InteractionPreparation, PreparedInteraction } from "./interactions.js";

/** What a tool's `execute` receives besides its parameters and the plugin config. */
export type ToolContext = {
  /** Plugin runtime API, for logging and other OpenClaw services. */
  api: OpenClawPluginApi;
  /** Aborts when the host cancels this tool call. */
  signal?: AbortSignal;
  /** Stable id of the current model tool call. */
  toolCallId: string;
  /** Streams partial results back to the host. */
  onUpdate?: Parameters<AnyAgentTool["execute"]>[3];
  /** Channels this call auto-joined; see `callSlackRaw`. */
  autoJoin: AutoJoinState;
  /**
   * Slack conversation of the active inbound turn, from the host's trusted
   * `nativeChannelId`. Unset outside a Slack turn (cron, automations, other channels).
   */
  activeChannelId?: string;
  onSlackResponse?: SlackCallContext["onSlackResponse"];
  prepareSlackRequest?: SlackCallContext["prepareSlackRequest"];
  prepareInteraction?: (input: InteractionPreparation) => Promise<PreparedInteraction>;
};

/**
 * The Slack conversation the host says this turn came from. `nativeChannelId` is
 * platform-native, so a Discord or Telegram turn's ID must not be read as a Slack one.
 */
export function activeSlackChannelId(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel?.trim().toLowerCase() !== "slack") return undefined;
  return ctx.nativeChannelId?.trim() || undefined;
}

/**
 * The explicit `channelId`, or the active Slack turn's conversation when it is omitted.
 * Out of turn there is nothing to default to, so the call fails before reaching Slack.
 */
export function resolveChannelId(channelId: string | undefined, context: ToolContext): string {
  const resolved = channelId?.trim() || context.activeChannelId;
  if (!resolved) {
    throw new Error(
      "channelId is required: this call is not running inside a Slack conversation, so there is no current channel to default to.",
    );
  }
  return resolved;
}

export type ToolDefinition<TParams extends TSchema = TSchema> = {
  /** Model-facing tool name; must also appear in the manifest's `contracts.tools`. */
  name: string;
  /** Human-facing label; defaults to `name`. */
  label?: string;
  description: string;
  parameters: TParams;
  /** Schema for the JSON value returned in `details`. */
  outputSchema?: TSchema;
  /** Return plain text or a JSON-serializable value. */
  execute: (params: Static<TParams>, config: PluginConfig, context: ToolContext) => unknown;
};

const autoJoinedSchema = Type.Optional(
  Type.Literal(true, {
    description:
      "Present when the bot joined a public channel during this call to complete it; it is now a member.",
  }),
);

/** Any object result may carry `autoJoined`, so every object output schema allows it. */
function allowAutoJoined(schema: TSchema): TSchema {
  const object = schema as TSchema & { type?: unknown; properties?: Record<string, TSchema> };
  if (object.type !== "object" || !object.properties) return schema;
  return { ...object, properties: { ...object.properties, autoJoined: autoJoinedSchema } };
}

/**
 * Declare one tool. Keeps the `execute(params, config, context)` shape the tools were
 * written against under `defineToolPlugin`, while inferring `params` from the schema.
 */
export const defineTool = <TParams extends TSchema>(definition: ToolDefinition<TParams>) =>
  (definition.outputSchema
    ? { ...definition, outputSchema: allowAutoJoined(definition.outputSchema) }
    : definition) as unknown as ToolDefinition;

/** Tell the agent it joined a channel along the way, so it knows it is now a member. */
function withAutoJoined(result: unknown, autoJoin: AutoJoinState): unknown {
  if (autoJoin.joined.size === 0) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, autoJoined: true };
  }
  return result;
}

export type ToolFactory = typeof defineTool;

type SecretResolver = typeof resolveConfiguredSecretInputString;

/** Plugin config is authored config, not the prepared Gateway snapshot. Resolve only
 * configured refs at execution time; never retain a resolved credential globally. */
export async function resolveToolConfig(
  config: PluginConfig,
  hostConfig: OpenClawPluginApi["config"],
  resolve: SecretResolver = resolveConfiguredSecretInputString,
): Promise<PluginConfig> {
  const resolved: PluginConfig = { ...config };
  for (const field of ["botToken", "userToken"] as const) {
    const value = config[field];
    if (!value || typeof value === "string") continue;
    const result = await resolve({
      config: hostConfig,
      env: process.env,
      value,
      path: `plugins.entries.slack-workspace.config.${field}`,
    });
    if (result.value) resolved[field] = result.value;
  }
  if (config.workflowTriggers) {
    resolved.workflowTriggers = { ...config.workflowTriggers };
    for (const [name, value] of Object.entries(config.workflowTriggers)) {
      if (typeof value === "string") continue;
      const result = await resolve({
        config: hostConfig,
        env: process.env,
        value,
        path: `plugins.entries.slack-workspace.config.workflowTriggers.${name}`,
      });
      if (result.value) resolved.workflowTriggers[name] = result.value;
    }
  }
  return resolved;
}

/**
 * Register each tool with `api.registerTool`, wrapping its result the way the host expects.
 * Each is a factory so it sees the active turn (see `ToolContext.activeChannelId`).
 */
export type ToolIntegrations = {
  observeResponse?: (
    context: OpenClawPluginToolContext,
    method: string,
    body: Record<string, unknown>,
    response: SlackResponse,
    configuration: PluginConfig,
  ) => Promise<void>;
  prepareRequest?: (
    context: OpenClawPluginToolContext,
    method: string,
    body: Record<string, unknown>,
    configuration: PluginConfig,
  ) => Promise<Record<string, unknown>>;
  prepareInteraction?: (
    context: OpenClawPluginToolContext,
    input: InteractionPreparation,
    configuration: PluginConfig,
  ) => Promise<PreparedInteraction>;
};

export function registerTools(
  api: OpenClawPluginApi,
  tools: readonly ToolDefinition[],
  integrations: ToolIntegrations = {},
): void {
  const config = (api.pluginConfig ?? {}) as PluginConfig;
  for (const tool of tools) {
    api.registerTool(
      (ctx) => {
        const activeChannelId = activeSlackChannelId(ctx);
        return {
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          execute: async (toolCallId, params, signal, onUpdate) => {
            const executionConfig = await resolveToolConfig(config, api.config ?? {});
            const autoJoin: AutoJoinState = { config: executionConfig, joined: new Set() };
            let routingWarning = false;
            const result = withAutoJoined(
              await tool.execute(params as Static<TSchema>, executionConfig, {
                api,
                signal,
                toolCallId,
                onUpdate,
                autoJoin,
                ...(integrations.observeResponse ? {
                  onSlackResponse: async (method: string, body: Record<string, unknown>, response: SlackResponse) => {
                    try {
                      await integrations.observeResponse!(ctx, method, body, response, executionConfig);
                    } catch {
                      routingWarning = true;
                      api.logger.warn("slack-workspace: Slack committed an operation but routing bookkeeping failed; do not repeat the operation.");
                    }
                  },
                } : {}),
                ...(integrations.prepareRequest ? { prepareSlackRequest: (method: string, body: Record<string, unknown>) => integrations.prepareRequest!(ctx, method, body, executionConfig) } : {}),
                ...(integrations.prepareInteraction ? { prepareInteraction: (input: InteractionPreparation) => integrations.prepareInteraction!(ctx, input, executionConfig) } : {}),
                ...(activeChannelId ? { activeChannelId } : {}),
              }),
              autoJoin,
            );
            const output = typeof result === "string" ? textResult(result, result) : jsonResult(result);
            if (routingWarning) output.content.push({ type: "text", text: "Slack committed the operation, but its reply-routing association could not be saved. Do not resend or repeat the operation." });
            return output;
          },
        };
      },
      { name: tool.name },
    );
  }
}
