import { Type } from "typebox";
import { callSlack, resolveToken, type PluginConfig, type SlackCallContext } from "../client.js";
import {
  blocksSchema,
  channelIdParam,
  postResultSchema,
  targetParams,
  threadTsParam,
  type ToolFactory,
} from "../schemas.js";

/** Wrap plain text as the single-paragraph rich_text entity task cards expect. */
const richText = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
});

async function postOrUpdate(
  config: PluginConfig,
  args: {
    channelId: string;
    text: string;
    blocks: unknown[];
    threadTs?: string;
    updateTs?: string;
  },
  context?: SlackCallContext,
): Promise<{ channelId: string; ts: string; updated: boolean }> {
  const token = resolveToken(config, "bot");
  const body: Record<string, unknown> = {
    channel: args.channelId,
    text: args.text,
    blocks: args.blocks,
  };
  if (args.updateTs) {
    body.ts = args.updateTs;
    const data = await callSlack("chat.update", token, body, context);
    return { channelId: args.channelId, ts: String(data.ts ?? args.updateTs), updated: true };
  }
  if (args.threadTs) body.thread_ts = args.threadTs;
  const data = await callSlack("chat.postMessage", token, body, context);
  return { channelId: args.channelId, ts: String(data.ts ?? ""), updated: false };
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
      { channelId, caption, columns, rows, pageSize, threadTs, updateTs },
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
        { channelId, text: caption, blocks: [table], threadTs, updateTs },
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
    async execute({ channelId, title, tasks, threadTs, updateTs }, config, context) {
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
          channelId,
          text: `${title} — ${done}/${tasks.length} complete`,
          blocks: [plan],
          threadTs,
          updateTs,
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

      if (chartType === "pie") {
        if (!segments?.length) throw new Error("A pie chart requires `segments`.");
        chart = { type: "pie", segments };
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
      }

      return postOrUpdate(
        config,
        {
          channelId,
          text: title,
          blocks: [{ type: "data_visualization", title, chart }],
          threadTs: args.threadTs,
          updateTs: args.updateTs,
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
      channelId: channelIdParam(),
      text: Type.String({
        description:
          "Plain-text fallback used in notifications and by screen readers. Required by Slack; summarize the blocks.",
      }),
      blocks: blocksSchema,
      threadTs: threadTsParam,
      replyBroadcast: Type.Optional(
        Type.Boolean({
          description: "With threadTs, also surface the reply in the parent channel.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number() },
      { additionalProperties: false },
    ),
    async execute({ channelId, text, blocks, threadTs, replyBroadcast }, config, context) {
      context.signal?.throwIfAborted();
      const body: Record<string, unknown> = { channel: channelId, text, blocks };
      if (threadTs) body.thread_ts = threadTs;
      if (replyBroadcast) body.reply_broadcast = true;
      const data = await callSlack(
        "chat.postMessage",
        resolveToken(config, "bot"),
        body,
        context,
      );
      return { channelId, ts: String(data.ts ?? ""), blockCount: blocks.length };
    },
  }),

  tool({
    name: "slack_blocks_update",
    label: "Update Slack Block Kit message",
    description:
      "Replace the blocks of a message this app posted. Use to keep one card current — a build status, a running checklist — instead of posting a new message each time.",
    parameters: Type.Object({
      channelId: channelIdParam("The channel the message lives in."),
      ts: Type.String({ description: "Message timestamp from slack_blocks_send." }),
      text: Type.String({ description: "Updated plain-text notification fallback." }),
      blocks: blocksSchema,
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number() },
      { additionalProperties: false },
    ),
    async execute({ channelId, ts, text, blocks }, config, context) {
      context.signal?.throwIfAborted();
      const data = await callSlack(
        "chat.update",
        resolveToken(config, "bot"),
        { channel: channelId, ts, text, blocks },
        context,
      );
      return { channelId, ts: String(data.ts ?? ts), blockCount: blocks.length };
    },
  }),
];
