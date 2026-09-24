import { Type, type Static, type TSchema } from "typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import type { AutoJoinState, PluginConfig } from "./client.js";

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
};

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

/** Register each tool with `api.registerTool`, wrapping its result the way the host expects. */
export function registerTools(api: OpenClawPluginApi, tools: readonly ToolDefinition[]): void {
  const config = (api.pluginConfig ?? {}) as PluginConfig;
  for (const tool of tools) {
    api.registerTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      execute: async (toolCallId, params, signal, onUpdate) => {
        const autoJoin: AutoJoinState = { config, joined: new Set() };
        const result = withAutoJoined(
          await tool.execute(params as Static<TSchema>, config, {
            api,
            signal,
            toolCallId,
            onUpdate,
            autoJoin,
          }),
          autoJoin,
        );
        return typeof result === "string" ? textResult(result, result) : jsonResult(result);
      },
    });
  }
}
