import { Type } from "typebox";
import type { DefineToolPluginOptions } from "openclaw/plugin-sdk/tool-plugin";

const secretRefSchema = Type.Object({
  source: Type.String(),
  provider: Type.Optional(Type.String()),
  id: Type.String(),
});

export const configSchema = Type.Object({
  botToken: Type.Optional(
    Type.Union([Type.String(), secretRefSchema], {
      description:
        "Slack bot token (xoxb-) or a SecretRef ({source,provider,id}). Falls back to SLACK_BOT_TOKEN.",
    }),
  ),
  userToken: Type.Optional(
    Type.Union([Type.String(), secretRefSchema], {
      description:
        "Slack user token (xoxp-) or a SecretRef. Required by search and reminders, which reject bot tokens. Falls back to SLACK_USER_TOKEN.",
    }),
  ),
});

/**
 * The `tool` helper `defineToolPlugin` hands to its `tools` callback, typed for this
 * plugin's config. Each domain module takes one and returns its tool definitions.
 */
export type ToolFactory = Parameters<DefineToolPluginOptions<typeof configSchema>["tools"]>[0];

export const CHANNEL_ID_DESCRIPTION = "Channel or DM ID, e.g. C0C42LZQZGQ or D0B9DMSCL58.";

/**
 * The one `channelId` parameter every tool shares. `note` adds tool-specific context
 * after the canonical wording instead of replacing it.
 */
export const channelIdParam = (note?: string) =>
  Type.String({ description: note ? `${CHANNEL_ID_DESCRIPTION} ${note}` : CHANNEL_ID_DESCRIPTION });

export const threadTsParam = Type.Optional(
  Type.String({ description: "Post as a reply to this message timestamp." }),
);

const blockSchema = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "One Block Kit block object, e.g. {\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*hi*\"}}.",
});

export const blocksSchema = Type.Array(blockSchema, {
  minItems: 1,
  maxItems: 50,
  description:
    "Block Kit blocks, passed to Slack verbatim. Supports every block type the workspace allows, including ones OpenClaw's portable `presentation` cannot express: section, header, actions, context, divider, image, input, rich_text, table, video, and the newer card/carousel/alert families. Max 50 blocks.",
});

/** Where a structured post lands: a channel, optionally a thread, optionally in place. */
export const targetParams = {
  channelId: channelIdParam(),
  threadTs: threadTsParam,
  updateTs: Type.Optional(
    Type.String({
      description:
        "Timestamp of an existing message from this app to rewrite in place instead of posting a new one. Use this to keep one live card current.",
    }),
  ),
};

export const postResultSchema = Type.Object(
  { channelId: Type.String(), ts: Type.String(), updated: Type.Boolean() },
  { additionalProperties: false },
);
