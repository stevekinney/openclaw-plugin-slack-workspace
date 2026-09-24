import { Type } from "typebox";
import {
  callSlack,
  canvasPermalink,
  resolveToken,
  SlackApiError,
  workspaceFor,
  type SlackCallContext,
} from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { CHANNEL_ID_DESCRIPTION, type ToolFactory } from "../schemas.js";

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

/** Who a canvas access change applies to. Slack takes channels or users per call, never both. */
type CanvasAccessTarget = { channelIds: string[] } | { userIds: string[] };

type CanvasAccessLevel = "read" | "write" | "owner";

const canvasIdsParam = (kind: "Channel" | "User", example: string, note: string) =>
  Type.Optional(
    Type.Array(Type.String({ description: `${kind} ID, e.g. ${example}.` }), {
      minItems: 1,
      uniqueItems: true,
      description: `${note} Set channelIds or userIds, not both.`,
    }),
  );

const canvasTargetParams = (verb: string) => ({
  channelIds: canvasIdsParam("Channel", "C0C42LZQZGQ", `Channels to ${verb}.`),
  userIds: canvasIdsParam("User", "U0123ABCD", `Users to ${verb}.`),
});

const canvasTargetOutput = {
  channelIds: Type.Optional(Type.Array(Type.String())),
  userIds: Type.Optional(Type.Array(Type.String())),
};

/** Fail before calling Slack unless exactly one of channelIds/userIds is non-empty. */
function canvasAccessTarget(channelIds?: string[], userIds?: string[]): CanvasAccessTarget {
  const hasChannels = Boolean(channelIds?.length);
  const hasUsers = Boolean(userIds?.length);
  if (hasChannels && hasUsers) throw new Error("Set either channelIds or userIds, not both.");
  if (hasChannels) return { channelIds: channelIds! };
  if (hasUsers) return { userIds: userIds! };
  throw new Error("Set channelIds or userIds.");
}

/** Slack's field names for a target: `channel_ids` or `user_ids`. */
const slackTarget = (target: CanvasAccessTarget) =>
  "channelIds" in target ? { channel_ids: target.channelIds } : { user_ids: target.userIds };

/**
 * Grant `accessLevel` on a canvas to channels or users via `canvases.access.set`.
 * Shared by `slack_canvas_access_set` and `createCanvas`.
 */
async function setCanvasAccess(
  token: string,
  canvasId: string,
  target: CanvasAccessTarget,
  accessLevel: CanvasAccessLevel,
  context: SlackCallContext,
) {
  // A channel can read or write a canvas but can't own it.
  if (accessLevel === "owner" && "channelIds" in target) {
    throw new Error("owner access can only be granted to users, not channels.");
  }
  await callSlack(
    "canvases.access.set",
    token,
    { canvas_id: canvasId, ...slackTarget(target), access_level: accessLevel },
    context,
  );
}

/** What `createCanvas` returns. */
export const createdCanvasSchema = Type.Object(
  {
    canvasId: Type.String(),
    url: Type.Union([Type.String(), Type.Null()]),
    sharedWith: Type.Union([Type.Array(Type.String()), Type.Null()]),
    shareError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Create a canvas and optionally share it to channels. The canvas exists once create
 * succeeds, so a share failure is reported, not thrown: the caller still needs the ID
 * to retry sharing or clean it up. Shared by `slack_canvas_create` and `slack_channel_kickoff`.
 */
export async function createCanvas(
  token: string,
  {
    title,
    markdown,
    channelIds,
    accessLevel,
  }: { title: string; markdown: string; channelIds?: string[]; accessLevel?: "read" | "write" },
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
  const shareTo = channelIds?.length ? channelIds : undefined;
  let shareError: string | undefined;
  if (shareTo) {
    try {
      await setCanvasAccess(token, canvasId, { channelIds: shareTo }, accessLevel ?? "write", context);
    } catch (error) {
      // Cancellation isn't a share failure: honor it rather than returning a result.
      context.signal?.throwIfAborted();
      shareError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    canvasId,
    url: await canvasUrl(token, canvasId, context),
    sharedWith: shareError === undefined ? (shareTo ?? null) : null,
    ...(shareError === undefined ? {} : { shareError }),
  };
}

/** The channel's native canvas tab ID from `conversations.info`, or null if it has none yet. */
async function channelCanvasId(token: string, channelId: string, context: SlackCallContext) {
  const data = await callSlack("conversations.info", token, { channel: channelId }, context, true);
  const channel = (data.channel ?? {}) as { properties?: { canvas?: { file_id?: unknown } } };
  const fileId = channel.properties?.canvas?.file_id;
  return typeof fileId === "string" && fileId ? fileId : null;
}

/**
 * Resolve a channel's single canvas tab, creating it only when the channel has none.
 * A channel holds at most one, so a concurrent create surfaces as
 * `channel_canvas_already_exists`: re-read the winner's ID rather than failing.
 */
async function channelCanvasGetOrCreate(
  token: string,
  { channelId, title, markdown }: { channelId: string; title?: string; markdown?: string },
  context: SlackCallContext,
) {
  const existing = await channelCanvasId(token, channelId, context);
  if (existing) return { canvasId: existing, created: false };
  try {
    const created = await callSlack(
      "conversations.canvases.create",
      token,
      {
        channel_id: channelId,
        ...(title ? { title } : {}),
        ...(markdown ? { document_content: { type: "markdown", markdown } } : {}),
      },
      context,
    );
    return { canvasId: String(created.canvas_id ?? ""), created: true };
  } catch (error) {
    if (!(error instanceof SlackApiError) || error.code !== "channel_canvas_already_exists") {
      throw error;
    }
    const raced = await channelCanvasId(token, channelId, context);
    if (!raced) throw error;
    return { canvasId: raced, created: false };
  }
}

export const canvasTools = (tool: ToolFactory) => [
  tool({
    name: "slack_canvas_create",
    label: "Create Slack canvas",
    description:
      "Create a Slack canvas from markdown. Optionally share it to channels with read or write access; use slack_canvas_access_set to share with users or grant owner. If sharing fails, the canvas still exists: the result has sharedWith null and a shareError.",
    parameters: Type.Object({
      title: Type.String({ description: "Canvas title." }),
      markdown: Type.String({
        description: "Canvas body as markdown. Supports headings, lists, checklists, tables, code.",
      }),
      channelIds: Type.Optional(
        Type.Array(Type.String({ description: CHANNEL_ID_DESCRIPTION }), {
          uniqueItems: true,
          description: "Share the new canvas with these channels.",
        }),
      ),
      accessLevel: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("write")], {
          description: "Channel access level when channelIds is set. Default: write.",
        }),
      ),
    }),
    outputSchema: createdCanvasSchema,
    async execute({ title, markdown, channelIds, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      return createCanvas(resolveToken(config), { title, markdown, channelIds, accessLevel }, context);
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
    name: "slack_canvas_access_set",
    label: "Set Slack canvas access",
    description:
      "Grant channels or users read, write, or owner access to a canvas. Set channelIds or userIds, not both; owner applies to users only. Setting access again changes the level.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
      ...canvasTargetParams("grant access"),
      accessLevel: Type.Union(
        [Type.Literal("read"), Type.Literal("write"), Type.Literal("owner")],
        { description: "Access to grant. owner is valid for userIds only." },
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        accessLevel: Type.String(),
        ...canvasTargetOutput,
      },
      { additionalProperties: false },
    ),
    async execute({ canvasId, channelIds, userIds, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      const target = canvasAccessTarget(channelIds, userIds);
      await setCanvasAccess(resolveToken(config), canvasId, target, accessLevel, context);
      return { canvasId, accessLevel, ...target };
    },
  }),

  tool({
    name: "slack_canvas_access_delete",
    label: "Revoke Slack canvas access",
    description:
      "Revoke channels' or users' access to a canvas. Set channelIds or userIds, not both. Access can be granted again with slack_canvas_access_set.",
    parameters: Type.Object({
      canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
      ...canvasTargetParams("revoke access from"),
    }),
    outputSchema: Type.Object(
      { canvasId: Type.String(), revoked: Type.Literal(true), ...canvasTargetOutput },
      { additionalProperties: false },
    ),
    async execute({ canvasId, channelIds, userIds }, config, context) {
      context.signal?.throwIfAborted();
      const target = canvasAccessTarget(channelIds, userIds);
      await callSlack(
        "canvases.access.delete",
        resolveToken(config),
        { canvas_id: canvasId, ...slackTarget(target) },
        context,
      );
      return { canvasId, revoked: true as const, ...target };
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

  tool({
    name: "slack_canvas_channel_get_or_create",
    label: "Get or create Slack channel canvas",
    description:
      "Get the canvas tab of a channel, creating it if the channel has none yet. A channel has at most one; it shows in the channel header with no bookmark needed. Returns its canvasId either way, with created true only when this call made it. title and markdown apply only on creation: to change an existing channel canvas, use slack_canvas_edit.",
    parameters: Type.Object({
      channelId: Type.String({ description: CHANNEL_ID_DESCRIPTION }),
      title: Type.Optional(
        Type.String({ description: "Title for the canvas if it is created. Ignored if it exists." }),
      ),
      markdown: Type.Optional(
        Type.String({
          description:
            "Initial body as markdown if the canvas is created. Ignored if it exists. Omit for an empty canvas.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        channelId: Type.String(),
        created: Type.Boolean(),
        url: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, title, markdown }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const { canvasId, created } = await channelCanvasGetOrCreate(
        token,
        { channelId, title, markdown },
        context,
      );
      return { canvasId, channelId, created, url: await canvasUrl(token, canvasId, context) };
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
