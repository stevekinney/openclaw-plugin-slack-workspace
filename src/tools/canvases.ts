import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

const canvasUrl = (canvasId: string) => `https://slack.com/docs/${canvasId}`;

export const canvasTools = (tool: ToolFactory) => [
  tool({
    name: "slack_canvas_create",
    label: "Create Slack canvas",
    description:
      "Create a Slack canvas from markdown. Optionally share it to a channel with read or write access.",
    parameters: Type.Object({
      title: Type.String({ description: "Canvas title." }),
      markdown: Type.String({
        description: "Canvas body as markdown. Supports headings, lists, checklists, tables, code.",
      }),
      channelId: Type.Optional(channelIdParam("Share the new canvas with this channel.")),
      accessLevel: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("write")], {
          description: "Channel access level when channelId is set. Default: write.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        url: Type.String(),
        sharedWith: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    async execute({ title, markdown, channelId, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const created = await callSlack(
        "canvases.create",
        token,
        {
          title,
          document_content: { type: "markdown", markdown },
        },
        context,
      );
      const canvasId = String(created.canvas_id ?? "");
      if (channelId) {
        await callSlack(
          "canvases.access.set",
          token,
          {
            canvas_id: canvasId,
            channel_ids: [channelId],
            access_level: accessLevel ?? "write",
          },
          context,
        );
      }
      return { canvasId, url: canvasUrl(canvasId), sharedWith: channelId ?? null };
    },
  }),

  tool({
    name: "slack_canvas_edit",
    label: "Edit Slack canvas",
    description:
      "Edit a Slack canvas: append markdown, prepend it, replace the whole body, or rename the canvas.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
      operation: Type.Union(
        [
          Type.Literal("append"),
          Type.Literal("prepend"),
          Type.Literal("replace"),
          Type.Literal("rename"),
        ],
        { description: "Edit to perform." },
      ),
      markdown: Type.Optional(
        Type.String({ description: "Markdown content for append, prepend, or replace." }),
      ),
      title: Type.Optional(Type.String({ description: "New title when operation is rename." })),
      sectionId: Type.Optional(
        Type.String({ description: "Section ID to target when replacing one section." }),
      ),
    }),
    outputSchema: Type.Object(
      { canvasId: Type.String(), operation: Type.String(), url: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ canvasId, operation, markdown, title, sectionId }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);

      if (operation === "rename") {
        if (!title) throw new Error("rename requires title.");
        await callSlack(
          "canvases.edit",
          token,
          { canvas_id: canvasId, changes: [{ operation: "rename", title_content: title }] },
          context,
        );
        return { canvasId, operation, url: canvasUrl(canvasId) };
      }

      if (!markdown) throw new Error(`${operation} requires markdown.`);
      const slackOperation =
        operation === "append"
          ? "insert_at_end"
          : operation === "prepend"
            ? "insert_at_start"
            : "replace";
      const change: Record<string, unknown> = {
        operation: slackOperation,
        document_content: { type: "markdown", markdown },
      };
      if (slackOperation === "replace" && sectionId) change.section_id = sectionId;

      await callSlack(
        "canvases.edit",
        token,
        { canvas_id: canvasId, changes: [change] },
        context,
      );
      return { canvasId, operation, url: canvasUrl(canvasId) };
    },
  }),

  tool({
    name: "slack_canvas_sections",
    label: "Look up Slack canvas sections",
    description:
      "List sections of a canvas, optionally filtered by heading level, to get section IDs for targeted edits.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID." }),
      containsText: Type.Optional(
        Type.String({ description: "Only return sections containing this text." }),
      ),
    }),
    outputSchema: Type.Object(
      { sections: Type.Array(Type.Object({ id: Type.String() })) },
      { additionalProperties: false },
    ),
    async execute({ canvasId, containsText }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const criteria: Record<string, unknown> = {};
      if (containsText) criteria.contains_text = containsText;
      const data = await callSlack(
        "canvases.sections.lookup",
        token,
        { canvas_id: canvasId, criteria },
        context,
      );
      return { sections: data.sections ?? [] };
    },
  }),
];
