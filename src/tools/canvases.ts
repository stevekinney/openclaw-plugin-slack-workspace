import { Type } from "typebox";
import {
  callSlack,
  canvasPermalink,
  resolveToken,
  workspaceFor,
  type SlackCallContext,
} from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

/** Null when the workspace can't be looked up: better no link than one that 404s. */
async function canvasUrl(token: string, canvasId: string, context: SlackCallContext) {
  const workspace = await workspaceFor(token, context);
  return workspace ? canvasPermalink(workspace, canvasId) : null;
}

/** Section types `canvases.sections.lookup` can filter on. */
const SECTION_TYPES = [
  "h1",
  "h2",
  "h3",
  "any_header",
  "table",
  "list",
  "callout",
  "blockquote",
] as const;

/** What `createCanvas` returns. */
export const createdCanvasSchema = Type.Object(
  {
    canvasId: Type.String(),
    url: Type.Union([Type.String(), Type.Null()]),
    sharedWith: Type.Union([Type.String(), Type.Null()]),
    shareError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Create a canvas and optionally share it to a channel. The canvas exists once create
 * succeeds, so a share failure is reported, not thrown: the caller still needs the ID
 * to retry sharing or clean it up. Shared by `slack_canvas_create` and `slack_channel_kickoff`.
 */
export async function createCanvas(
  token: string,
  {
    title,
    markdown,
    channelId,
    accessLevel,
  }: { title: string; markdown: string; channelId?: string; accessLevel?: "read" | "write" },
  context: SlackCallContext,
) {
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
  let shareError: string | undefined;
  if (channelId) {
    try {
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
    } catch (error) {
      // Cancellation isn't a share failure: honor it rather than returning a result.
      context.signal?.throwIfAborted();
      shareError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    canvasId,
    url: await canvasUrl(token, canvasId, context),
    sharedWith: shareError === undefined ? (channelId ?? null) : null,
    ...(shareError === undefined ? {} : { shareError }),
  };
}

export const canvasTools = (tool: ToolFactory) => [
  tool({
    name: "slack_canvas_create",
    label: "Create Slack canvas",
    description:
      "Create a Slack canvas from markdown. Optionally share it to a channel with read or write access. If sharing fails, the canvas still exists: the result has sharedWith null and a shareError.",
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
    outputSchema: createdCanvasSchema,
    async execute({ title, markdown, channelId, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      return createCanvas(resolveToken(config), { title, markdown, channelId, accessLevel }, context);
    },
  }),

  tool({
    name: "slack_canvas_edit",
    label: "Edit Slack canvas",
    description:
      "Edit a Slack canvas: append markdown, prepend it, replace the whole body or one section, insert markdown before or after a section, delete a section, or rename the canvas. Get section IDs from slack_canvas_sections.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
      operation: Type.Union(
        [
          Type.Literal("append"),
          Type.Literal("prepend"),
          Type.Literal("replace"),
          Type.Literal("insert_after"),
          Type.Literal("insert_before"),
          Type.Literal("delete"),
          Type.Literal("rename"),
        ],
        { description: "Edit to perform." },
      ),
      markdown: Type.Optional(
        Type.String({
          description: "Markdown content for append, prepend, replace, insert_after, or insert_before.",
        }),
      ),
      title: Type.Optional(Type.String({ description: "New title when operation is rename." })),
      sectionId: Type.Optional(
        Type.String({
          description:
            "Section ID from slack_canvas_sections. Required for insert_after, insert_before, and delete; optional for replace (omit to replace the whole body).",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        operation: Type.String(),
        url: Type.Union([Type.String(), Type.Null()]),
      },
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
        return { canvasId, operation, url: await canvasUrl(token, canvasId, context) };
      }

      const needsSection =
        operation === "insert_after" || operation === "insert_before" || operation === "delete";
      if (needsSection && !sectionId) throw new Error(`${operation} requires sectionId.`);

      let change: Record<string, unknown>;
      if (operation === "delete") {
        change = { operation: "delete", section_id: sectionId };
      } else {
        if (!markdown) throw new Error(`${operation} requires markdown.`);
        const slackOperation =
          operation === "append"
            ? "insert_at_end"
            : operation === "prepend"
              ? "insert_at_start"
              : operation;
        change = { operation: slackOperation, document_content: { type: "markdown", markdown } };
        // append/prepend target the whole canvas; every other operation can anchor on a section.
        if (sectionId && operation !== "append" && operation !== "prepend") {
          change.section_id = sectionId;
        }
      }

      await callSlack(
        "canvases.edit",
        token,
        { canvas_id: canvasId, changes: [change] },
        context,
      );
      return { canvasId, operation, url: await canvasUrl(token, canvasId, context) };
    },
  }),

  tool({
    name: "slack_canvas_sections",
    label: "Look up Slack canvas sections",
    description:
      "Find canvas sections by type (e.g. heading level) and/or text, to get section IDs for targeted edits. Set sectionTypes, containsText, or both.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID." }),
      sectionTypes: Type.Optional(
        Type.Array(Type.Union(SECTION_TYPES.map((type) => Type.Literal(type))), {
          minItems: 1,
          uniqueItems: true,
          description: "Only return sections of these types. any_header matches h1, h2, and h3.",
        }),
      ),
      containsText: Type.Optional(
        Type.String({ description: "Only return sections containing this text." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        sections: Type.Array(
          Type.Object({ id: Type.String() }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute({ canvasId, sectionTypes, containsText }, config, context) {
      context.signal?.throwIfAborted();
      // Slack requires at least one criterion; fail clearly instead of sending `criteria: {}`.
      if (!sectionTypes?.length && !containsText) {
        throw new Error("slack_canvas_sections needs sectionTypes or containsText.");
      }
      const token = resolveToken(config);
      const criteria: Record<string, unknown> = {};
      if (sectionTypes?.length) criteria.section_types = sectionTypes;
      if (containsText) criteria.contains_text = containsText;
      const data = await callSlack(
        "canvases.sections.lookup",
        token,
        { canvas_id: canvasId, criteria },
        context,
      );
      // Curated to the ID (see "Output shaping" in schemas.ts): it's all an edit needs.
      const sections = (data.sections ?? []) as { id?: unknown }[];
      return { sections: sections.map((section) => ({ id: String(section.id ?? "") })) };
    },
  }),

  tool({
    name: "slack_canvas_delete",
    label: "Delete Slack canvas",
    description:
      "Delete a standalone Slack canvas entirely, e.g. a scratch or status canvas that is no longer needed. This cannot be undone. To remove one section instead, use slack_canvas_edit with operation delete.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
    }),
    outputSchema: Type.Object(
      { deleted: Type.Literal(true), canvasId: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ canvasId }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack("canvases.delete", resolveToken(config), { canvas_id: canvasId }, context);
      return { deleted: true as const, canvasId };
    },
  }),
];

/** `replace` overwrites and `delete` removes canvas content; Slack offers no API to restore it. */
export const canvasApprovals: ApprovalRule[] = [
  {
    toolName: "slack_canvas_delete",
    check: ({ canvasId }) => ({
      title: "Delete Slack canvas",
      description: `Delete canvas ${canvasId} entirely. The canvas and its content cannot be restored.`,
      target: `canvas ${canvasId}`,
    }),
  },
  {
    toolName: "slack_canvas_edit",
    check: ({ canvasId, operation, sectionId }) => {
      if (operation === "delete") {
        return {
          title: "Delete Slack canvas section",
          description: `Delete section ${sectionId} of canvas ${canvasId}. The deleted content cannot be restored.`,
          target: `canvas ${canvasId}`,
        };
      }
      if (operation !== "replace") return undefined;
      return {
        title: "Replace Slack canvas content",
        description: sectionId
          ? `Overwrite section ${sectionId} of canvas ${canvasId}. The previous section content cannot be restored.`
          : `Overwrite the entire body of canvas ${canvasId}. The previous content cannot be restored.`,
        target: `canvas ${canvasId}`,
      };
    },
  },
];
