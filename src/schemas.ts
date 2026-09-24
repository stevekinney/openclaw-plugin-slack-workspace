import { Type } from "typebox";

const secretRefSchema = Type.Object({
  source: Type.String(),
  provider: Type.Optional(Type.String()),
  id: Type.String(),
});

export const configSchema = Type.Object(
  {
    botToken: Type.Optional(
      Type.Union([Type.String(), secretRefSchema], {
        description:
          "Slack bot token (xoxb-) or a SecretRef ({source,provider,id}). Falls back to SLACK_BOT_TOKEN.",
      }),
    ),
    userToken: Type.Optional(
      Type.Union([Type.String(), secretRefSchema], {
        description:
          "Slack user token (xoxp-) or a SecretRef. Required by search, which rejects bot tokens. Falls back to SLACK_USER_TOKEN.",
      }),
    ),
  },
  // Reject typo'd keys (e.g. `boToken`) at validation time instead of failing
  // later with a confusing "No Slack bot token" error.
  { additionalProperties: false },
);

/** Each domain module takes the `defineTool` helper and returns its tool definitions. */
export type { ToolFactory } from "./tool.js";

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

/**
 * Slack unfurls by default; the bundled channel plugin doesn't. Match it so a URL
 * in a table cell doesn't unfurl where the agent's ordinary replies wouldn't.
 */
export const unfurlParams = {
  unfurlLinks: Type.Optional(
    Type.Boolean({
      description: "Unfurl text-based links into previews. Default false. Ignored with updateTs.",
    }),
  ),
  unfurlMedia: Type.Optional(
    Type.Boolean({
      description: "Unfurl media links (images, video). Default false. Ignored with updateTs.",
    }),
  ),
};

export const replyBroadcastParam = Type.Optional(
  Type.Boolean({
    description:
      "With threadTs, also surface the reply in the parent channel. Ignored without threadTs or with updateTs.",
  }),
);

/** Where a structured post lands: a channel, optionally a thread, optionally in place. */
export const targetParams = {
  channelId: channelIdParam(),
  threadTs: threadTsParam,
  replyBroadcast: replyBroadcastParam,
  updateTs: Type.Optional(
    Type.String({
      description:
        "Timestamp of an existing message from this app to rewrite in place instead of posting a new one. Use this to keep one live card current.",
    }),
  ),
  ...unfurlParams,
};

export const postResultSchema = Type.Object(
  { channelId: Type.String(), ts: Type.String(), updated: Type.Boolean() },
  { additionalProperties: false },
);
