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
    autoJoin: Type.Optional(
      Type.Boolean({
        description:
          "When a bot-token call fails with not_in_channel on a public channel, join it once and retry. Default true.",
      }),
    ),
    autoJoinDeny: Type.Optional(
      Type.Array(Type.String(), {
        description: "Channel IDs the bot must never auto-join, e.g. [\"C0123ABCD\"].",
      }),
    ),
  },
  // Reject typo'd keys (e.g. `boToken`) at validation time instead of failing
  // later with a confusing "No Slack bot token" error.
  { additionalProperties: false },
);

/**
 * Output shaping convention. Every tool declares an `outputSchema`, and a tool
 * that returns Slack data picks one of two shapes:
 *
 * - Curate (the default): map Slack's object to the few fields the agent acts on,
 *   in camelCase, with `additionalProperties: false`. Do this whenever the raw
 *   object is large or noisy, or carries fields the agent has no use for
 *   (ranks, audit user/team IDs, icon URLs, rendering internals). Examples:
 *   `slack_search`, `slack_scheduled_list`, `slack_bookmark_*`, `slack_canvas_sections`.
 * - Pass through: return Slack's value verbatim, typed `Type.Unknown()` or a
 *   string-keyed record, only when it is small and every field is useful, or when
 *   its structure is the point (e.g. Slack's `paging` object). Say so in the schema.
 *
 * Curated fields keep Slack's values but drop empty ones Slack uses as "unset"
 * (e.g. `emoji: ""`) by omitting the key.
 */

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
