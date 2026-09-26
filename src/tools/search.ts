import { Type } from "typebox";
import { callSlack, resolveToken, SlackApiError } from "../client.js";
import type { ToolFactory } from "../schemas.js";

/** Block-only messages match on indexed block text but return text:"". */
function legacyMessageText(match: Record<string, unknown>): string {
  // Fall back to an attachment fallback so the hit isn't blank.
  return (
    (match.text as string) ||
    (match.attachments as { fallback?: string }[] | undefined)?.[0]?.fallback ||
    "(no plain text — Block Kit message; open the permalink)"
  );
}

/**
 * Errors that mean Real-time Search is unavailable to this token or workspace, rather
 * than that the query was bad. Each one falls back to the legacy `search.messages`.
 */
const CONTEXT_FALLBACK_ERRORS = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "unknown_method",
  "feature_not_enabled",
  "assistant_search_context_disabled",
]);

const ALL_CHANNEL_TYPES = ["public_channel", "private_channel", "mpim", "im"] as const;

const contextMessageSchema = Type.Object(
  {
    ts: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type Raw = Record<string, unknown>;

/** Copy the defined values only, so "unset" fields are omitted rather than `undefined`. */
const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ""));

const contextMessage = (message: Raw) =>
  defined({ ts: message.ts, userId: message.user_id, text: message.text });

function contextHit(hit: Raw) {
  const context = hit.context_messages as { before?: Raw[]; after?: Raw[] } | undefined;
  return defined({
    channelId: hit.channel_id,
    channelName: hit.channel_name,
    ts: hit.message_ts,
    userId: hit.author_user_id,
    userName: hit.author_name,
    isBot: hit.is_author_bot,
    text: hit.content,
    permalink: hit.permalink,
    context: context
      ? {
          before: (context.before ?? []).map(contextMessage),
          after: (context.after ?? []).map(contextMessage),
        }
      : undefined,
  });
}

function legacyHit(match: Raw) {
  const channel = match.channel as { id?: string; name?: string } | string | undefined;
  return defined({
    channelId: typeof channel === "string" ? channel : channel?.id,
    channelName: typeof channel === "string" ? undefined : channel?.name,
    ts: match.ts,
    userId: match.user,
    userName: match.username,
    text: legacyMessageText(match),
    permalink: match.permalink,
  });
}

export const searchTools = (tool: ToolFactory) => [
  tool({
    name: "slack_search",
    label: "Search Slack",
    description:
      "Keyword search over Slack messages or files as the authorizing user (legacy search.messages/search.files). For questions like \"what did we decide about X?\", prefer slack_search_context, which ranks by meaning and returns surrounding messages. Use this tool for exact keyword or modifier queries and numbered paging. Covers every private channel, group, and DM that user belongs to — not just what the bot was invited to. Supports Slack's search modifiers: in:#channel, from:@user, before:2026-09-01, has:link.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query. Slack modifiers work: `in:#ai-development`, `from:@steve`, `during:September`, `has:pin`.",
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("messages"), Type.Literal("files")], {
          description: "What to search. Default: messages.",
        }),
      ),
      count: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Results per page. Default 20." }),
      ),
      page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number. Default 1." })),
      sort: Type.Optional(
        Type.Union([Type.Literal("score"), Type.Literal("timestamp")], {
          description: "Rank by relevance (score) or recency (timestamp). Default: score.",
        }),
      ),
      sortDir: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
          description: "Sort direction. Default: desc.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        query: Type.String(),
        scope: Type.Union([Type.Literal("messages"), Type.Literal("files")]),
        total: Type.Number(),
        paging: Type.Unknown({ description: "Slack's paging object, or null." }),
        matches: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description:
            "Message hits: ts, text, user, username, channel, permalink. File hits: id, name, title, filetype, user, created, permalink.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute({ query, scope, count, page, sort, sortDir }, config, context) {
      context.signal?.throwIfAborted();
      const searchFiles = scope === "files";
      const data = await callSlack(
        searchFiles ? "search.files" : "search.messages",
        // search.* rejects bot tokens outright.
        resolveToken(config, "user"),
        {
          query,
          count: count ?? 20,
          page: page ?? 1,
          sort: sort ?? "score",
          sort_dir: sortDir ?? "desc",
        },
        context,
        true,
      );

      const result = (searchFiles ? data.files : data.messages) as
        | { total?: number; paging?: unknown; matches?: Record<string, unknown>[] }
        | undefined;
      const matches = result?.matches ?? [];

      // Slack match objects are large and mostly irrelevant; keep what identifies a hit.
      return {
        query,
        scope: searchFiles ? "files" : "messages",
        total: result?.total ?? 0,
        paging: result?.paging ?? null,
        matches: matches.map((match) =>
          searchFiles
            ? {
                id: match.id,
                name: match.name,
                title: match.title,
                filetype: match.filetype,
                user: match.user,
                created: match.created,
                permalink: match.permalink,
              }
            : {
                ts: match.ts,
                text: legacyMessageText(match),
                user: match.user,
                username: match.username,
                channel: (match.channel as { id?: string; name?: string } | undefined)?.name
                  ? {
                      id: (match.channel as { id?: string }).id,
                      name: (match.channel as { name?: string }).name,
                    }
                  : match.channel,
                permalink: match.permalink,
              },
        ),
      };
    },
  }),
  tool({
    name: "slack_search_context",
    label: "Search Slack by meaning",
    description:
      "Answer questions like \"what did we decide about X?\" with Slack's Real-time Search (assistant.search.context), as the authorizing user. Ranks messages by meaning, and returns each hit with its permalink and the messages just before and after it. Can also search files, channels and users. Covers public and private channels, group DMs and DMs the user can see. Results are turn-local: use them to answer now and do not store them in memory, notes, canvases, lists or files. Slack allows about 10 calls a minute, so refine one query rather than looping. If Real-time Search is unavailable (missing scope, feature off), falls back to keyword search and returns mode \"legacy\" with the reason.",
    parameters: Type.Object({
      query: Type.String({
        description: "A natural-language question or keywords, e.g. \"what did we decide about pricing?\".",
      }),
      contentTypes: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("messages"),
            Type.Literal("files"),
            Type.Literal("channels"),
            Type.Literal("users"),
          ]),
          { minItems: 1, uniqueItems: true, description: "What to search. Default: [\"messages\"]." },
        ),
      ),
      channelTypes: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("public_channel"),
            Type.Literal("private_channel"),
            Type.Literal("mpim"),
            Type.Literal("im"),
          ]),
          {
            minItems: 1,
            uniqueItems: true,
            description: "Conversation types to search. Default: all four.",
          },
        ),
      ),
      includeContextMessages: Type.Optional(
        Type.Boolean({
          description: "Return the messages around each hit. Default true.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "Results per page, at most 20. Default 10." }),
      ),
      after: Type.Optional(
        Type.Integer({ minimum: 0, description: "Only results after this Unix time, in seconds." }),
      ),
      before: Type.Optional(
        Type.Integer({ minimum: 0, description: "Only results before this Unix time, in seconds." }),
      ),
      sort: Type.Optional(
        Type.Union([Type.Literal("score"), Type.Literal("timestamp")], {
          description: "Rank by relevance (score) or recency (timestamp). Default: score.",
        }),
      ),
      sortDir: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
          description: "Sort direction. Default: desc.",
        }),
      ),
      cursor: Type.Optional(
        Type.String({ description: "nextCursor from a previous call, for the next page." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        mode: Type.Union([Type.Literal("context"), Type.Literal("legacy")], {
          description:
            "context: Real-time Search. legacy: keyword search.messages, used when Real-time Search is unavailable; messages only, no context messages.",
        }),
        query: Type.String(),
        reason: Type.Optional(Type.String({ description: "Why the legacy fallback ran." })),
        doctorHint: Type.Optional(Type.String()),
        messages: Type.Array(
          Type.Object(
            {
              channelId: Type.Optional(Type.String()),
              channelName: Type.Optional(Type.String()),
              ts: Type.Optional(Type.String()),
              userId: Type.Optional(Type.String()),
              userName: Type.Optional(Type.String()),
              isBot: Type.Optional(Type.Boolean()),
              text: Type.Optional(Type.String()),
              permalink: Type.Optional(Type.String()),
              context: Type.Optional(
                Type.Object(
                  { before: Type.Array(contextMessageSchema), after: Type.Array(contextMessageSchema) },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        files: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.Optional(Type.String()),
                title: Type.Optional(Type.String()),
                fileType: Type.Optional(Type.String()),
                userId: Type.Optional(Type.String()),
                userName: Type.Optional(Type.String()),
                created: Type.Optional(Type.Number()),
                updated: Type.Optional(Type.Number()),
                permalink: Type.Optional(Type.String()),
                content: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        channels: Type.Optional(
          Type.Array(
            Type.Object(
              {
                name: Type.Optional(Type.String()),
                topic: Type.Optional(Type.String()),
                purpose: Type.Optional(Type.String()),
                creatorId: Type.Optional(Type.String()),
                created: Type.Optional(Type.Number()),
                permalink: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        users: Type.Optional(
          Type.Array(Type.Record(Type.String(), Type.Unknown()), {
            description: "User hits, passed through as Slack returns them.",
          }),
        ),
        nextCursor: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(
      {
        query,
        contentTypes,
        channelTypes,
        includeContextMessages,
        limit,
        after,
        before,
        sort,
        sortDir,
        cursor,
      },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // A user token needs no action_token; bot-token calls would.
      const token = resolveToken(config, "user");
      let data;
      try {
        // Form encoding sends arrays as the comma-separated lists Slack documents.
        data = await callSlack(
          "assistant.search.context",
          token,
          {
            query,
            content_types: (contentTypes ?? ["messages"]).join(","),
            channel_types: (channelTypes ?? ALL_CHANNEL_TYPES).join(","),
            include_context_messages: includeContextMessages ?? true,
            limit: limit ?? 10,
            after,
            before,
            sort: sort ?? "score",
            sort_dir: sortDir ?? "desc",
            cursor,
          },
          context,
          true,
        );
      } catch (error) {
        if (!(error instanceof SlackApiError) || !CONTEXT_FALLBACK_ERRORS.has(error.code)) throw error;
        let legacy;
        try {
          legacy = await callSlack(
            "search.messages",
            token,
            { query, count: limit ?? 10, sort: sort ?? "score", sort_dir: sortDir ?? "desc" },
            context,
            true,
          );
        } catch (legacyError) {
          throw new Error(
            `${error.message}; the legacy fallback failed too: ${(legacyError as Error).message}`,
            { cause: legacyError },
          );
        }
        const matches =
          (legacy.messages as { matches?: Raw[] } | undefined)?.matches ?? [];
        return {
          mode: "legacy",
          query,
          reason: `Real-time Search is unavailable (${error.message}), so this is keyword search over messages only, without context messages.`,
          doctorHint:
            "Run `openclaw slack-workspace doctor` to check the user token's search:read.* scopes.",
          messages: matches.map(legacyHit),
        };
      }

      const results = (data.results ?? {}) as {
        messages?: Raw[];
        files?: Raw[];
        channels?: Raw[];
        users?: Raw[];
      };
      const nextCursor = (data.response_metadata as { next_cursor?: string } | undefined)
        ?.next_cursor;
      return defined({
        mode: "context",
        query,
        messages: (results.messages ?? []).map(contextHit),
        files: results.files?.map((file) =>
          defined({
            id: file.file_id,
            title: file.title,
            fileType: file.file_type,
            userId: file.author_user_id ?? file.uploader_user_id,
            userName: file.author_name,
            created: file.date_created,
            updated: file.date_updated,
            permalink: file.permalink,
            content: file.content,
          }),
        ),
        channels: results.channels?.map((channel) =>
          defined({
            name: channel.name,
            topic: channel.topic,
            purpose: channel.purpose,
            creatorId: channel.creator_user_id,
            created: channel.date_created,
            permalink: channel.permalink,
          }),
        ),
        users: results.users,
        nextCursor,
      });
    },
  }),
];
