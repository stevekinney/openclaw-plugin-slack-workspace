import { Type } from "typebox";
import { callSlack, resolveToken, SlackApiError } from "../client.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

const prompt = Type.Object(
  {
    title: Type.String({ minLength: 1, description: "Short label shown on the prompt button." }),
    message: Type.String({ minLength: 1, description: "Message sent as the user when they tap it." }),
  },
  { additionalProperties: false },
);

/**
 * Errors that mean the Agent Sessions API isn't available to this app or token yet.
 * Each one falls back to the legacy `assistant.threads.setTitle`.
 */
const RENAME_FALLBACK_ERRORS = new Set(["unknown_method", "missing_scope"]);

export const assistantTools = (tool: ToolFactory) => [
  // The bundled channel plugin never renames sessions (it only makes a threadless
  // setSuggestedPrompts call for view detection), so this doesn't compete with core.
  // Slack deprecates assistant_view in February 2027, so this prefers agents.sessions.rename
  // and keeps assistant.threads.setTitle only as the fallback.
  tool({
    name: "slack_assistant_set_title",
    label: "Set Slack assistant thread title",
    description:
      "Rename the title Slack shows for an Agent View or Assistant View thread, e.g. once you understand what the conversation is about. Only works on those Slack-managed assistant threads, not ordinary channel or DM threads.",
    parameters: Type.Object({
      channelId: channelIdParam("The assistant conversation's channel, usually a DM."),
      threadTs: Type.String({ description: "Timestamp of the assistant thread's root message." }),
      title: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "The new thread title, e.g. \"Q3 revenue questions\".",
      }),
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        threadTs: Type.String(),
        title: Type.String(),
        api: Type.Union([Type.Literal("agents.sessions"), Type.Literal("assistant.threads")], {
          description: "Which Slack API renamed the thread; `assistant.threads` is the legacy fallback.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, threadTs, title }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config, "bot");
      const args = { channel_id: channelId, thread_ts: threadTs, title };
      try {
        await callSlack("agents.sessions.rename", token, args, context);
        return { channelId, threadTs, title, api: "agents.sessions" as const };
      } catch (error) {
        if (!(error instanceof SlackApiError) || !RENAME_FALLBACK_ERRORS.has(error.code)) throw error;
        try {
          await callSlack("assistant.threads.setTitle", token, args, context);
        } catch (legacyError) {
          throw new Error(
            `${error.message}; the legacy fallback failed too: ${(legacyError as Error).message}`,
            { cause: legacyError },
          );
        }
        return { channelId, threadTs, title, api: "assistant.threads" as const };
      }
    },
  }),
  // STOPGAP: retire (or merge into core) once openclaw/openclaw#50481 ships a dynamic
  // setSuggestedPrompts message-tool action. Two code paths writing the same Slack surface
  // would be worse than this gap. As of openclaw 2026.9.5 core only makes a threadless
  // setSuggestedPrompts call for Agent View detection, never per-thread prompts.
  tool({
    name: "slack_assistant_suggest_prompts",
    label: "Suggest Slack assistant prompts",
    description:
      "Show up to four suggested follow-up prompts for an Agent View or Assistant View conversation. In Agent View they appear at the top of the Messages tab, not under a particular thread. The user can tap one to send its message. Replaces any prompts already shown. Only works on those Slack-managed assistant threads, not ordinary channel or DM threads.",
    parameters: Type.Object({
      channelId: channelIdParam("The assistant conversation's channel, usually a DM."),
      threadTs: Type.String({ description: "Timestamp of the assistant thread's root message." }),
      prompts: Type.Array(prompt, {
        minItems: 1,
        maxItems: 4,
        description: "One to four prompts, shown in order.",
      }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), threadTs: Type.String(), prompts: Type.Array(prompt) },
      { additionalProperties: false },
    ),
    async execute({ channelId, threadTs, prompts }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack(
        "assistant.threads.setSuggestedPrompts",
        resolveToken(config, "bot"),
        { channel_id: channelId, thread_ts: threadTs, prompts },
        context,
      );
      return { channelId, threadTs, prompts };
    },
  }),
];
