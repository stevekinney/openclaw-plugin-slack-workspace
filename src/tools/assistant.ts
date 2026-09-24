import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

export const assistantTools = (tool: ToolFactory) => [
  // The bundled channel plugin never calls assistant.threads.setTitle (it only makes a
  // threadless setSuggestedPrompts call for view detection), so this doesn't compete with core.
  tool({
    name: "slack_assistant_set_title",
    label: "Set Slack assistant thread title",
    description:
      "Rename the title Slack shows for an Agent View or Assistant View thread, e.g. once you understand what the conversation is about. Only works on those Slack-managed assistant threads, not ordinary channel or DM threads.",
    parameters: Type.Object({
      channelId: channelIdParam("The assistant conversation's channel, usually a DM."),
      threadTs: Type.String({ description: "Timestamp of the assistant thread's root message." }),
      title: Type.String({ minLength: 1, description: "The new thread title, e.g. \"Q3 revenue questions\"." }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), threadTs: Type.String(), title: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, threadTs, title }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack(
        "assistant.threads.setTitle",
        resolveToken(config, "bot"),
        { channel_id: channelId, thread_ts: threadTs, title },
        context,
      );
      return { channelId, threadTs, title };
    },
  }),
];
