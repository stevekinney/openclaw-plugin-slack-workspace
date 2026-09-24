import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { cursorParams, toPage, walkPages } from "../pagination.js";
import { blocksSchema, channelIdParam, threadTsParam, type ToolFactory } from "../schemas.js";

export const schedulingTools = (tool: ToolFactory) => [
  tool({
    name: "slack_schedule_message",
    label: "Schedule Slack message",
    description:
      "Schedule a message to post at a future time, up to 120 days out. This is the working replacement for Slack reminders, whose API Slack retired in 2023 — reminders.add reports success but nothing is retrievable. Use for time-based nudges that must actually arrive. For recurring work, use an OpenClaw automation instead.",
    parameters: Type.Object({
      channelId: channelIdParam("The message posts here."),
      text: Type.String({ description: "Message text, or the fallback when blocks are set." }),
      postAt: Type.Union([Type.String(), Type.Number()], {
        description:
          'When to post: an ISO-8601 datetime ("2026-09-23T09:00:00-06:00") or Unix seconds. Must be in the future and within 120 days.',
      }),
      blocks: Type.Optional(blocksSchema),
      threadTs: threadTsParam,
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        scheduledMessageId: Type.String(),
        postAt: Type.Number(),
        postAtIso: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, text, postAt, blocks, threadTs }, config, context) {
      context.signal?.throwIfAborted();

      const seconds =
        typeof postAt === "number" ? Math.floor(postAt) : Math.floor(Date.parse(postAt) / 1000);
      if (!Number.isFinite(seconds)) {
        throw new Error(`Could not read \`postAt\` (${postAt}) as ISO-8601 or Unix seconds.`);
      }
      const now = Math.floor(Date.now() / 1000);
      if (seconds <= now) {
        throw new Error(
          `\`postAt\` is ${now - seconds}s in the past. Slack only schedules future messages.`,
        );
      }
      if (seconds - now > 120 * 24 * 60 * 60) {
        throw new Error("Slack schedules at most 120 days ahead.");
      }

      const body: Record<string, unknown> = { channel: channelId, text, post_at: seconds };
      if (blocks) body.blocks = blocks;
      if (threadTs) body.thread_ts = threadTs;
      const data = await callSlack(
        "chat.scheduleMessage",
        resolveToken(config, "bot"),
        body,
        context,
      );
      return {
        // Slack resolves a user ID to its D… channel; slack_scheduled_cancel needs that one.
        channelId: String(data.channel ?? channelId),
        scheduledMessageId: String(data.scheduled_message_id ?? ""),
        postAt: seconds,
        postAtIso: new Date(seconds * 1000).toISOString(),
      };
    },
  }),

  tool({
    name: "slack_scheduled_list",
    label: "List scheduled Slack messages",
    description:
      "List messages this app has scheduled but not yet posted. Use to confirm a schedule landed or to find an ID to cancel. Follows Slack's pages automatically; if `hasMore` is still true, call again with the returned `cursor` for the rest.",
    parameters: Type.Object({
      channelId: Type.Optional(channelIdParam("Limit to this channel; omit for all channels.")),
      cursor: Type.Optional(
        Type.String({ description: "Resume from the `cursor` a previous call returned." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Messages per Slack page." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        scheduled: Type.Array(
          Type.Object({
            id: Type.String(),
            channelId: Type.String(),
            postAt: Type.Number(),
            postAtIso: Type.String(),
            text: Type.Optional(Type.String()),
          }),
        ),
        cursor: Type.Optional(Type.String()),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, cursor, limit }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config, "bot");
      const page = await walkPages(
        async (request) => {
          const body: Record<string, unknown> = { ...cursorParams(request) };
          if (channelId) body.channel = channelId;
          const data = await callSlack("chat.scheduledMessages.list", token, body, context);
          return toPage<Record<string, unknown>>(data, "scheduled_messages");
        },
        { cursor, limit, signal: context.signal },
      );
      return {
        scheduled: page.items.map((entry) => ({
          id: entry.id,
          channelId: entry.channel_id,
          postAt: entry.post_at,
          postAtIso: new Date(Number(entry.post_at ?? 0) * 1000).toISOString(),
          text: entry.text,
        })),
        ...(page.cursor ? { cursor: page.cursor } : {}),
        hasMore: page.hasMore,
      };
    },
  }),

  tool({
    name: "slack_scheduled_cancel",
    label: "Cancel scheduled Slack message",
    description: "Cancel a pending scheduled message. Get the ID from slack_scheduled_list.",
    parameters: Type.Object({
      channelId: channelIdParam("The channel the message was scheduled into."),
      scheduledMessageId: Type.String({ description: "ID from slack_scheduled_list." }),
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        scheduledMessageId: Type.String(),
        cancelled: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, scheduledMessageId }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack(
        "chat.deleteScheduledMessage",
        resolveToken(config, "bot"),
        { channel: channelId, scheduled_message_id: scheduledMessageId },
        context,
      );
      return { channelId, scheduledMessageId, cancelled: true };
    },
  }),
];

/** A cancelled scheduled message is gone; it cannot be restored, only rescheduled. */
export const schedulingApprovals: ApprovalRule[] = [
  {
    toolName: "slack_scheduled_cancel",
    check: ({ channelId, scheduledMessageId }) => ({
      title: "Cancel scheduled Slack message",
      description: `Cancel scheduled message ${scheduledMessageId} in channel ${channelId}. This cannot be undone.`,
      target: `channel ${channelId}`,
    }),
  },
];
