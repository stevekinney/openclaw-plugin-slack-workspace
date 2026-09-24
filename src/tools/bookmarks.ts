import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

/** Slack's bookmark object, passed through as-is (id, title, link, emoji, ...). */
const slackBookmark = Type.Record(Type.String(), Type.Unknown());

export const bookmarkTools = (tool: ToolFactory) => [
  tool({
    name: "slack_bookmark_list",
    label: "List Slack bookmarks",
    description: "List the bookmarks pinned to a Slack channel.",
    parameters: Type.Object({
      channelId: channelIdParam(),
    }),
    outputSchema: Type.Object(
      { bookmarks: Type.Array(slackBookmark) },
      { additionalProperties: false },
    ),
    async execute({ channelId }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const data = await callSlack(
        "bookmarks.list",
        token,
        { channel_id: channelId },
        context,
      );
      return { bookmarks: data.bookmarks ?? [] };
    },
  }),

  tool({
    name: "slack_bookmark_add",
    label: "Add Slack bookmark",
    description: "Add a link bookmark to a Slack channel. Channels are limited to 100 bookmarks.",
    parameters: Type.Object({
      channelId: channelIdParam(),
      title: Type.String({ description: "Bookmark title." }),
      link: Type.String({ description: "Bookmark URL." }),
      emoji: Type.Optional(Type.String({ description: "Emoji shortcode, e.g. :books:." })),
    }),
    outputSchema: Type.Object(
      { bookmark: Type.Union([slackBookmark, Type.Null()]) },
      { additionalProperties: false },
    ),
    async execute({ channelId, title, link, emoji }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const body: Record<string, unknown> = {
        channel_id: channelId,
        title,
        type: "link",
        link,
      };
      if (emoji) body.emoji = emoji;
      const data = await callSlack("bookmarks.add", token, body, context);
      return { bookmark: data.bookmark ?? null };
    },
  }),

  tool({
    name: "slack_bookmark_remove",
    label: "Remove Slack bookmark",
    description: "Remove a bookmark from a Slack channel.",
    parameters: Type.Object({
      channelId: channelIdParam(),
      bookmarkId: Type.String({ description: "Bookmark ID from slack_bookmark_list." }),
    }),
    outputSchema: Type.Object(
      { removed: Type.Literal(true), bookmarkId: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, bookmarkId }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await callSlack(
        "bookmarks.remove",
        token,
        { channel_id: channelId, bookmark_id: bookmarkId },
        context,
      );
      return { removed: true, bookmarkId };
    },
  }),
];

/** Slack has no bookmark undo; a removed bookmark has to be re-added by hand. */
export const bookmarkApprovals: ApprovalRule[] = [
  {
    toolName: "slack_bookmark_remove",
    check: ({ channelId, bookmarkId }) => ({
      title: "Remove Slack bookmark",
      description: `Remove bookmark ${bookmarkId} from channel ${channelId}. This cannot be undone.`,
      target: `channel ${channelId}`,
    }),
  },
];
