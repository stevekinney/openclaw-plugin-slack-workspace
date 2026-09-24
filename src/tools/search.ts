import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import type { ToolFactory } from "../schemas.js";

export const searchTools = (tool: ToolFactory) => [
  tool({
    name: "slack_search",
    label: "Search Slack",
    description:
      "Search Slack messages or files as the authorizing user. Covers every private channel, group, and DM that user belongs to — not just what the bot was invited to. Supports Slack's search modifiers: in:#channel, from:@user, before:2026-09-01, has:link.",
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
                // Block-only messages match on indexed block text but return text:"".
                // Fall back to an attachment fallback so the hit isn't blank.
                text:
                  match.text ||
                  (match.attachments as { fallback?: string }[] | undefined)?.[0]?.fallback ||
                  "(no plain text — Block Kit message; open the permalink)",
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
];
