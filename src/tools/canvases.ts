import { readFile } from "node:fs/promises";
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
import { cursorParams, toPage, walkPages } from "../pagination.js";
import { CHANNEL_ID_DESCRIPTION, channelIdParam, type ToolFactory } from "../schemas.js";

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

type SectionType = (typeof SECTION_TYPES)[number];

/**
 * Section IDs matching `criteria` via `canvases.sections.lookup`. Slack returns only
 * opaque IDs, not section text, so callers can't disambiguate matches after the fact.
 */
async function lookupSections(
  token: string,
  canvasId: string,
  { sectionTypes, containsText }: { sectionTypes?: SectionType[]; containsText?: string },
  context: SlackCallContext,
) {
  const criteria: Record<string, unknown> = {};
  if (sectionTypes?.length) criteria.section_types = sectionTypes;
  if (containsText) criteria.contains_text = containsText;
  const data = await callSlack("canvases.sections.lookup", token, { canvas_id: canvasId, criteria }, context);
  const sections = (data.sections ?? []) as { id?: unknown }[];
  return sections.map((section) => String(section.id ?? ""));
}

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

/** Starter templates shipped in `skills/slack-canvas/templates/`. */
export const CANVAS_TEMPLATES = ["status-board", "meeting-notes", "project-brief"] as const;

type CanvasTemplate = (typeof CANVAS_TEMPLATES)[number];

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

// `src/tools/` and `dist/tools/` sit at the same depth, so this resolves from both.
const templateSource = (template: CanvasTemplate) =>
  readFile(new URL(`../../skills/slack-canvas/templates/${template}.md`, import.meta.url), "utf8");

/** Placeholder names in a template, sorted, without duplicates. */
export async function canvasTemplatePlaceholders(template: CanvasTemplate) {
  const source = await templateSource(template);
  return [...new Set([...source.matchAll(PLACEHOLDER)].map((match) => match[1]!))].sort();
}

/**
 * Fill a template's `{{placeholder}}`s in one pass, so placeholder-like text inside a
 * value is left as written. Every placeholder needs a value and every value needs a
 * placeholder: a missing one would ship literal braces, an extra one is likely a typo.
 */
export async function renderCanvasTemplate(template: CanvasTemplate, values: Record<string, string>) {
  const source = await templateSource(template);
  const names = new Set([...source.matchAll(PLACEHOLDER)].map((match) => match[1]!));
  const missing = [...names].filter((name) => !Object.hasOwn(values, name)).sort();
  if (missing.length) {
    throw new Error(`Template ${template} is missing values for: ${missing.join(", ")}.`);
  }
  const unused = Object.keys(values).filter((name) => !names.has(name)).sort();
  if (unused.length) {
    throw new Error(`Template ${template} has no placeholder for: ${unused.join(", ")}.`);
  }
  return source.replace(PLACEHOLDER, (_, name: string) => values[name]!);
}

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
  const shared = await shareCanvas(
    token,
    canvasId,
    channelIds?.length ? { channelIds } : undefined,
    accessLevel ?? "write",
    context,
  );
  return { canvasId, url: await canvasUrl(token, canvasId, context), ...shared };
}

/**
 * Share a canvas that already exists. A failure is reported, not thrown: the canvas
 * is there either way, and the caller still needs its ID to retry sharing or clean up.
 */
async function shareCanvas(
  token: string,
  canvasId: string,
  target: CanvasAccessTarget | undefined,
  accessLevel: CanvasAccessLevel,
  context: SlackCallContext,
): Promise<{ sharedWith: string[] | null; shareError?: string }> {
  if (!target) return { sharedWith: null };
  try {
    await setCanvasAccess(token, canvasId, target, accessLevel, context);
  } catch (error) {
    // Cancellation isn't a share failure: honor it rather than returning a result.
    context.signal?.throwIfAborted();
    return { sharedWith: null, shareError: error instanceof Error ? error.message : String(error) };
  }
  return { sharedWith: "channelIds" in target ? target.channelIds : target.userIds };
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

/** How `updateStatusSection` landed the section. */
type StatusAction = "created_canvas" | "inserted" | "replaced";

/**
 * Keep one agent-owned section of a channel's canvas current, leaving the rest alone.
 * The section is found by its heading text on every call, never by a remembered ID:
 * Slack doesn't promise a section keeps its ID across other people's edits. A heading
 * that matches more than one section is an error rather than a guess, since lookup
 * returns only IDs and the wrong match would overwrite someone else's content.
 */
export async function updateStatusSection(
  token: string,
  {
    channelId,
    heading,
    markdown,
    headingLevel = "h2",
    insertAfterHeading,
    title,
  }: {
    channelId: string;
    heading: string;
    markdown: string;
    headingLevel?: "h1" | "h2" | "h3";
    insertAfterHeading?: string;
    title?: string;
  },
  context: SlackCallContext,
): Promise<{ canvasId: string; action: StatusAction; sectionId: string | null }> {
  const text = heading.trim();
  if (!text || /[\r\n]/.test(text)) throw new Error("heading must be a single line of text.");
  const section = `${"#".repeat(Number(headingLevel.slice(1)))} ${text}\n\n${markdown.trim()}`;

  const { canvasId, created } = await channelCanvasGetOrCreate(
    token,
    { channelId, title, markdown: section },
    context,
  );
  if (created) return { canvasId, action: "created_canvas", sectionId: null };

  const edit = (change: Record<string, unknown>) =>
    callSlack(
      "canvases.edit",
      token,
      {
        canvas_id: canvasId,
        changes: [{ ...change, document_content: { type: "markdown", markdown: section } }],
      },
      context,
    );

  const matches = await lookupSections(
    token,
    canvasId,
    { sectionTypes: [headingLevel], containsText: text },
    context,
  );
  if (matches.length > 1) {
    throw new Error(
      `Heading "${text}" matches ${matches.length} sections of canvas ${canvasId}; use a heading no other ${headingLevel} contains.`,
    );
  }
  const [sectionId] = matches;
  if (sectionId) {
    await edit({ operation: "replace", section_id: sectionId });
    return { canvasId, action: "replaced", sectionId };
  }

  // First run: place the section under an anchor heading if it's there, else at the end.
  const [anchorId] = insertAfterHeading?.trim()
    ? await lookupSections(
        token,
        canvasId,
        { sectionTypes: ["any_header"], containsText: insertAfterHeading.trim() },
        context,
      )
    : [];
  await edit(
    anchorId ? { operation: "insert_after", section_id: anchorId } : { operation: "insert_at_end" },
  );
  return { canvasId, action: "inserted", sectionId: null };
}

/** One thread message, curated to what a transcript needs. */
export type ThreadMessage = {
  ts: string;
  /** A person (by user ID) or, for bots and integrations, a display name. */
  author: { userId: string } | { name: string };
  text: string;
};

type SlackMessage = {
  ts?: unknown;
  user?: unknown;
  username?: unknown;
  bot_id?: unknown;
  bot_profile?: { name?: unknown };
  text?: unknown;
};

/** Replies per `conversations.replies` page; Slack allows up to 1000. */
const THREAD_PAGE_LIMIT = 200;

/**
 * Read a whole thread, parent first, via `conversations.replies`. Stops after
 * `maxPages` pages and says so with `truncated`. Thread-reading tools share this
 * rather than calling `conversations.replies` themselves.
 */
export async function fetchThread(
  token: string,
  channelId: string,
  threadTs: string,
  context: SlackCallContext,
  { maxPages }: { maxPages?: number } = {},
): Promise<{ messages: ThreadMessage[]; truncated: boolean }> {
  const page = await walkPages<SlackMessage>(
    async (request) =>
      toPage(
        await callSlack(
          "conversations.replies",
          token,
          { channel: channelId, ts: threadTs, ...cursorParams(request) },
          context,
          true,
        ),
        "messages",
      ),
    { limit: THREAD_PAGE_LIMIT, maxPages, signal: context.signal },
  );
  const messages = page.items.map((message): ThreadMessage => {
    const name = message.username ?? message.bot_profile?.name ?? message.bot_id;
    return {
      ts: String(message.ts ?? ""),
      author:
        typeof message.user === "string" && message.user
          ? { userId: message.user }
          : { name: typeof name === "string" && name ? name : "unknown" },
      text: typeof message.text === "string" ? message.text : "",
    };
  });
  return { messages, truncated: page.hasMore };
}

/** Slack mrkdwn to canvas markdown: mentions, channel links, links, and HTML entities. */
function canvasText(text: string) {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "![](@$1)")
    .replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, "![](#$1)")
    .replace(/<!([^|>]+)(?:\|([^>]+))?>/g, (_, name: string, label?: string) => label ?? `@${name}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A Slack `ts` as a UTC minute, e.g. `2024-09-10 20:26 UTC`. */
function utcMinute(ts: string) {
  const date = new Date(Number(ts) * 1000);
  return Number.isNaN(date.getTime())
    ? ts
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A thread as canvas markdown: an optional caller-written summary, then a source line
 * and every message as a quoted block. With `heading`, everything nests under it,
 * so a thread appended to an existing canvas reads as one section.
 */
export function threadMarkdown({
  channelId,
  messages,
  summary,
  heading,
  permalink,
  truncated,
}: {
  channelId: string;
  messages: ThreadMessage[];
  summary?: string;
  heading?: string;
  permalink: string | null;
  truncated: boolean;
}) {
  const level = heading ? "###" : "##";
  const count = messages.length;
  const source = [
    `${count} message${count === 1 ? "" : "s"} in ![](#${channelId})`,
    ...(permalink ? [`[Open in Slack](${permalink})`] : []),
    ...(truncated ? [`only the first ${count} were fetched`] : []),
  ].join(" · ");
  const transcript = messages.map((message) => {
    const author = "userId" in message.author ? `![](@${message.author.userId})` : message.author.name;
    const text = canvasText(message.text).trim() || "_(no text)_";
    const quoted = text.split("\n").map((line) => (line ? `> ${line}` : ">"));
    return [`**${author}** · ${utcMinute(message.ts)}`, ...quoted].join("\n");
  });
  return [
    ...(heading ? [`## ${heading}`] : []),
    ...(summary ? [`${level} Summary`, summary.trim()] : []),
    `${level} Thread`,
    source,
    ...transcript,
  ].join("\n\n");
}

/** A thread's web link: `/archives/<channel>/p<ts without the dot>`. */
const threadPermalink = (origin: string, channelId: string, threadTs: string) =>
  `${origin}/archives/${channelId}/p${threadTs.replace(".", "")}`;

export const canvasTools = (tool: ToolFactory) => [
  tool({
    name: "slack_canvas_create",
    label: "Create Slack canvas",
    description:
      "Create a Slack canvas from markdown or from a starter template (status-board, meeting-notes, project-brief) whose {{placeholder}}s are filled from values. Optionally share it to channels with read or write access; use slack_canvas_access_set to share with users or grant owner. If sharing fails, the canvas still exists: the result has sharedWith null and a shareError.",
    parameters: Type.Object({
      title: Type.String({ description: "Canvas title." }),
      markdown: Type.Optional(
        Type.String({
          description:
            "Canvas body as markdown. Supports headings, lists, checklists, tables, code. Pass this or template.",
        }),
      ),
      template: Type.Optional(
        Type.Union(
          CANVAS_TEMPLATES.map((name) => Type.Literal(name)),
          {
            description:
              "Starter template for the body, instead of markdown. Placeholders: status-board: status, owner, updated, summary, done, inProgress, blocked, next. meeting-notes: date, facilitator, attendees, agenda, notes, decisions, actionItems. project-brief: owner, targetDate, problem, goals, nonGoals, approach, milestones, openQuestions.",
          },
        ),
      ),
      values: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Markdown for each of the template's placeholders, keyed by name. Every placeholder is required; unknown keys are rejected.",
        }),
      ),
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
    async execute({ title, markdown, template, values, channelIds, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      if (markdown !== undefined && template) throw new Error("Pass markdown or template, not both.");
      if (markdown === undefined && !template) throw new Error("Pass markdown or template, not neither.");
      if (values && !template) throw new Error("values only apply with template.");
      const body = template ? await renderCanvasTemplate(template, values ?? {}) : markdown!;
      return createCanvas(
        resolveToken(config),
        { title, markdown: body, channelIds, accessLevel },
        context,
      );
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
      const ids = await lookupSections(
        resolveToken(config),
        canvasId,
        { sectionTypes, containsText },
        context,
      );
      // Curated to the ID (see "Output shaping" in schemas.ts): it's all an edit needs.
      return { sections: ids.map((id) => ({ id })) };
    },
  }),

  tool({
    name: "slack_canvas_list",
    label: "List Slack canvases",
    description:
      "List standalone and channel canvases the app can see, to find a canvasId without already knowing it. Filter by channel or creator. Results are paged: if hasMore is true, call again with page + 1.",
    parameters: Type.Object({
      channelId: Type.Optional(channelIdParam("Only canvases shared in this channel.")),
      userId: Type.Optional(
        Type.String({ description: "Only canvases created by this user, e.g. U0123ABCD." }),
      ),
      page: Type.Optional(Type.Integer({ minimum: 1, description: "Page to fetch. Default: 1." })),
      count: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Canvases per page. Default: 100." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvases: Type.Array(
          Type.Object(
            {
              canvasId: Type.String(),
              title: Type.String(),
              createdBy: Type.String(),
              created: Type.Number({ description: "Unix seconds." }),
              updated: Type.Optional(Type.Number({ description: "Unix seconds." })),
              url: Type.Union([Type.String(), Type.Null()]),
              channelIds: Type.Array(Type.String(), {
                description: "Channels and DMs the canvas is shared in that the app can see.",
              }),
            },
            { additionalProperties: false },
          ),
        ),
        page: Type.Integer(),
        pages: Type.Integer(),
        total: Type.Integer(),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, userId, page, count }, config, context) {
      context.signal?.throwIfAborted();
      // Canvases are files: Slack's documented discovery path is files.list with
      // types=canvas (files:read), paged by page/count rather than a cursor.
      const body: Record<string, unknown> = { types: "canvas" };
      if (channelId) body.channel = channelId;
      if (userId) body.user = userId;
      if (page !== undefined) body.page = page;
      if (count !== undefined) body.count = count;
      const data = await callSlack("files.list", resolveToken(config), body, context, true);
      const files = (data.files ?? []) as Record<string, unknown>[];
      const paging = (data.paging ?? {}) as { page?: unknown; pages?: unknown; total?: unknown };
      const current = Number(paging.page ?? page ?? 1);
      const pages = Number(paging.pages ?? current);
      const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
      return {
        canvases: files.map((file) => ({
          canvasId: String(file.id ?? ""),
          title: String(file.title || file.name || ""),
          createdBy: String(file.user ?? ""),
          created: Number(file.created ?? 0),
          ...(typeof file.updated === "number" ? { updated: file.updated } : {}),
          url: typeof file.permalink === "string" && file.permalink ? file.permalink : null,
          channelIds: [...strings(file.channels), ...strings(file.groups), ...strings(file.ims)],
        })),
        page: current,
        pages,
        total: Number(paging.total ?? files.length),
        hasMore: current < pages,
      };
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
  tool({
    name: "slack_canvas_status_update",
    label: "Update Slack status canvas section",
    description:
      "Keep one section of a channel's canvas current, e.g. a status board a scheduled run refreshes. Finds the section by its heading text and replaces it (heading plus your markdown), leaving the rest of the canvas untouched; safe to repeat. If the section is missing it is inserted after insertAfterHeading or at the end; if the channel has no canvas, one is created holding just this section. Pick a heading no other heading of that level contains: an ambiguous heading is an error, not a guess.",
    parameters: Type.Object({
      channelId: Type.String({ description: CHANNEL_ID_DESCRIPTION }),
      heading: Type.String({
        minLength: 1,
        description:
          "Stable heading text that identifies the section, e.g. Build status. Keep it the same across runs.",
      }),
      markdown: Type.String({
        description: "Section body as markdown, written below the heading. Replaces the previous body.",
      }),
      headingLevel: Type.Optional(
        Type.Union([Type.Literal("h1"), Type.Literal("h2"), Type.Literal("h3")], {
          description: "Heading level of the section. Default: h2.",
        }),
      ),
      insertAfterHeading: Type.Optional(
        Type.String({
          description:
            "When the section doesn't exist yet, insert it after the heading containing this text. Default: the end of the canvas.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Canvas title if the channel canvas is created. Ignored if it exists." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        channelId: Type.String(),
        action: Type.Union(
          [Type.Literal("created_canvas"), Type.Literal("inserted"), Type.Literal("replaced")],
          { description: "created_canvas: made the channel canvas; inserted: added the section; replaced: rewrote it." },
        ),
        sectionId: Type.Union([Type.String(), Type.Null()], {
          description: "The section replaced. Don't reuse it: the next run looks the section up again.",
        }),
        url: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId, heading, markdown, headingLevel, insertAfterHeading, title }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const result = await updateStatusSection(
        token,
        { channelId, heading, markdown, headingLevel, insertAfterHeading, title },
        context,
      );
      return { ...result, channelId, url: await canvasUrl(token, result.canvasId, context) };
    },
  }),

  tool({
    name: "slack_canvas_from_thread",
    label: "Create Slack canvas from thread",
    description:
      "Turn a Slack thread into a canvas: fetch every message, write your summary (if given) above a transcript with a link back to the thread, then create a new canvas or append to canvasId. A new canvas is shared with the thread's channel unless channelIds or userIds say otherwise; an appended one is shared only when they are set. If sharing fails, the canvas still exists: the result has sharedWith null and a shareError.",
    parameters: Type.Object({
      channelId: Type.String({ description: CHANNEL_ID_DESCRIPTION }),
      threadTs: Type.String({
        description: "Timestamp of the thread's parent message, e.g. 1726000000.000100.",
      }),
      title: Type.Optional(
        Type.String({
          description:
            "Canvas title, or the section heading when appending. Default: Thread summary and the thread's date.",
        }),
      ),
      summary: Type.Optional(
        Type.String({
          description: "Your markdown summary of the thread (decisions, action items), placed above the transcript.",
        }),
      ),
      canvasId: Type.Optional(
        Type.String({ description: "Append to this canvas instead of creating one, e.g. F0166DCSTS7." }),
      ),
      ...canvasTargetParams("share the canvas with"),
      accessLevel: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("owner")], {
          description: "Access to grant when sharing. owner is valid for userIds only. Default: write.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        canvasId: Type.String(),
        created: Type.Boolean(),
        url: Type.Union([Type.String(), Type.Null()]),
        messageCount: Type.Integer(),
        truncated: Type.Boolean({ description: "True if the thread was too long to fetch in full." }),
        sharedWith: Type.Union([Type.Array(Type.String()), Type.Null()]),
        shareError: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(
      { channelId, threadTs, title, summary, canvasId, channelIds, userIds, accessLevel },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // Validate sharing up front so a bad target never leaves a half-made canvas behind.
      const explicit =
        channelIds?.length || userIds?.length ? canvasAccessTarget(channelIds, userIds) : undefined;
      const target = explicit ?? (canvasId ? undefined : { channelIds: [channelId] });
      const level = accessLevel ?? "write";
      if (level === "owner" && !(target && "userIds" in target)) {
        throw new Error("owner access can only be granted to users, not channels.");
      }

      const token = resolveToken(config);
      const { messages, truncated } = await fetchThread(token, channelId, threadTs, context);
      if (!messages.length) {
        throw new Error(`No messages found in thread ${threadTs} of ${channelId}.`);
      }
      const workspace = await workspaceFor(token, context);
      const heading = title ?? `Thread summary · ${utcMinute(messages[0]!.ts).slice(0, 10)}`;
      const markdown = threadMarkdown({
        channelId,
        messages,
        summary,
        heading: canvasId ? heading : undefined,
        permalink: workspace ? threadPermalink(workspace.origin, channelId, threadTs) : null,
        truncated,
      });

      let targetCanvasId: string;
      if (canvasId) {
        await callSlack(
          "canvases.edit",
          token,
          {
            canvas_id: canvasId,
            changes: [{ operation: "insert_at_end", document_content: { type: "markdown", markdown } }],
          },
          context,
        );
        targetCanvasId = canvasId;
      } else {
        const created = await callSlack(
          "canvases.create",
          token,
          { title: heading, document_content: { type: "markdown", markdown } },
          context,
        );
        targetCanvasId = String(created.canvas_id ?? "");
      }
      const shared = await shareCanvas(token, targetCanvasId, target, level, context);
      return {
        canvasId: targetCanvasId,
        created: !canvasId,
        url: await canvasUrl(token, targetCanvasId, context),
        messageCount: messages.length,
        truncated,
        ...shared,
      };
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
