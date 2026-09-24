import { Type } from "typebox";
import { callSlack, resolveToken, type SlackCallContext } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

/** Curated bookmark (see "Output shaping" in schemas.ts): Slack's carries ~15 bookkeeping fields. */
export const slackBookmark = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    link: Type.String(),
    emoji: Type.Optional(Type.String()),
    type: Type.String(),
  },
  { additionalProperties: false },
);

type RawBookmark = Record<string, unknown>;

function curateBookmark(raw: RawBookmark) {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    link: String(raw.link ?? ""),
    // Slack sends emoji:"" for bookmarks without one; drop it rather than echo noise.
    ...(typeof raw.emoji === "string" && raw.emoji ? { emoji: raw.emoji } : {}),
    type: String(raw.type ?? ""),
  };
}

/**
 * Add a link bookmark. Shared by `slack_bookmark_add` and `slack_channel_kickoff`.
 *
 * `type` stays hardcoded: Slack's bookmarks.add reference says `type` "Currently
 * accepts: `link`". It also lists `entity_id` (for "message and file types") and
 * error codes like `invalid_bookmark_type`, but documents no other type value.
 * Widen this only once Slack documents one.
 */
export async function addBookmark(
  token: string,
  { channelId, title, link, emoji }: { channelId: string; title: string; link: string; emoji?: string },
  context: SlackCallContext,
) {
  const body: Record<string, unknown> = {
    channel_id: channelId,
    title,
    type: "link",
    link,
  };
  if (emoji) body.emoji = emoji;
  const data = await callSlack("bookmarks.add", token, body, context);
  return data.bookmark ? curateBookmark(data.bookmark as RawBookmark) : null;
}

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
      return { bookmarks: ((data.bookmarks ?? []) as RawBookmark[]).map(curateBookmark) };
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
      return {
        bookmark: await addBookmark(resolveToken(config), { channelId, title, link, emoji }, context),
      };
    },
  }),

  tool({
    name: "slack_bookmark_edit",
    label: "Edit Slack bookmark",
    description:
      "Change a Slack channel bookmark's title, link, or emoji in place. Unlike remove and re-add, " +
      "the bookmark keeps its ID and position. Pass only the fields to change.",
    parameters: Type.Object({
      channelId: channelIdParam(),
      bookmarkId: Type.String({ description: "Bookmark ID from slack_bookmark_list." }),
      title: Type.Optional(Type.String({ description: "New bookmark title." })),
      link: Type.Optional(Type.String({ description: "New bookmark URL." })),
      emoji: Type.Optional(Type.String({ description: "New emoji shortcode, e.g. :books:." })),
    }),
    outputSchema: Type.Object(
      { bookmark: Type.Union([slackBookmark, Type.Null()]) },
      { additionalProperties: false },
    ),
    async execute({ channelId, bookmarkId, title, link, emoji }, config, context) {
      context.signal?.throwIfAborted();
      const changes = { title, link, emoji };
      const body: Record<string, unknown> = { channel_id: channelId, bookmark_id: bookmarkId };
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) body[key] = value;
      }
      if (Object.keys(body).length === 2) {
        throw new Error("Pass at least one of title, link, or emoji to change.");
      }
      const data = await callSlack("bookmarks.edit", resolveToken(config), body, context);
      return { bookmark: data.bookmark ? curateBookmark(data.bookmark as RawBookmark) : null };
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
