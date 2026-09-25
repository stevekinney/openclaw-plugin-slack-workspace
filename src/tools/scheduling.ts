import { Type } from "typebox";
import { callSlack, resolveToken, type SlackCallContext } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { cursorParams, toPage, walkPages } from "../pagination.js";
import { blocksSchema, channelIdParam, threadTsParam, type ToolFactory } from "../schemas.js";

// A time followed by `Z` or a numeric offset (`-06:00`, `+0530`, `+05`).
const explicitOffset = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

const parsePostAt = (postAt: string | number, name: string): number => {
  if (typeof postAt === "number") return Math.floor(postAt);
  const value = postAt.trim();
  // JSON callers often stringify Unix seconds; Date.parse would return NaN for these.
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.floor(Number(value));
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Could not read \`${name}\` (${postAt}) as ISO-8601 or Unix seconds.`);
  }
  // Without an offset, Date.parse falls back to the OpenClaw host's local timezone.
  if (!explicitOffset.test(value)) {
    throw new Error(
      `\`${name}\` (${postAt}) has no timezone, so it is ambiguous. Add \`Z\` or an offset like \`-06:00\`, or pass Unix seconds.`,
    );
  }
  return Math.floor(ms / 1000);
};

/** Parse a schedule time and hold it to Slack's window: in the future, at most 120 days out. */
const resolvePostAt = (postAt: string | number, name: string): number => {
  const seconds = parsePostAt(postAt, name);
  const now = Math.floor(Date.now() / 1000);
  if (seconds <= now) {
    throw new Error(
      `\`${name}\` is ${now - seconds}s in the past. Slack only schedules future messages.`,
    );
  }
  if (seconds - now > 120 * 24 * 60 * 60) {
    throw new Error("Slack schedules at most 120 days ahead.");
  }
  return seconds;
};

const channelCapNote =
  "Slack allows 30 messages per 5-minute window per channel, counted by post time; past that it fails with `restricted_too_many`, so spread post times out.";

type ScheduleRequest = {
  channelId: string;
  text: string;
  seconds: number;
  blocks?: unknown;
  threadTs?: string;
};

/** Call chat.scheduleMessage; returns the channel Slack resolved and the new message's ID. */
const scheduleMessage = async (
  token: string,
  { channelId, text, seconds, blocks, threadTs }: ScheduleRequest,
  context: SlackCallContext,
) => {
  const body: Record<string, unknown> = { channel: channelId, text, post_at: seconds };
  if (blocks) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;
  const data = await callSlack("chat.scheduleMessage", token, body, context);
  return {
    // Slack resolves a user ID to its D… channel; slack_scheduled_cancel needs that one.
    channelId: String(data.channel ?? channelId),
    scheduledMessageId: String(data.scheduled_message_id ?? ""),
  };
};

const deleteScheduledMessage = (
  token: string,
  channelId: string,
  scheduledMessageId: string,
  context: SlackCallContext,
) =>
  callSlack(
    "chat.deleteScheduledMessage",
    token,
    { channel: channelId, scheduled_message_id: scheduledMessageId },
    context,
  );

const postAtDescription =
  'an ISO-8601 datetime with an explicit offset ("2026-09-23T09:00:00-06:00" or "…Z") or Unix seconds (number or all-digit string). Datetimes without an offset are rejected as ambiguous. Must be in the future and within 120 days.';

export const schedulingTools = (tool: ToolFactory) => [
  tool({
    name: "slack_schedule_message",
    label: "Schedule Slack message",
    description: `Schedule a message to post at a future time, up to 120 days out. Use for time-based posts that must actually arrive; to remind one person, prefer slack_remind. For recurring work, use an OpenClaw automation instead. To change a pending message, use slack_schedule_reschedule. ${channelCapNote}`,
    parameters: Type.Object({
      channelId: channelIdParam("The message posts here."),
      text: Type.String({ description: "Message text, or the fallback when blocks are set." }),
      postAt: Type.Union([Type.String(), Type.Number()], {
        description: `When to post: ${postAtDescription}`,
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

      const seconds = resolvePostAt(postAt, "postAt");
      const scheduled = await scheduleMessage(
        resolveToken(config, "bot"),
        { channelId, text, seconds, blocks, threadTs },
        context,
      );
      return {
        ...scheduled,
        postAt: seconds,
        postAtIso: new Date(seconds * 1000).toISOString(),
      };
    },
  }),

  tool({
    name: "slack_schedule_reschedule",
    label: "Reschedule Slack message",
    description: `Replace a pending scheduled message with new text and/or a new time in one call. Slack has no edit method for scheduled messages, so this schedules the replacement first, then cancels the original; if the original can't be cancelled, it withdraws the replacement so only one copy stays pending. The replacement gets a new ID. ${channelCapNote}`,
    parameters: Type.Object({
      channelId: channelIdParam("The channel the original was scheduled into."),
      scheduledMessageId: Type.String({
        description: "ID of the message to replace, from slack_scheduled_list.",
      }),
      text: Type.String({
        description:
          "Full text of the replacement, or the fallback when blocks are set. Nothing carries over from the original.",
      }),
      postAt: Type.Union([Type.String(), Type.Number()], {
        description: `When to post the replacement: ${postAtDescription}`,
      }),
      blocks: Type.Optional(blocksSchema),
      threadTs: threadTsParam,
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        scheduledMessageId: Type.String(),
        replacedScheduledMessageId: Type.String(),
        postAt: Type.Number(),
        postAtIso: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(
      { channelId, scheduledMessageId, text, postAt, blocks, threadTs },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const seconds = resolvePostAt(postAt, "postAt");
      const token = resolveToken(config, "bot");

      // Schedule first: if Slack refuses the replacement (e.g. the channel cap), the
      // original is still pending and nothing was lost.
      const replacement = await scheduleMessage(
        token,
        { channelId, text, seconds, blocks, threadTs },
        context,
      );
      try {
        await deleteScheduledMessage(token, channelId, scheduledMessageId, context);
      } catch (error) {
        const reason = (error as Error).message;
        try {
          await deleteScheduledMessage(
            token,
            replacement.channelId,
            replacement.scheduledMessageId,
            context,
          );
        } catch (rollbackError) {
          throw new Error(
            `Could not cancel ${scheduledMessageId} (${reason}) or withdraw its replacement (${(rollbackError as Error).message}). Both ${scheduledMessageId} and ${replacement.scheduledMessageId} are now scheduled; cancel one with slack_scheduled_cancel.`,
            { cause: rollbackError },
          );
        }
        throw new Error(
          `Could not cancel ${scheduledMessageId} (${reason}), so withdrew the replacement ${replacement.scheduledMessageId}. Nothing changed.`,
          { cause: error },
        );
      }
      return {
        ...replacement,
        replacedScheduledMessageId: scheduledMessageId,
        postAt: seconds,
        postAtIso: new Date(seconds * 1000).toISOString(),
      };
    },
  }),

  tool({
    name: "slack_remind",
    label: "Remind in Slack",
    description:
      "Remind someone of something at a future time, up to 120 days out: give a `userId` to DM them, or a `channelId` to post in a channel. Use this instead of Slack reminders, whose API Slack began retiring in 2023 and now calls degraded or useless. The reminder is a scheduled message, so slack_scheduled_list shows it and slack_scheduled_cancel cancels it. It fires once; for a recurring reminder, set up an `openclaw automations` job that calls this tool instead of scheduling repeats by hand.",
    parameters: Type.Object({
      userId: Type.Optional(
        Type.String({
          description: "User to remind by DM, e.g. U0123ABCD. Set this or `channelId`, not both.",
        }),
      ),
      channelId: Type.Optional(
        channelIdParam("Post the reminder here. Set this or `userId`, not both."),
      ),
      text: Type.String({ description: "What to remind them of." }),
      when: Type.Union([Type.String(), Type.Number()], {
        description: `When to deliver the reminder: ${postAtDescription}`,
      }),
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        userId: Type.Optional(Type.String()),
        scheduledMessageId: Type.String(),
        postAt: Type.Number(),
        postAtIso: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute({ userId, channelId, text, when }, config, context) {
      context.signal?.throwIfAborted();
      if (Boolean(userId) === Boolean(channelId)) {
        throw new Error("Set exactly one of `userId` or `channelId`.");
      }
      // Validate the time first so a bad `when` never opens a DM.
      const seconds = resolvePostAt(when, "when");
      const token = resolveToken(config, "bot");

      let target = channelId as string;
      if (userId) {
        // Returns the existing DM when there is one, so repeat reminders share a channel.
        const opened = await callSlack("conversations.open", token, { users: userId }, context);
        const channel = opened.channel as { id?: unknown } | undefined;
        if (typeof channel?.id !== "string") {
          throw new Error(`conversations.open returned no DM channel for ${userId}.`);
        }
        target = channel.id;
      }

      const data = await callSlack(
        "chat.scheduleMessage",
        token,
        { channel: target, text, post_at: seconds },
        context,
      );
      return {
        channelId: String(data.channel ?? target),
        ...(userId ? { userId } : {}),
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
      await deleteScheduledMessage(
        resolveToken(config, "bot"),
        channelId,
        scheduledMessageId,
        context,
      );
      return { channelId, scheduledMessageId, cancelled: true };
    },
  }),
];

/** A cancelled scheduled message is gone; it cannot be restored, only rescheduled. */
export const schedulingApprovals: ApprovalRule[] = [
  {
    toolName: "slack_schedule_reschedule",
    check: ({ channelId, scheduledMessageId, postAt }) => ({
      title: "Reschedule Slack message",
      description: `Cancel scheduled message ${scheduledMessageId} in channel ${channelId} and schedule a replacement for ${postAt}. The original cannot be restored.`,
      target: `channel ${channelId}`,
    }),
  },
  {
    toolName: "slack_scheduled_cancel",
    check: ({ channelId, scheduledMessageId }) => ({
      title: "Cancel scheduled Slack message",
      description: `Cancel scheduled message ${scheduledMessageId} in channel ${channelId}. This cannot be undone.`,
      target: `channel ${channelId}`,
    }),
  },
];
