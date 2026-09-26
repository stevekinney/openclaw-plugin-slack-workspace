import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import type { ApprovalRule } from "../approvals.js";
import { authTest, callSlack, resolveToken, SlackApiError, type PluginConfig, type SlackCallContext } from "../client.js";
import { cursorParams, toPage } from "../pagination.js";
import { resolveChannelId } from "../tool.js";
import {
  activeChannelIdParam,
  blocksSchema,
  metadataParam,
  permalinkField,
  postResultSchema,
  replyBroadcastParam,
  targetParams,
  threadTsParam,
  toSlackMetadata,
  unfurlParams,
  type ToolFactory,
} from "../schemas.js";

/** Wrap plain text as the single-paragraph rich_text entity task cards expect. */
const richText = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
});

/** Escape the three characters Slack treats as control sequences, so data can't @-mention. */
const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One block of a structured message; `slack_post_rich_text` compiles these to rich_text. */
const richTextSectionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Union([Type.Literal("paragraph"), Type.Literal("quote"), Type.Literal("code")], {
        description: "`paragraph` (plain text), `quote` (indented block quote), or `code` (preformatted block, verbatim).",
      }),
      text: Type.String({
        minLength: 1,
        description: "Section text. In paragraph and quote, `backticks` mark inline code.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Union([Type.Literal("bullet_list"), Type.Literal("ordered_list")], {
        description: "`bullet_list` (•) or `ordered_list` (1. 2. 3.).",
      }),
      items: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 100,
        description: "List items in order. `backticks` mark inline code.",
      }),
    },
    { additionalProperties: false },
  ),
]);

type RichTextSection = Static<typeof richTextSectionSchema>;

/** Split text on `backtick` spans into rich_text text elements, styling the spans as code. */
const inlineElements = (text: string) =>
  text
    .split(/`([^`\n]+)`/)
    .flatMap((part, index) => {
      if (part === "") return [];
      // split() puts captured spans at odd indexes.
      return [index % 2 ? { type: "text", text: part, style: { code: true } } : { type: "text", text: part }];
    });

const richTextElement = (section: RichTextSection) => {
  const listItems = (items: string[]) =>
    items.map((item) => ({ type: "rich_text_section", elements: inlineElements(item) }));
  switch (section.type) {
    case "paragraph":
      return { type: "rich_text_section", elements: inlineElements(section.text) };
    case "quote":
      // Unlike a list, a quote holds inline elements directly, not sections.
      return { type: "rich_text_quote", elements: inlineElements(section.text) };
    case "code":
      return { type: "rich_text_preformatted", elements: [{ type: "text", text: section.text }] };
    case "bullet_list":
      return { type: "rich_text_list", style: "bullet", elements: listItems(section.items) };
    case "ordered_list":
      return { type: "rich_text_list", style: "ordered", elements: listItems(section.items) };
  }
};

/** Plain-text rendering of the sections; content is escaped, the `>` quote marker is not. */
const richTextFallback = (sections: RichTextSection[]) =>
  sections
    .map((section) => {
      switch (section.type) {
        case "paragraph":
          return escapeText(section.text);
        case "quote":
          return `> ${escapeText(section.text)}`;
        case "code":
          return `\`\`\`${escapeText(section.text)}\`\`\``;
        case "bullet_list":
          return section.items.map((item) => `• ${escapeText(item)}`).join("\n");
        case "ordered_list":
          return section.items.map((item, index) => `${index + 1}. ${escapeText(item)}`).join("\n");
      }
    })
    .join("\n");

/** Show the first `limit` items, then note how many were cut. */
const truncated = (items: string[], limit: number, noun = "") =>
  items.length > limit
    ? [...items.slice(0, limit), `…and ${items.length - limit} more${noun}`]
    : items;

/** Slack's aggregate limit on the text of every cell in a data_table. */
const MAX_TABLE_CHARACTERS = 10_000;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * `text` is what notifications show and what search indexes for block-only
 * messages, so give it real data rather than just the caption.
 */
function tableFallback(caption: string, columns: string[], rows: (string | number)[][]) {
  const lines = rows.map((row) =>
    row.map((cell, index) => `${columns[index]}: ${cell}`).join(", "),
  );
  return escapeText(
    [`${caption} (${plural(rows.length, "row")})`, ...truncated(lines, 3, " rows")].join("\n"),
  );
}

function chartFallback(
  title: string,
  chartType: string,
  data:
    | { segments: { label: string; value: number }[] }
    | { categories: string[]; series: { name: string; values: number[] }[] },
) {
  const lines =
    "segments" in data
      ? [
          truncated(
            [...data.segments]
              .sort((a, b) => b.value - a.value)
              .map((segment) => `${segment.label}: ${segment.value}`),
            5,
          ).join(", "),
        ]
      : truncated(
          data.series.map(
            (entry) =>
              `${entry.name}: ${truncated(
                entry.values.map((value, index) => `${data.categories[index]} ${value}`),
                8,
              ).join(", ")}`,
          ),
          5,
          " series",
        );
  return escapeText([`${title} (${chartType} chart)`, ...lines].join("\n"));
}

/** Messages per history/replies page; Slack recommends no more than 200. */
const HISTORY_PAGE_LIMIT = 200;

type MetadataMessage = {
  ts?: unknown;
  thread_ts?: unknown;
  text?: unknown;
  metadata?: { event_type?: unknown; event_payload?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Throw unless the message at `ts` was posted by the bot token's own identity. Reads
 * it back with `conversations.history`, or `conversations.replies` for a thread reply,
 * and compares its `bot_id`/`user` against `auth.test`. Runs before any delete.
 */
async function requireOwnMessage(
  channelId: string,
  ts: string,
  threadTs: string | undefined,
  token: string,
  context: SlackCallContext,
): Promise<void> {
  const { data: self } = await authTest(token, context);
  const range = { channel: channelId, oldest: ts, latest: ts, inclusive: true };
  // conversations.replies always leads with the thread parent, so it gets no limit.
  const data = threadTs
    ? await callSlack("conversations.replies", token, { ...range, ts: threadTs }, context, true)
    : await callSlack("conversations.history", token, { ...range, limit: 1 }, context, true);
  const messages = Array.isArray(data.messages) ? (data.messages as Record<string, unknown>[]) : [];
  const message = messages.find((candidate) => candidate.ts === ts);
  if (!message) {
    throw new Error(
      `Message ${ts} was not found in channel ${channelId}${threadTs ? ` thread ${threadTs}` : ""}. If it is a thread reply, pass its parent's ts as threadTs.`,
    );
  }
  const ownBot = typeof self.bot_id === "string" && message.bot_id === self.bot_id;
  const ownUser = typeof self.user_id === "string" && message.user === self.user_id;
  if (!ownBot && !ownUser) {
    throw new Error(
      `Refusing to delete message ${ts} in channel ${channelId}: it was not posted by this bot. slack_message_delete only removes the bot's own messages.`,
    );
  }
}

/** One message whose metadata matched, curated to what finding and updating it needs. */
const stampedMessageSchema = Type.Object(
  {
    channelId: Type.String(),
    ts: Type.String({ description: "Pass as `updateTs`/`ts` to rewrite the message." }),
    threadTs: Type.Optional(Type.String({ description: "Thread the message belongs to, if any." })),
    text: Type.String(),
    eventType: Type.String(),
    eventPayload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/**
 * Add the message's permalink to a post result. The post already succeeded, so a failed
 * lookup only logs a warning and returns the result without `permalink`.
 */
async function withPermalink<T extends { channelId: string; ts: string }>(
  result: T,
  token: string,
  context?: SlackCallContext,
): Promise<T & { permalink?: string }> {
  if (!result.ts) return result;
  try {
    const data = await callSlack(
      "chat.getPermalink",
      token,
      { channel: result.channelId, message_ts: result.ts },
      context,
    );
    return typeof data.permalink === "string" ? { ...result, permalink: data.permalink } : result;
  } catch (error) {
    context?.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    context?.api?.logger?.warn(`slack-workspace: chat.getPermalink failed; returning the post without a permalink: ${reason}`);
    return result;
  }
}

/** Work Object entity types slack_work_object_post supports (docs.slack.dev/messaging/work-objects-implementation). */
type WorkObjectType = "task" | "incident" | "file" | "content_item";

/** Default `display_type` label for each Work Object entity type. */
const WORK_OBJECT_LABELS: Record<WorkObjectType, string> = {
  task: "Task",
  incident: "Incident",
  file: "Document",
  content_item: "Page",
};

/** Entity types whose schema has a `status` field. */
const STATUS_TYPES = new Set<string>(["task", "incident"]);

/**
 * Errors a plain post would hit too, so they are not a reason to fall back from a
 * Work Object to a Block Kit card. Anything else is taken as a rejected entity.
 */
const PLAIN_POST_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "missing_scope",
  "ratelimited",
]);

async function postOrUpdate(
  config: PluginConfig,
  args: {
    channelId: string;
    text: string;
    blocks: unknown[];
    threadTs?: string;
    replyBroadcast?: boolean;
    updateTs?: string;
    unfurlLinks?: boolean;
    unfurlMedia?: boolean;
    metadata?: { eventType: string; eventPayload: Record<string, unknown> };
  },
  context?: SlackCallContext,
): Promise<{ channelId: string; ts: string; updated: boolean; permalink?: string }> {
  const token = resolveToken(config, "bot");
  const body: Record<string, unknown> = {
    channel: args.channelId,
    text: args.text,
    blocks: args.blocks,
  };
  if (args.metadata) body.metadata = toSlackMetadata(args.metadata);
  if (args.updateTs) {
    body.ts = args.updateTs;
    const data = await callSlack("chat.update", token, body, context);
    return withPermalink(
      {
        channelId: String(data.channel ?? args.channelId),
        ts: String(data.ts ?? args.updateTs),
        updated: true,
      },
      token,
      context,
    );
  }
  if (args.threadTs) body.thread_ts = args.threadTs;
  if (args.threadTs && args.replyBroadcast) body.reply_broadcast = true;
  body.unfurl_links = args.unfurlLinks ?? false;
  body.unfurl_media = args.unfurlMedia ?? false;
  const data = await callSlack("chat.postMessage", token, body, context);
  // A user ID opens a DM; Slack returns the resolved D… channel, which follow-up calls need.
  return withPermalink(
    { channelId: String(data.channel ?? args.channelId), ts: String(data.ts ?? ""), updated: false },
    token,
    context,
  );
}

export const messagingTools = (tool: ToolFactory) => [
  tool({
    name: "slack_post_table",
    label: "Post Slack table",
    description:
      "Post tabular data to Slack as a sortable, paginated data_table. Prefer this over a Markdown table or a bullet list whenever the data has columns. Pass plain strings and numbers — numeric cells sort numerically and are encoded correctly for you.",
    parameters: Type.Object({
      ...targetParams,
      caption: Type.String({
        description: "Table caption. Required by Slack and read by screen readers.",
      }),
      columns: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description: "Header labels, left to right.",
      }),
      rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()])), {
        minItems: 1,
        maxItems: 200,
        description:
          "Data rows, excluding the header. Every row must have exactly as many cells as `columns`. Numbers sort numerically; strings sort alphabetically.",
      }),
      pageSize: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Rows per page. Default 5." }),
      ),
    }),
    outputSchema: postResultSchema,
    async execute(
      { channelId, caption, columns, rows, pageSize, threadTs, replyBroadcast, updateTs, unfurlLinks, unfurlMedia, metadata },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const bad = rows.findIndex((row) => row.length !== columns.length);
      if (bad !== -1) {
        throw new Error(
          `Row ${bad} has ${rows[bad].length} cells but there are ${columns.length} columns. Slack requires every row to match the header width.`,
        );
      }
      // Slack also caps the table's total cell text, header included. Core's presentation
      // renderer enforces the same limit; fail before the network rather than on invalid_blocks.
      const characters = [...columns, ...rows.flat()].reduce<number>(
        (total, cell) => total + String(cell).length,
        0,
      );
      if (characters > MAX_TABLE_CHARACTERS) {
        throw new Error(
          `Table cells total ${characters} characters; Slack caps a data_table at ${MAX_TABLE_CHARACTERS}. Trim long cells or split the rows across tables.`,
        );
      }
      // raw_number needs BOTH value and text; sending either alone fails validation.
      const table: Record<string, unknown> = {
        type: "data_table",
        caption,
        rows: [
          columns.map((column) => ({ type: "raw_text", text: column })),
          ...rows.map((row) =>
            row.map((cell) =>
              typeof cell === "number"
                ? { type: "raw_number", value: cell, text: String(cell) }
                : { type: "raw_text", text: cell },
            ),
          ),
        ],
      };
      if (pageSize) table.page_size = pageSize;
      return postOrUpdate(
        config,
        {
          channelId: resolveChannelId(channelId, context),
          text: tableFallback(caption, columns, rows),
          blocks: [table],
          threadTs,
          replyBroadcast,
          updateTs,
          unfurlLinks,
          unfurlMedia,
          metadata,
        },
        context,
      );
    },
  }),

  tool({
    name: "slack_post_plan",
    label: "Post Slack plan",
    description:
      "Post a checklist of steps to Slack as a native plan block with per-task status indicators. Use for multi-step work instead of a bullet list. Re-post with `updateTs` as steps complete so one card stays current.",
    parameters: Type.Object({
      ...targetParams,
      title: Type.String({ description: "Plan title, plain text." }),
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "What this step does." }),
          // `error` is from the task_card fields table; `pending` from the plan block's examples.
          status: Type.Union(
            [
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("complete"),
              Type.Literal("error"),
            ],
            {
              description:
                "Step state: `pending` (not started), `in_progress`, `complete`, or `error` (failed).",
            },
          ),
          details: Type.Optional(Type.String({ description: "What the step is doing." })),
          output: Type.Optional(Type.String({ description: "What the step produced." })),
        }),
        { minItems: 1, maxItems: 50, description: "Steps in order." },
      ),
    }),
    outputSchema: postResultSchema,
    async execute(
      { channelId, title, tasks, threadTs, replyBroadcast, updateTs, unfurlLinks, unfurlMedia, metadata },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // Slack wants a fresh block_id on every revision of a message.
      const revision = Date.now().toString(36);
      const plan = {
        type: "plan",
        block_id: `plan_${revision}`,
        title,
        tasks: tasks.map((task, index) => ({
          task_id: `task_${index + 1}`,
          title: task.title,
          status: task.status,
          ...(task.details ? { details: richText(task.details) } : {}),
          ...(task.output ? { output: richText(task.output) } : {}),
        })),
      };
      const done = tasks.filter((task) => task.status === "complete").length;
      return postOrUpdate(
        config,
        {
          channelId: resolveChannelId(channelId, context),
          text: `${title} — ${done}/${tasks.length} complete`,
          blocks: [plan],
          threadTs,
          replyBroadcast,
          updateTs,
          unfurlLinks,
          unfurlMedia,
          metadata,
        },
        context,
      );
    },
  }),

  tool({
    name: "slack_post_rich_text",
    label: "Post Slack rich text",
    description:
      "Post formatted text to Slack as a native rich_text block: paragraphs, real bulleted and numbered lists, block quotes, and code blocks. Pass a flat list of sections and the nested rich_text JSON is built for you. Use instead of hand-writing rich_text through slack_blocks_send.",
    parameters: Type.Object({
      ...targetParams,
      sections: Type.Array(richTextSectionSchema, {
        minItems: 1,
        maxItems: 50,
        description:
          "Sections in reading order, e.g. [{\"type\":\"paragraph\",\"text\":\"Done:\"},{\"type\":\"bullet_list\",\"items\":[\"api\",\"web\"]}].",
      }),
      text: Type.Optional(
        Type.String({
          description:
            "Notification and screen-reader fallback. Defaults to a plain-text rendering of the sections.",
        }),
      ),
    }),
    outputSchema: postResultSchema,
    async execute(
      { channelId, sections, text, threadTs, replyBroadcast, updateTs, unfurlLinks, unfurlMedia, metadata },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // Slack rejects an empty text element with a bare invalid_blocks; fail here with the section named.
      sections.forEach((section, index) => {
        const content = "items" in section ? section.items : [(section as { text?: string }).text];
        if (!content?.length || content.some((value) => !value)) {
          const field = section.type.endsWith("_list") ? "a non-empty `items` array" : "non-empty `text`";
          throw new Error(`Section ${index} (${section.type}) needs ${field}.`);
        }
      });
      return postOrUpdate(
        config,
        {
          channelId: resolveChannelId(channelId, context),
          text: text ?? richTextFallback(sections),
          blocks: [{ type: "rich_text", elements: sections.map(richTextElement) }],
          threadTs,
          replyBroadcast,
          updateTs,
          unfurlLinks,
          unfurlMedia,
          metadata,
        },
        context,
      );
    },
  }),

  tool({
    name: "slack_post_chart",
    label: "Post Slack chart",
    description:
      "Post a native Slack chart (pie, bar, line, or area). Use instead of describing numbers in prose or generating a chart image. Max 2 charts per message.",
    parameters: Type.Object({
      ...targetParams,
      title: Type.String({ maxLength: 50, description: "Chart title. Max 50 characters." }),
      chartType: Type.Union(
        [
          Type.Literal("pie"),
          Type.Literal("bar"),
          Type.Literal("line"),
          Type.Literal("area"),
        ],
        { description: "Chart style." },
      ),
      segments: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ maxLength: 20, description: "Slice label. Max 20 characters." }),
            value: Type.Number(),
          }),
          { minItems: 1, maxItems: 12, description: "Pie slices. Required when chartType is pie." },
        ),
      ),
      categories: Type.Optional(
        Type.Array(Type.String({ maxLength: 20 }), {
          minItems: 1,
          maxItems: 20,
          description:
            "X-axis labels, left to right. Required for bar, line, and area. Max 20 characters each.",
        }),
      ),
      series: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ maxLength: 20, description: "Legend name. Max 20 characters, unique." }),
            values: Type.Array(Type.Number(), {
              description: "One value per entry in `categories`, same order.",
            }),
          }),
          { minItems: 1, maxItems: 12, description: "Required for bar, line, and area." },
        ),
      ),
      xLabel: Type.Optional(Type.String({ description: "X-axis title." })),
      yLabel: Type.Optional(Type.String({ description: "Y-axis title." })),
    }),
    outputSchema: postResultSchema,
    async execute(args, config, context) {
      context.signal?.throwIfAborted();
      const { channelId, title, chartType, segments, categories, series, xLabel, yLabel } = args;
      let chart: Record<string, unknown>;
      let text: string;

      if (chartType === "pie") {
        if (!segments?.length) throw new Error("A pie chart requires `segments`.");
        chart = { type: "pie", segments };
        text = chartFallback(title, chartType, { segments });
      } else {
        if (!categories?.length || !series?.length) {
          throw new Error(`A ${chartType} chart requires both \`categories\` and \`series\`.`);
        }
        // JSON Schema cannot require unique object properties, so check names here.
        const duplicate = series.find(
          (entry, index) => series.findIndex((other) => other.name === entry.name) !== index,
        );
        if (duplicate) {
          throw new Error(
            `Series name "${duplicate.name}" appears more than once. Slack requires unique names.`,
          );
        }
        const mismatch = series.find((entry) => entry.values.length !== categories.length);
        if (mismatch) {
          throw new Error(
            `Series "${mismatch.name}" has ${mismatch.values.length} values but there are ${categories.length} categories. Slack requires exactly one value per category.`,
          );
        }
        chart = {
          type: chartType,
          series: series.map((entry) => ({
            name: entry.name,
            data: entry.values.map((value, index) => ({ label: categories[index], value })),
          })),
          axis_config: {
            categories,
            ...(xLabel ? { x_label: xLabel } : {}),
            ...(yLabel ? { y_label: yLabel } : {}),
          },
        };
        text = chartFallback(title, chartType, { categories, series });
      }

      return postOrUpdate(
        config,
        {
          channelId: resolveChannelId(channelId, context),
          text,
          blocks: [{ type: "data_visualization", title, chart }],
          threadTs: args.threadTs,
          replyBroadcast: args.replyBroadcast,
          updateTs: args.updateTs,
          unfurlLinks: args.unfurlLinks,
          unfurlMedia: args.unfurlMedia,
          metadata: args.metadata,
        },
        context,
      );
    },
  }),

  tool({
    name: "slack_blocks_send",
    label: "Send Slack Block Kit message",
    description:
      "Post a message built from raw Slack Block Kit blocks. Use when the layout needs block types OpenClaw's portable `presentation` cannot express — headers, rich_text, tables, images, button rows, carousels, alerts. Always set `text` as the notification fallback.",
    parameters: Type.Object({
      channelId: activeChannelIdParam(),
      text: Type.String({
        description:
          "Plain-text fallback used in notifications and by screen readers. Required by Slack; summarize the blocks.",
      }),
      blocks: blocksSchema,
      threadTs: threadTsParam,
      replyBroadcast: replyBroadcastParam,
      ...unfurlParams,
      metadata: metadataParam,
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number(), permalink: permalinkField },
      { additionalProperties: false },
    ),
    async execute(
      { channelId: explicitChannelId, text, blocks, threadTs, replyBroadcast, unfurlLinks, unfurlMedia, metadata },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const channelId = resolveChannelId(explicitChannelId, context);
      const body: Record<string, unknown> = {
        channel: channelId,
        text,
        blocks,
        unfurl_links: unfurlLinks ?? false,
        unfurl_media: unfurlMedia ?? false,
      };
      if (threadTs) body.thread_ts = threadTs;
      if (threadTs && replyBroadcast) body.reply_broadcast = true;
      if (metadata) body.metadata = toSlackMetadata(metadata);
      const token = resolveToken(config, "bot");
      const data = await callSlack("chat.postMessage", token, body, context);
      const { permalink } = await withPermalink(
        { channelId: String(data.channel ?? channelId), ts: String(data.ts ?? "") },
        token,
        context,
      );
      return { channelId, ts: String(data.ts ?? ""), blockCount: blocks.length, ...(permalink && { permalink }) };
    },
  }),

  tool({
    name: "slack_blocks_update",
    label: "Update Slack Block Kit message",
    description:
      "Replace the blocks of a message this app posted. Use to keep one card current — a build status, a running checklist — instead of posting a new message each time.",
    parameters: Type.Object({
      channelId: activeChannelIdParam("The channel the message lives in."),
      ts: Type.String({ description: "Message timestamp from slack_blocks_send." }),
      text: Type.String({ description: "Updated plain-text notification fallback." }),
      blocks: blocksSchema,
      metadata: metadataParam,
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number(), permalink: permalinkField },
      { additionalProperties: false },
    ),
    async execute({ channelId: explicitChannelId, ts, text, blocks, metadata }, config, context) {
      context.signal?.throwIfAborted();
      const channelId = resolveChannelId(explicitChannelId, context);
      const body: Record<string, unknown> = { channel: channelId, ts, text, blocks };
      if (metadata) body.metadata = toSlackMetadata(metadata);
      const token = resolveToken(config, "bot");
      const data = await callSlack("chat.update", token, body, context);
      return withPermalink({ channelId, ts: String(data.ts ?? ts), blockCount: blocks.length }, token, context);
    },
  }),

  tool({
    name: "slack_message_get",
    label: "Find Slack message by metadata",
    description:
      "Find messages by the metadata stamped on them (the `metadata` param of slack_post_*/slack_blocks_*), newest first, and return each one's `ts` for slack_blocks_update or `updateTs`. Use this to re-find your own cards instead of remembering timestamps or searching text. Reads channel history, or one thread with `threadTs`, via conversations.history/replies — it polls on each call; nothing is pushed when metadata changes. Finds nothing if the event type isn't registered in the app manifest, because Slack drops unregistered metadata on post.",
    parameters: Type.Object({
      channelId: activeChannelIdParam("The channel to search."),
      eventType: Type.String({
        pattern: "^[A-Za-z0-9_]+$",
        maxLength: 255,
        description: "Metadata event type to match, usually \"openclaw_card\".",
      }),
      matchPayload: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Only return messages whose payload has every one of these keys with an equal value, e.g. {\"taskId\":\"T-1\"}. Nested values compare structurally.",
        }),
      ),
      threadTs: Type.Optional(
        Type.String({ description: "Search only this thread's parent and replies." }),
      ),
      oldest: Type.Optional(
        Type.String({ description: "Only messages after this timestamp, e.g. \"1726000000.000000\"." }),
      ),
      latest: Type.Optional(
        Type.String({ description: "Only messages before this timestamp." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Stop after this many matches. Default 20; use 1 to find the latest card.",
        }),
      ),
      maxPages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: `Pages of ${HISTORY_PAGE_LIMIT} messages to scan before giving up. Default 5.`,
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        messages: Type.Array(stampedMessageSchema),
        truncated: Type.Boolean({
          description: "More messages remained unscanned; narrow with oldest/latest or raise maxPages.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(
      {
        channelId: explicitChannelId,
        eventType,
        matchPayload,
        threadTs,
        oldest,
        latest,
        limit = 20,
        maxPages = 5,
      },
      config,
      context,
    ) {
      const channelId = resolveChannelId(explicitChannelId, context);
      const token = resolveToken(config, "bot");
      const method = threadTs ? "conversations.replies" : "conversations.history";
      const base: Record<string, unknown> = { channel: channelId, include_all_metadata: true };
      if (threadTs) base.ts = threadTs;
      if (oldest) base.oldest = oldest;
      if (latest) base.latest = latest;
      const wanted = Object.entries(matchPayload ?? {});
      const messages: Static<typeof stampedMessageSchema>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        context.signal?.throwIfAborted();
        const data = await callSlack(
          method,
          token,
          { ...base, ...cursorParams({ cursor, limit: HISTORY_PAGE_LIMIT }) },
          context,
          true,
        );
        const { items, cursor: next } = toPage<MetadataMessage>(data, "messages");
        for (const [index, message] of items.entries()) {
          const metadata = message.metadata;
          const payload = metadata?.event_payload;
          if (!isRecord(metadata) || metadata.event_type !== eventType || !isRecord(payload)) continue;
          if (!wanted.every(([key, value]) => isDeepStrictEqual(payload[key], value))) continue;
          messages.push({
            channelId,
            ts: String(message.ts ?? ""),
            ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
            text: typeof message.text === "string" ? message.text : "",
            eventType,
            eventPayload: payload,
          });
          if (messages.length >= limit) {
            return { messages, truncated: index < items.length - 1 || Boolean(next) };
          }
        }
        // A cursor that does not advance would loop forever; stop and report it.
        if (!next || next === cursor) return { messages, truncated: Boolean(next) };
        cursor = next;
      }
      return { messages, truncated: true };
    },
  }),

  tool({
    name: "slack_message_delete",
    label: "Delete Slack message",
    description:
      "Delete a message this bot posted, e.g. a scratch or obsolete card. Irreversible, so it waits for a human's approval. Refuses any message another user or app posted: the tool reads the message back first and checks its author. For a thread reply, pass the parent's `threadTs`.",
    parameters: Type.Object({
      channelId: activeChannelIdParam("The channel the message lives in."),
      ts: Type.String({ description: "Timestamp of the message to delete, e.g. from slack_blocks_send or slack_message_get." }),
      threadTs: Type.Optional(
        Type.String({ description: "The thread parent's ts, when the message is a thread reply." }),
      ),
    }),
    outputSchema: Type.Object(
      { deleted: Type.Literal(true), channelId: Type.String(), ts: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId: explicitChannelId, ts, threadTs }, config, context) {
      context.signal?.throwIfAborted();
      const channelId = resolveChannelId(explicitChannelId, context);
      const token = resolveToken(config, "bot");
      await requireOwnMessage(channelId, ts, threadTs, token, context);
      context.signal?.throwIfAborted();
      await callSlack("chat.delete", token, { channel: channelId, ts }, context);
      return { deleted: true, channelId, ts };
    },
  }),

  tool({
    name: "slack_post_ephemeral",
    label: "Post Slack ephemeral message",
    description:
      "Post a private message that only one user sees, inline in a shared channel or thread, without cluttering it for everyone else. Use for a personal nudge or a reminder aimed at one person. Ephemeral messages are temporary, can't be edited or found again later, and only reach a user who is a member of the channel.",
    parameters: Type.Object({
      channelId: activeChannelIdParam("The channel the user will see the message in."),
      userId: Type.String({
        description: "The one user who sees the message, e.g. U0ALICE. Must be a member of the channel.",
      }),
      text: Type.String({
        description:
          "Message text, or the notification and screen-reader fallback when `blocks` is set.",
      }),
      blocks: Type.Optional(blocksSchema),
      threadTs: threadTsParam,
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        userId: Type.String(),
        ephemeralTs: Type.String({
          description:
            "Slack's message_ts, for reference only. Ephemeral messages cannot be updated: don't pass this to slack_blocks_update or `updateTs`.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId: explicitChannelId, userId, text, blocks, threadTs }, config, context) {
      context.signal?.throwIfAborted();
      const channelId = resolveChannelId(explicitChannelId, context);
      const body: Record<string, unknown> = { channel: channelId, user: userId, text };
      if (blocks) body.blocks = blocks;
      if (threadTs) body.thread_ts = threadTs;
      const data = await callSlack("chat.postEphemeral", resolveToken(config, "bot"), body, context);
      if (typeof data.message_ts !== "string" || !data.message_ts) {
        throw new Error("chat.postEphemeral succeeded but returned no message_ts.");
      }
      return { channelId, userId, ephemeralTs: data.message_ts };
    },
  }),

  tool({
    name: "slack_work_object_post",
    label: "Post Slack Work Object card",
    description:
      "Post a native Work Object card for an external item — an issue, task, incident, or doc — showing its title, display ID, type, status, and link. Richer than pasting a URL. Clicking the card opens only a static placeholder: this plugin can't serve the item's details pane. If Slack rejects the Work Object, posts an equivalent plain Block Kit card instead and returns `mode: \"fallback\"` with the reason.",
    parameters: Type.Object({
      channelId: activeChannelIdParam(),
      title: Type.String({ minLength: 1, description: "Item title, e.g. \"Checkout fails on Safari\"." }),
      url: Type.String({
        pattern: "^https?://",
        description: "Link to the item in its own system. Must be http(s).",
      }),
      entityType: Type.Optional(
        Type.Union(
          [Type.Literal("task"), Type.Literal("incident"), Type.Literal("file"), Type.Literal("content_item")],
          {
            description:
              "Slack entity type: `task` (issues, tickets; default), `incident`, `file` (documents), or `content_item` (pages, articles). Only task and incident show a status.",
          },
        ),
      ),
      displayId: Type.Optional(Type.String({ description: "Human-facing ID, e.g. \"SHOP-42\"." })),
      displayType: Type.Optional(
        Type.String({ description: "Type label on the card, e.g. \"Issue\". Defaults from entityType." }),
      ),
      status: Type.Optional(
        Type.String({ description: "Current status, e.g. \"In progress\". task and incident only." }),
      ),
      externalId: Type.Optional(
        Type.String({ description: "The item's stable ID in its own system. Defaults to displayId, then url." }),
      ),
      productName: Type.Optional(Type.String({ description: "Source product shown on the card, e.g. \"Linear\"." })),
      threadTs: threadTsParam,
      replyBroadcast: replyBroadcastParam,
    }),
    outputSchema: Type.Object(
      {
        mode: Type.Union([Type.Literal("work_object"), Type.Literal("fallback")], {
          description: "`fallback` means Slack rejected the Work Object and a plain Block Kit card was posted.",
        }),
        channelId: Type.String(),
        ts: Type.String(),
        permalink: permalinkField,
        reason: Type.Optional(Type.String({ description: "Why the Work Object was rejected, for `fallback`." })),
      },
      { additionalProperties: false },
    ),
    async execute(
      {
        channelId: explicitChannelId,
        title,
        url,
        entityType = "task",
        displayId,
        displayType = WORK_OBJECT_LABELS[entityType],
        status,
        externalId,
        productName,
        threadTs,
        replyBroadcast,
      },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      if (status && !STATUS_TYPES.has(entityType)) {
        throw new Error(
          `Slack's ${entityType} entity has no status field. Use entityType "task" or "incident", or omit status.`,
        );
      }
      const channelId = resolveChannelId(explicitChannelId, context);
      const token = resolveToken(config, "bot");
      const summary = `${displayType}${displayId ? ` ${displayId}` : ""}: ${title}${status ? ` (${status})` : ""}`;
      const body: Record<string, unknown> = {
        channel: channelId,
        text: escapeText(`${summary} — ${url}`),
        unfurl_links: false,
        unfurl_media: false,
      };
      if (threadTs) body.thread_ts = threadTs;
      if (threadTs && replyBroadcast) body.reply_broadcast = true;
      // No app_unfurl_url: this is a proactive post, not a reply to a link_shared unfurl.
      const entity = {
        entity_type: `slack#/entities/${entityType}`,
        url,
        external_ref: { id: externalId ?? displayId ?? url, type: entityType },
        entity_payload: {
          attributes: {
            title: { text: title },
            ...(displayId && { display_id: displayId }),
            display_type: displayType,
            ...(productName && { product_name: productName }),
          },
          ...(status && { fields: { status: { value: status } } }),
        },
      };
      try {
        const data = await callSlack("chat.postMessage", token, { ...body, metadata: { entities: [entity] } }, context);
        const posted = { channelId: String(data.channel ?? channelId), ts: String(data.ts ?? "") };
        return { mode: "work_object" as const, ...(await withPermalink(posted, token, context)) };
      } catch (error) {
        if (!(error instanceof SlackApiError) || PLAIN_POST_ERRORS.has(error.code)) throw error;
        context.signal?.throwIfAborted();
        context.api?.logger?.warn(`slack-workspace: Work Object rejected; posting a plain card: ${error.message}`);
        const details = [displayType, displayId, status].filter(Boolean).map((part) => escapeText(part!));
        const blocks = [
          { type: "section", text: { type: "mrkdwn", text: `*<${url}|${escapeText(title)}>*` } },
          { type: "context", elements: [{ type: "mrkdwn", text: details.join(" · ") }] },
        ];
        const data = await callSlack("chat.postMessage", token, { ...body, blocks }, context);
        const posted = { channelId: String(data.channel ?? channelId), ts: String(data.ts ?? "") };
        return { mode: "fallback" as const, ...(await withPermalink(posted, token, context)), reason: error.message };
      }
    },
  }),
];

/** Deleting a message can't be undone, so every delete waits for a human. */
export const messagingApprovals: ApprovalRule[] = [
  {
    toolName: "slack_message_delete",
    check: ({ channelId, ts }) => ({
      title: "Delete Slack message",
      description: `Delete message ${ts} in channel ${channelId}. This can't be undone. The tool refuses messages this bot didn't post.`,
      target: `channel ${channelId}`,
    }),
  },
];
