import { Type } from "typebox";
import type { PluginConfig } from "../client.js";
import { defineTool, type ToolContext } from "../tool.js";
import type { InteractionPreparation } from "../interactions.js";
import { activeChannelIdParam } from "../schemas.js";

const preparation = Type.Object(
  {
    kind: Type.Union([Type.Literal("modal"), Type.Literal("options")]),
    channelId: activeChannelIdParam(),
    userId: Type.Optional(Type.String({ maxLength: 256 })),
    channelType: Type.Optional(Type.Union([Type.Literal("im"), Type.Literal("mpim"), Type.Literal("channel"), Type.Literal("group")])),
    view: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    options: Type.Optional(Type.Array(Type.Object({ text: Type.Object({ type: Type.Literal("plain_text"), text: Type.String({ maxLength: 75 }) }, { additionalProperties: false }), value: Type.String({ minLength: 1, maxLength: 150 }) }, { additionalProperties: false }), { maxItems: 100 })),
  },
  { additionalProperties: false },
);

export const interactionTools = (tool: typeof defineTool) => [
  tool({
    name: "slack_interaction_prepare",
    label: "Prepare Slack interaction",
    description: "Prepare a bounded Slack modal or external-select options interaction. The returned opaque action ID must be attached to the corresponding Block Kit control; callbacks are handled synchronously by the host.",
    parameters: preparation,
    outputSchema: Type.Object({ actionId: Type.String(), reference: Type.String(), expiresAt: Type.Number() }, { additionalProperties: false }),
    async execute(params, _config: PluginConfig, context) {
      const prepareInteraction = context.prepareInteraction;
      if (!prepareInteraction) throw new Error("Slack interactions are unavailable: routing is disabled or the host has no interactive handler support.");
      return prepareInteraction(params as InteractionPreparation);
    },
  }),
];
