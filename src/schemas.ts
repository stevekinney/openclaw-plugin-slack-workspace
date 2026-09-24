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
    workflowTriggers: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), secretRefSchema]), {
        description:
          "Workflow Builder webhook trigger URLs (https://hooks.slack.com/triggers/...) by name, each a string or a SecretRef, e.g. {\"standup\": {source,provider,id}}. The URL is the credential; slack_workflow_trigger_run starts a workflow by name.",
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

/**
 * Machine-readable data stamped on a message (`chat.postMessage`/`chat.update` `metadata`).
 * Slack silently drops metadata whose `event_type` isn't registered under the app
 * manifest's `metadata.event_subscriptions` — the call still returns `ok: true`.
 */
export const metadataParam = Type.Optional(
  Type.Object(
    {
      eventType: Type.String({
        pattern: "^[A-Za-z0-9_]+$",
        maxLength: 255,
        description:
          "Event type name, e.g. \"openclaw_card_v1\". Must be registered in the Slack app manifest's metadata.event_subscriptions, or Slack silently discards the metadata.",
      }),
      eventPayload: Type.Record(Type.String(), Type.Unknown(), {
        description: "JSON object to attach, e.g. {\"taskId\":\"T-1\",\"revision\":2}.",
      }),
    },
    {
      additionalProperties: false,
      description:
        "Optional machine-readable payload stamped on the message so it can be found and reconstructed later without parsing its text. Not shown to readers.",
    },
  ),
);

/** Slack's wire shape for `metadataParam`. */
export const toSlackMetadata = (metadata: { eventType: string; eventPayload: Record<string, unknown> }) => ({
  event_type: metadata.eventType,
  event_payload: metadata.eventPayload,
});

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
  metadata: metadataParam,
};

export const postResultSchema = Type.Object(
  { channelId: Type.String(), ts: Type.String(), updated: Type.Boolean() },
  { additionalProperties: false },
);
