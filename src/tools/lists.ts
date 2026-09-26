import { Type } from "typebox";
import { callSlack, resolveToken, sleep, type PluginConfig, type SlackCallContext } from "../client.js";
import {
  accessLevelParam,
  accessTarget,
  accessTargetOutput,
  accessTargetParams,
  assertAccessLevel,
  describeAccessTargets,
  isWideReachShare,
  slackAccessTarget,
  type AccessLevel,
  type AccessTarget,
} from "../access.js";
import type { ApprovalRule } from "../approvals.js";
import { cursorParams, toPage, walkPages } from "../pagination.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";
import { fetchThread, type ThreadMessage } from "./canvases.js";

/**
 * `slack_list_export` polls `slackLists.download.get` at most this often and this many
 * times, and stops once the next poll would land past the timeout, so one tool call
 * never waits much more than half a minute. A slower export is resumed by `jobId`.
 */
const EXPORT_POLL_INTERVAL_MS = 2_000;
const EXPORT_MAX_POLLS = 10;
const EXPORT_TIMEOUT_MS = 30_000;

/** Column types `slackLists.create` accepts in a `schema`. */
const COLUMN_TYPES = [
  "text",
  "message",
  "number",
  "select",
  "multi_select",
  "date",
  "user",
  "attachment",
  "checkbox",
  "email",
  "phone",
  "channel",
  "rating",
  "vote",
  "canvas",
  "reference",
  "link",
  "created_by",
  "last_edited_by",
  "created_time",
  "last_edited_time",
  "todo_completed",
  "todo_assignee",
  "todo_due_date",
] as const;

const listColumnParam = Type.Object(
  {
    key: Type.String({ description: "Stable machine key for the column, e.g. \"status\"." }),
    name: Type.String({ description: "Column heading shown in Slack, e.g. \"Status\"." }),
    type: Type.Union(
      COLUMN_TYPES.map((type) => Type.Literal(type)),
      { description: "Column type." },
    ),
    primary: Type.Optional(
      Type.Boolean({ description: "Make this the list's primary column. It must be a text column." }),
    ),
    options: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Slack's column options, passed through verbatim in snake_case, e.g. {\"format\":\"single_select\",\"choices\":[{\"value\":\"todo\",\"label\":\"To do\",\"color\":\"red\"}]} for select, {\"precision\":2} for number, {\"format\":\"multi_entity\"} for user, {\"emoji\":\":star:\",\"max\":5} for rating.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Curated column (see "Output shaping" in schemas.ts): IDs later item writes need, not options. */
const slackListColumn = Type.Object(
  {
    id: Type.String(),
    key: Type.String(),
    name: Type.String(),
    type: Type.String(),
    primary: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

type RawColumn = Record<string, unknown>;

function curateColumn(raw: RawColumn) {
  return {
    id: String(raw.id ?? ""),
    key: String(raw.key ?? ""),
    name: String(raw.name ?? ""),
    type: String(raw.type ?? ""),
    ...(raw.is_primary_column === true ? { primary: true as const } : {}),
  };
}

/** A column as `slack_list_schema` reports it: select choices become `{ id, label }` options. */
const slackListSchemaColumn = Type.Object(
  {
    id: Type.String(),
    key: Type.String(),
    name: Type.String(),
    type: Type.String(),
    primary: Type.Optional(Type.Literal(true)),
    options: Type.Optional(
      Type.Array(Type.Object({ id: Type.String(), label: Type.String() }, { additionalProperties: false })),
    ),
  },
  { additionalProperties: false },
);

export type ListColumn = {
  id: string;
  key: string;
  name: string;
  type: string;
  primary?: true;
  options?: { id: string; label: string }[];
};

/** Select columns keep their choices under `options.choices`; each choice's `value` is its option ID. */
function schemaColumn(raw: RawColumn): ListColumn {
  const choices = (raw.options as { choices?: Record<string, unknown>[] } | undefined)?.choices;
  return {
    ...curateColumn(raw),
    ...(Array.isArray(choices)
      ? {
          options: choices.map((choice) => ({
            id: String(choice.value ?? ""),
            label: String(choice.label ?? ""),
          })),
        }
      : {}),
  };
}

/**
 * Read a list's column schema. `slackLists.items.list` with `include_list` carries the
 * parent list object, so one item is enough; `slackLists.items.info` needs an item ID.
 */
export async function fetchListSchema(
  listId: string,
  config: PluginConfig,
  context?: SlackCallContext,
): Promise<{ title?: string; columns: ListColumn[] }> {
  const data = await callSlack(
    "slackLists.items.list",
    resolveToken(config),
    { list_id: listId, include_list: true, limit: 1 },
    context,
  );
  const list = (data.list ?? {}) as { title?: unknown; list_metadata?: { schema?: RawColumn[] } };
  const schema = list.list_metadata?.schema;
  if (!Array.isArray(schema)) throw new Error(`Slack returned no schema for list ${listId}.`);
  return {
    ...(typeof list.title === "string" && list.title ? { title: list.title } : {}),
    columns: schema.map(schemaColumn),
  };
}

const normalize = (text: string) => text.trim().toLowerCase();

/** Resolve a column by ID, key, or case-insensitive name, so callers can write cells by name. */
export function findListColumn(columns: ListColumn[], name: string): ListColumn {
  const wanted = normalize(name);
  const column =
    columns.find((column) => column.id === name.trim() || column.key === name.trim()) ??
    columns.find((column) => normalize(column.name) === wanted);
  if (!column) {
    throw new Error(
      `No column "${name}" in this list. Columns: ${columns.map((column) => column.name).join(", ")}.`,
    );
  }
  return column;
}

/** Resolve a select option by ID or case-insensitive label to the option ID Slack stores. */
export function findListOption(column: ListColumn, label: string): string {
  if (!column.options) throw new Error(`Column "${column.name}" is not a select column.`);
  const wanted = normalize(label);
  const option =
    column.options.find((option) => option.id === label.trim()) ??
    column.options.find((option) => normalize(option.label) === wanted);
  if (!option) {
    throw new Error(
      `No option "${label}" in column "${column.name}". Options: ${column.options.map((option) => option.label).join(", ")}.`,
    );
  }
  return option.id;
}

/** A cell value as a caller writes it; `encodeListCell` shapes it per column type. */
export type ListCellValue = string | number | boolean | string[];

const cellValueParam = Type.Union(
  [Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())],
  {
    description:
      "Text for text columns; option labels for select; user, channel, or email IDs/addresses (one or an array); dates as YYYY-MM-DD; a number for number and rating; true/false for checkbox.",
  },
);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function textValue(column: ListColumn, value: ListCellValue): string {
  if (Array.isArray(value) || typeof value === "boolean") {
    throw new Error(`Column "${column.name}" needs a single text value.`);
  }
  return String(value);
}

function listValue(column: ListColumn, value: ListCellValue): string[] {
  if (typeof value === "boolean") throw new Error(`Column "${column.name}" can't take true or false.`);
  return Array.isArray(value) ? value : [String(value)];
}

function numberValue(column: ListColumn, value: ListCellValue): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`Column "${column.name}" needs a number, got ${JSON.stringify(value)}.`);
  }
  return number;
}

/**
 * Shape one cell the way `slackLists.items.create`/`.update` expect it for the column's
 * type: rich_text blocks for text, ID arrays for user/date/select/email/phone/channel,
 * a bare number for number/rating, and a bare boolean for checkbox.
 */
export function encodeListCell(column: ListColumn, value: ListCellValue): Record<string, unknown> {
  const cell = (key: string, encoded: unknown) => ({ column_id: column.id, [key]: encoded });
  switch (column.type) {
    case "text":
      return cell("rich_text", [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: textValue(column, value) }] },
          ],
        },
      ]);
    case "select":
    case "multi_select": {
      const labels = listValue(column, value);
      if (column.type === "select" && labels.length > 1) {
        throw new Error(`Column "${column.name}" is single-select; pass one option.`);
      }
      return cell("select", labels.map((label) => findListOption(column, label)));
    }
    case "user":
    case "todo_assignee":
      return cell("user", listValue(column, value));
    case "date":
    case "todo_due_date": {
      const dates = listValue(column, value);
      const bad = dates.find((date) => !DATE.test(date));
      if (bad !== undefined) {
        throw new Error(`Column "${column.name}" needs dates as YYYY-MM-DD, got "${bad}".`);
      }
      return cell("date", dates);
    }
    case "email":
    case "phone":
    case "channel":
      return cell(column.type, listValue(column, value));
    case "number":
    case "rating":
      return cell(column.type, numberValue(column, value));
    case "checkbox":
    case "todo_completed":
      if (typeof value !== "boolean") throw new Error(`Column "${column.name}" needs true or false.`);
      return cell("checkbox", value);
    default:
      throw new Error(`Column "${column.name}" has type ${column.type}, which this tool can't write.`);
  }
}

/**
 * Curated item (see "Output shaping" in schemas.ts). Each field keeps its column ID and
 * key, the plain-text rendering Slack sends for text-like columns, and Slack's `value`
 * verbatim; the per-type copies (`rich_text`, `user`, `select`, ...) are dropped.
 */
const slackListField = Type.Object(
  {
    columnId: Type.String(),
    key: Type.String(),
    text: Type.Optional(Type.String()),
    value: Type.Optional(Type.Unknown({ description: "Slack's cell value, passed through." })),
  },
  { additionalProperties: false },
);

const slackListItem = Type.Object(
  {
    id: Type.String(),
    parentItemId: Type.Optional(Type.String({ description: "Set on subtasks." })),
    createdBy: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.Number({ description: "Unix seconds." })),
    updatedAt: Type.Optional(Type.String({ description: "Unix seconds, as Slack sends it." })),
    fields: Type.Array(slackListField),
  },
  { additionalProperties: false },
);

type RawItem = Record<string, unknown>;

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

function curateField(raw: Record<string, unknown>) {
  return {
    columnId: String(raw.column_id ?? ""),
    key: String(raw.key ?? ""),
    ...(typeof raw.text === "string" && raw.text ? { text: raw.text } : {}),
    ...(present(raw.value) ? { value: raw.value } : {}),
  };
}

function curateItem(raw: RawItem) {
  const fields = Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]) : [];
  return {
    id: String(raw.id ?? ""),
    ...(present(raw.parent_record_id) ? { parentItemId: String(raw.parent_record_id) } : {}),
    ...(present(raw.created_by) ? { createdBy: String(raw.created_by) } : {}),
    ...(present(raw.date_created) ? { createdAt: Number(raw.date_created) } : {}),
    ...(present(raw.updated_timestamp) ? { updatedAt: String(raw.updated_timestamp) } : {}),
    fields: fields.map(curateField),
  };
}

/** One row `slack_list_from_thread` writes: the task, plus an owner and due date if known. */
export type ActionItem = { task: string; assignee?: string; dueDate?: string };

const CHECKLIST = /^(?:[-*•◦]\s*)?\[ \]\s*(.+)$/;
const DONE = /^(?:[-*•◦]\s*)?\[[xX]\]/;
const PREFIXED = /^(?:[-*•◦]\s+)?[*_]*(?:todo|action items?|action|next step)[*_]*\s*:[*_]*\s*(.+)$/i;
const BULLET = /^(?:[-*•◦]|\d+[.)])\s+(.+)$/;
const BLOCK_PHRASE = String.raw`(?:action items?|next steps|to-?dos?)`;
/** "Action items:" ending a line, or the phrase alone on its line, starts a bulleted block. */
const BLOCK_HEADING = new RegExp(
  String.raw`(?:(?:^|[\s*_])${BLOCK_PHRASE}[*_]*\s*:[*_]*|^[*_]*${BLOCK_PHRASE}[*_]*)\s*$`,
  "i",
);
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

/**
 * Pull candidate action items out of a thread, one per line: open checklist entries
 * (`- [ ] …`), lines prefixed `TODO:` or `Action item:`, and bullets under an
 * "Action items:" / "Next steps:" heading. The first mention in an item is its
 * assignee. Repeats are dropped. The text stays Slack mrkdwn; `richTextCell` renders it.
 */
export function extractActionItems(messages: ThreadMessage[]): ActionItem[] {
  const items: ActionItem[] = [];
  const seen = new Set<string>();
  const add = (task: string) => {
    const trimmed = task.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    const assignee = MENTION.exec(trimmed)?.[1];
    items.push({ task: trimmed, ...(assignee ? { assignee } : {}) });
  };
  for (const message of messages) {
    let inBlock = false;
    for (const raw of message.text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (DONE.test(line)) continue;
      const match = CHECKLIST.exec(line) ?? PREFIXED.exec(line);
      if (match) {
        add(match[1]!);
      } else if (BLOCK_HEADING.test(line)) {
        inBlock = true;
        continue;
      } else if (inBlock && BULLET.test(line)) {
        add(BULLET.exec(line)![1]!);
      } else {
        inBlock = false;
      }
    }
  }
  return items;
}

const decodeEntities = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * Rich text blocks from Slack mrkdwn: `<@U…>` and `<#C…>` become real mentions, `<url|label>`
 * a link, and `<!here>`-style broadcasts plain text, so nothing notifies from a List.
 */
function richTextBlocks(text: string): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const pushText = (segment: string) => {
    if (segment) elements.push({ type: "text", text: decodeEntities(segment) });
  };
  const token = /<([@#!]?)([^|>]+)(?:\|([^>]*))?>/g;
  let last = 0;
  for (const match of text.matchAll(token)) {
    pushText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, sigil, target, label] = match;
    if (sigil === "@") elements.push({ type: "user", user_id: target });
    else if (sigil === "#") elements.push({ type: "channel", channel_id: target });
    else if (sigil === "!") pushText(label ?? `@${target}`);
    else elements.push({ type: "link", url: target, ...(label ? { text: decodeEntities(label) } : {}) });
  }
  pushText(text.slice(last));
  return [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }];
}

/** A text cell from Slack mrkdwn, shaped as {@link richTextBlocks} describes. */
export function richTextCell(columnId: string, text: string): Record<string, unknown> {
  return { column_id: columnId, rich_text: richTextBlocks(text) };
}

/** The columns an action-item row fills: the task text, and the todo columns when present. */
function actionItemColumns(columns: ListColumn[], listId: string) {
  const task = columns.find((column) => column.primary) ?? columns.find((column) => column.type === "text");
  if (!task) throw new Error(`List ${listId} has no text column to hold the task.`);
  return {
    task,
    assignee: columns.find((column) => column.type === "todo_assignee"),
    dueDate: columns.find((column) => column.type === "todo_due_date"),
  };
}

/**
 * Share a list that already exists. A failure is reported, not thrown: the list is
 * there either way, and the caller still needs its ID to retry sharing or clean up.
 */
async function shareList(
  token: string,
  listId: string,
  target: AccessTarget | undefined,
  accessLevel: AccessLevel,
  context: SlackCallContext,
): Promise<{ sharedWith: string[] | null; shareError?: string }> {
  if (!target) return { sharedWith: null };
  try {
    await callSlack(
      "slackLists.access.set",
      token,
      { list_id: listId, ...slackAccessTarget(target), access_level: accessLevel },
      context,
    );
  } catch (error) {
    // Cancellation isn't a share failure: honor it rather than returning a result.
    context.signal?.throwIfAborted();
    return { sharedWith: null, shareError: error instanceof Error ? error.message : String(error) };
  }
  return { sharedWith: "channelIds" in target ? target.channelIds : target.userIds };
}

/** A thread's date from its parent `ts`, e.g. `2024-09-10`. */
function threadDate(ts: string) {
  const date = new Date(Number(ts) * 1000);
  return Number.isNaN(date.getTime()) ? ts : date.toISOString().slice(0, 10);
}

export const listTools = (tool: ToolFactory) => [
  tool({
    name: "slack_list_create",
    label: "Create Slack list",
    description:
      "Create a Slack List with a typed column schema, or copy an existing list as a template. Returns the new list_id and its column IDs.",
    parameters: Type.Object({
      name: Type.String({ description: "List name." }),
      schema: Type.Optional(
        Type.Array(listColumnParam, {
          minItems: 1,
          description:
            "Columns to create. Columns are fixed once the list exists, so include every one you will need. Omit when copying with copyFromListId.",
        }),
      ),
      todoMode: Type.Optional(
        Type.Boolean({
          description: "Add task-tracking columns (completed, assignee, due date) to the list.",
        }),
      ),
      copyFromListId: Type.Optional(
        Type.String({
          description: "ID of an existing list to copy columns from, e.g. F0123ABCD. Set this or schema, not both.",
        }),
      ),
      includeCopiedListRecords: Type.Optional(
        Type.Boolean({ description: "With copyFromListId, also copy the source list's items." }),
      ),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), columns: Type.Array(slackListColumn) },
      { additionalProperties: false },
    ),
    async execute(
      { name, schema, todoMode, copyFromListId, includeCopiedListRecords },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // Slack rejects the pair with invalid_copy_and_schema_args; say which to drop instead.
      if (schema && copyFromListId) throw new Error("Set schema or copyFromListId, not both.");
      if (includeCopiedListRecords !== undefined && !copyFromListId) {
        throw new Error("includeCopiedListRecords needs copyFromListId.");
      }
      const body: Record<string, unknown> = { name };
      if (schema) {
        body.schema = schema.map(({ primary, ...column }) =>
          primary === undefined ? column : { ...column, is_primary_column: primary },
        );
      }
      if (todoMode !== undefined) body.todo_mode = todoMode;
      if (copyFromListId) body.copy_from_list_id = copyFromListId;
      if (includeCopiedListRecords !== undefined) {
        body.include_copied_list_records = includeCopiedListRecords;
      }
      const data = await callSlack("slackLists.create", resolveToken(config), body, context);
      const metadata = (data.list_metadata ?? {}) as { schema?: RawColumn[] };
      return {
        listId: String(data.list_id ?? ""),
        columns: (metadata.schema ?? []).map(curateColumn),
      };
    },
  }),
  tool({
    name: "slack_list_update",
    label: "Update Slack list",
    description:
      "Change a Slack List's name, description, or todo mode in place, keeping its list_id and row IDs. Columns can't be changed after creation.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      name: Type.Optional(Type.String({ minLength: 1, description: "New list name." })),
      description: Type.Optional(
        Type.String({
          description: "New list description in Slack mrkdwn; <@U…> and <#C…> become mentions.",
        }),
      ),
      todoMode: Type.Optional(
        Type.Boolean({
          description: "Turn task-tracking columns (completed, assignee, due date) on or off.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        listId: Type.String(),
        updated: Type.Array(
          Type.Union([Type.Literal("name"), Type.Literal("description"), Type.Literal("todoMode")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute({ listId, name, description, todoMode }, config, context) {
      context.signal?.throwIfAborted();
      const body: Record<string, unknown> = { id: listId };
      const updated: ("name" | "description" | "todoMode")[] = [];
      if (name !== undefined) {
        body.name = name;
        updated.push("name");
      }
      if (description !== undefined) {
        body.description_blocks = richTextBlocks(description);
        updated.push("description");
      }
      if (todoMode !== undefined) {
        body.todo_mode = todoMode;
        updated.push("todoMode");
      }
      if (updated.length === 0) throw new Error("Set name, description, or todoMode to change.");
      await callSlack("slackLists.update", resolveToken(config), body, context);
      return { listId, updated };
    },
  }),
  tool({
    name: "slack_list_export",
    label: "Export Slack list",
    description:
      "Export a Slack List as a CSV (default) or JSON file and return its download URL. Slack builds the file asynchronously; the tool polls for up to about 30 seconds. If `ready` is false, call again with the returned `jobId` to keep waiting instead of starting a new export.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      format: Type.Optional(
        Type.Union([Type.Literal("csv"), Type.Literal("json")], { description: "File format. Default csv." }),
      ),
      includeArchived: Type.Optional(Type.Boolean({ description: "Include archived items." })),
      includeThreads: Type.Optional(
        Type.Boolean({ description: "Include each item's comment thread. JSON only." }),
      ),
      includeAttachments: Type.Optional(
        Type.Boolean({ description: "Include file attachment metadata. JSON only." }),
      ),
      jobId: Type.Optional(
        Type.String({
          description:
            "Resume waiting on an export a previous call started (its `jobId`). Pass the same format and JSON options.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        listId: Type.String(),
        jobId: Type.String(),
        format: Type.Union([Type.Literal("csv"), Type.Literal("json")]),
        status: Type.String(),
        ready: Type.Boolean(),
        downloadUrl: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(
      { listId, format = "csv", includeArchived, includeThreads, includeAttachments, jobId },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      if (format !== "json" && (includeThreads !== undefined || includeAttachments !== undefined)) {
        throw new Error('includeThreads and includeAttachments need format: "json".');
      }
      const token = resolveToken(config);
      // `download.get` must repeat the JSON options `download.start` was given.
      const jsonOptions: Record<string, unknown> = {};
      if (includeThreads !== undefined) jsonOptions.include_threads = includeThreads;
      if (includeAttachments !== undefined) jsonOptions.include_attachments = includeAttachments;

      let job = jobId;
      if (!job) {
        const start: Record<string, unknown> = { list_id: listId, format };
        if (includeArchived !== undefined) start.include_archived = includeArchived;
        const started = await callSlack("slackLists.download.start", token, { ...start, ...jsonOptions }, context);
        job = String(started.job_id);
      }

      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      let status = "IN_PROGRESS";
      for (let attempt = 1; attempt <= EXPORT_MAX_POLLS; attempt += 1) {
        const data = await callSlack(
          "slackLists.download.get",
          token,
          { list_id: listId, job_id: job, format, ...jsonOptions },
          context,
        );
        status = typeof data.status === "string" ? data.status : status;
        if (typeof data.download_url === "string" && data.download_url) {
          return { listId, jobId: job, format, status, ready: true, downloadUrl: data.download_url };
        }
        if (/FAIL|ERROR|CANCEL/i.test(status)) {
          throw new Error(`List export job ${job} ended with status ${status}.`);
        }
        if (attempt === EXPORT_MAX_POLLS || Date.now() + EXPORT_POLL_INTERVAL_MS >= deadline) break;
        await sleep(EXPORT_POLL_INTERVAL_MS, context.signal);
      }
      return { listId, jobId: job, format, status, ready: false };
    },
  }),
  tool({
    name: "slack_list_schema",
    label: "Read Slack list schema",
    description:
      "Read a Slack List's columns: each column's ID, key, name, and type, plus option IDs and labels for select columns. Use it to turn column names and option labels into the IDs item writes need.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
    }),
    outputSchema: Type.Object(
      {
        listId: Type.String(),
        title: Type.Optional(Type.String()),
        columns: Type.Array(slackListSchemaColumn),
      },
      { additionalProperties: false },
    ),
    async execute({ listId }, config, context) {
      context.signal?.throwIfAborted();
      return { listId, ...(await fetchListSchema(listId, config, context)) };
    },
  }),
  tool({
    name: "slack_list_item_create",
    label: "Create Slack list item",
    description:
      "Add an item (row) to a Slack List, filling cells by column name. Set parentItemId to add it as a subtask of an existing item. Returns the new item ID.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      fields: Type.Optional(
        Type.Record(Type.String(), cellValueParam, {
          description:
            "Initial cell values keyed by column name (or column ID/key), e.g. {\"Task\":\"Write docs\",\"Status\":\"In progress\",\"Owner\":\"U0123ABCD\"}.",
        }),
      ),
      parentItemId: Type.Optional(
        Type.String({ description: "Item ID to nest this item under as a subtask, e.g. Rec0123ABCD." }),
      ),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), itemId: Type.String(), parentItemId: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    async execute({ listId, fields, parentItemId }, config, context) {
      context.signal?.throwIfAborted();
      const body: Record<string, unknown> = { list_id: listId };
      if (parentItemId) body.parent_item_id = parentItemId;
      const entries = Object.entries(fields ?? {});
      if (entries.length > 0) {
        const { columns } = await fetchListSchema(listId, config, context);
        body.initial_fields = entries.map(([name, value]) =>
          encodeListCell(findListColumn(columns, name), value),
        );
      }
      const data = await callSlack("slackLists.items.create", resolveToken(config), body, context);
      const item = (data.item ?? {}) as { id?: unknown };
      return {
        listId,
        itemId: String(item.id ?? ""),
        ...(parentItemId ? { parentItemId } : {}),
      };
    },
  }),
  tool({
    name: "slack_list_item_update",
    label: "Update Slack list items",
    description:
      "Set cells on existing Slack List items in one batch. Each cell names its item (rowId), its column by name, and the new value; select values take option labels.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      cells: Type.Array(
        Type.Object(
          {
            rowId: Type.String({ description: "Item ID to change, e.g. Rec0123ABCD." }),
            column: Type.String({ description: "Column name (or column ID/key), e.g. \"Status\"." }),
            value: cellValueParam,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, description: "Cells to write. They can span several items." },
      ),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), updated: Type.Integer() },
      { additionalProperties: false },
    ),
    async execute({ listId, cells }, config, context) {
      context.signal?.throwIfAborted();
      const { columns } = await fetchListSchema(listId, config, context);
      const encoded = cells.map(({ rowId, column, value }) => ({
        row_id: rowId,
        ...encodeListCell(findListColumn(columns, column), value),
      }));
      await callSlack(
        "slackLists.items.update",
        resolveToken(config),
        { list_id: listId, cells: encoded },
        context,
      );
      return { listId, updated: encoded.length };
    },
  }),
  tool({
    name: "slack_list_item_delete",
    label: "Delete Slack list item",
    description: "Delete one item from a Slack List. This cannot be undone.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      itemId: Type.String({ description: "Item ID to delete, e.g. Rec0123ABCD." }),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), itemId: Type.String(), deleted: Type.Literal(true) },
      { additionalProperties: false },
    ),
    async execute({ listId, itemId }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack(
        "slackLists.items.delete",
        resolveToken(config),
        { list_id: listId, id: itemId },
        context,
      );
      return { listId, itemId, deleted: true as const };
    },
  }),
  tool({
    name: "slack_list_items_delete_multiple",
    label: "Delete Slack list items",
    description: "Delete several items from a Slack List in one call. This cannot be undone.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      itemIds: Type.Array(Type.String(), {
        minItems: 1,
        description: "Item IDs to delete, e.g. [\"Rec0123ABCD\"].",
      }),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), itemIds: Type.Array(Type.String()), deleted: Type.Integer() },
      { additionalProperties: false },
    ),
    async execute({ listId, itemIds }, config, context) {
      context.signal?.throwIfAborted();
      await callSlack(
        "slackLists.items.deleteMultiple",
        resolveToken(config),
        { list_id: listId, ids: itemIds },
        context,
      );
      return { listId, itemIds, deleted: itemIds.length };
    },
  }),
  tool({
    name: "slack_list_items_list",
    label: "List Slack list items",
    description:
      "List the items (rows) in a Slack List, including subtasks, with each cell's column ID, key, and value. Set archived to list archived items instead. Follows Slack's pages automatically; if `hasMore` is still true, call again with the returned `cursor` for the rest. Use slack_list_schema to map column IDs to names.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      archived: Type.Optional(
        Type.Boolean({ description: "true lists only archived items; omit or false for active items." }),
      ),
      cursor: Type.Optional(
        Type.String({ description: "Resume from the `cursor` a previous call returned." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Items per Slack page." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        listId: Type.String(),
        items: Type.Array(slackListItem),
        cursor: Type.Optional(Type.String()),
        hasMore: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    async execute({ listId, archived, cursor, limit }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const page = await walkPages(
        async (request) => {
          const body: Record<string, unknown> = { list_id: listId };
          if (archived !== undefined) body.archived = archived;
          Object.assign(body, cursorParams(request));
          const data = await callSlack("slackLists.items.list", token, body, context);
          return toPage<RawItem>(data, "items");
        },
        { cursor, limit, signal: context.signal },
      );
      return {
        listId,
        items: page.items.map(curateItem),
        ...(page.cursor ? { cursor: page.cursor } : {}),
        hasMore: page.hasMore,
      };
    },
  }),
  tool({
    name: "slack_list_item_info",
    label: "Read Slack list item",
    description:
      "Read one item (row) from a Slack List along with its subtasks, with each cell's column ID, key, and value.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      itemId: Type.String({ description: "Item ID, e.g. Rec0123ABCD." }),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), item: slackListItem, subtasks: Type.Array(slackListItem) },
      { additionalProperties: false },
    ),
    async execute({ listId, itemId }, config, context) {
      context.signal?.throwIfAborted();
      const data = await callSlack(
        "slackLists.items.info",
        resolveToken(config),
        { list_id: listId, id: itemId },
        context,
      );
      const subtasks = Array.isArray(data.subtasks) ? (data.subtasks as RawItem[]) : [];
      return {
        listId,
        item: curateItem((data.record ?? {}) as RawItem),
        subtasks: subtasks.map(curateItem),
      };
    },
  }),
  tool({
    name: "slack_list_access_set",
    label: "Set Slack list access",
    description:
      "Grant channels or users read, write, or owner access to a Slack List. Set channelIds or userIds, not both; owner applies to users only. Setting access again changes the level. Channel shares and owner grants wait for human approval; user read/write grants do not.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      ...accessTargetParams("grant access"),
      accessLevel: accessLevelParam,
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), accessLevel: Type.String(), ...accessTargetOutput },
      { additionalProperties: false },
    ),
    async execute({ listId, channelIds, userIds, accessLevel }, config, context) {
      context.signal?.throwIfAborted();
      const target = accessTarget(channelIds, userIds);
      assertAccessLevel(target, accessLevel);
      await callSlack(
        "slackLists.access.set",
        resolveToken(config),
        { list_id: listId, ...slackAccessTarget(target), access_level: accessLevel },
        context,
      );
      return { listId, accessLevel, ...target };
    },
  }),
  tool({
    name: "slack_list_access_delete",
    label: "Revoke Slack list access",
    description:
      "Revoke channels' or users' access to a Slack List. Set channelIds or userIds, not both. Access can be granted again with slack_list_access_set.",
    parameters: Type.Object({
      listId: Type.String({ description: "List ID, e.g. F0123ABCD." }),
      ...accessTargetParams("revoke access from"),
    }),
    outputSchema: Type.Object(
      { listId: Type.String(), revoked: Type.Literal(true), ...accessTargetOutput },
      { additionalProperties: false },
    ),
    async execute({ listId, channelIds, userIds }, config, context) {
      context.signal?.throwIfAborted();
      const target = accessTarget(channelIds, userIds);
      await callSlack(
        "slackLists.access.delete",
        resolveToken(config),
        { list_id: listId, ...slackAccessTarget(target) },
        context,
      );
      return { listId, revoked: true as const, ...target };
    },
  }),
  tool({
    name: "slack_list_from_thread",
    label: "Create Slack list from thread",
    description:
      "Turn a Slack thread's action items into List rows: fetch every message, pick out open checklist entries, TODO:/Action item: lines, and bullets under an \"Action items:\" or \"Next steps:\" heading (or take the items you pass), then add one row per item to a new to-do List or to listId. A mention in an item becomes its assignee. A new list is shared with the thread's channel unless channelIds or userIds say otherwise; an existing one is shared only when they are set. If a row or the share fails, the list still exists: the result has itemError or shareError.",
    parameters: Type.Object({
      channelId: channelIdParam(),
      threadTs: Type.String({
        description: "Timestamp of the thread's parent message, e.g. 1726000000.000100.",
      }),
      listId: Type.Optional(
        Type.String({ description: "Add rows to this list instead of creating one, e.g. F0123ABCD." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Name for a new list. Default: Action items and the thread's date." }),
      ),
      items: Type.Optional(
        Type.Array(
          Type.Object(
            {
              task: Type.String({ minLength: 1, description: "What needs doing." }),
              assignee: Type.Optional(Type.String({ description: "User ID who owns it, e.g. U0123ABCD." })),
              dueDate: Type.Optional(Type.String({ description: "Due date as YYYY-MM-DD." })),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            description:
              "Action items you've already picked out of the thread. Set this to skip automatic extraction. Assignees and due dates are written only if the list has to-do columns.",
          },
        ),
      ),
      ...accessTargetParams("share the list with"),
      accessLevel: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("owner")], {
          description: "Access to grant when sharing. owner is valid for userIds only. Default: write.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        listId: Type.String(),
        created: Type.Boolean({ description: "True if this call created the list." }),
        itemsCreated: Type.Integer(),
        itemIds: Type.Array(Type.String()),
        itemError: Type.Optional(
          Type.String({ description: "Why row creation stopped early; rows after itemIds weren't added." }),
        ),
        messageCount: Type.Integer(),
        truncated: Type.Boolean({ description: "True if the thread was too long to fetch in full." }),
        sharedWith: Type.Union([Type.Array(Type.String()), Type.Null()]),
        shareError: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(
      { channelId, threadTs, listId, name, items, channelIds, userIds, accessLevel },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      // Validate up front so a bad argument never leaves a half-filled list behind.
      const explicit =
        channelIds?.length || userIds?.length ? accessTarget(channelIds, userIds) : undefined;
      const target = explicit ?? (listId ? undefined : { channelIds: [channelId] });
      const level = accessLevel ?? "write";
      if (level === "owner" && !(target && "userIds" in target)) {
        throw new Error("owner access can only be granted to users, not channels.");
      }
      const badDate = items?.find((item) => item.dueDate !== undefined && !DATE.test(item.dueDate));
      if (badDate) throw new Error(`dueDate must be YYYY-MM-DD, got "${badDate.dueDate}".`);

      const token = resolveToken(config);
      const { messages, truncated } = await fetchThread(token, channelId, threadTs, context);
      if (!messages.length) {
        throw new Error(`No messages found in thread ${threadTs} of ${channelId}.`);
      }
      const actionItems = items ?? extractActionItems(messages);
      if (!actionItems.length) {
        throw new Error(
          `No action items found in thread ${threadTs} of ${channelId}. Pass items to add them yourself.`,
        );
      }

      let targetListId: string;
      let columns: ListColumn[];
      if (listId) {
        targetListId = listId;
        ({ columns } = await fetchListSchema(listId, config, context));
      } else {
        const data = await callSlack(
          "slackLists.create",
          token,
          {
            name: name ?? `Action items · ${threadDate(messages[0]!.ts)}`,
            todo_mode: true,
            schema: [{ key: "task", name: "Task", type: "text", is_primary_column: true }],
          },
          context,
        );
        targetListId = String(data.list_id ?? "");
        const schema = (data.list_metadata as { schema?: RawColumn[] } | undefined)?.schema;
        columns = schema?.length
          ? schema.map(schemaColumn)
          : (await fetchListSchema(targetListId, config, context)).columns;
      }

      // Slack has no batch create: one call per row, stopping at the first failure.
      const slots = actionItemColumns(columns, targetListId);
      const itemIds: string[] = [];
      let itemError: string | undefined;
      for (const item of actionItems) {
        const fields = [
          richTextCell(slots.task.id, item.task),
          ...(slots.assignee && item.assignee ? [encodeListCell(slots.assignee, [item.assignee])] : []),
          ...(slots.dueDate && item.dueDate ? [encodeListCell(slots.dueDate, item.dueDate)] : []),
        ];
        try {
          const data = await callSlack(
            "slackLists.items.create",
            token,
            { list_id: targetListId, initial_fields: fields },
            context,
          );
          itemIds.push(String((data.item as { id?: unknown } | undefined)?.id ?? ""));
        } catch (error) {
          context.signal?.throwIfAborted();
          itemError = error instanceof Error ? error.message : String(error);
          break;
        }
      }

      const shared = await shareList(token, targetListId, target, level, context);
      return {
        listId: targetListId,
        created: !listId,
        itemsCreated: itemIds.length,
        itemIds,
        ...(itemError ? { itemError } : {}),
        messageCount: messages.length,
        truncated,
        ...shared,
      };
    },
  }),
];

export const listApprovals: ApprovalRule[] = [
  {
    toolName: "slack_list_access_delete",
    check: (params) => ({
      title: "Revoke Slack list access",
      description: `Revoke access to list ${params.listId} for ${describeAccessTargets(params)}.`,
      target: `list ${params.listId}`,
    }),
  },
  {
    toolName: "slack_list_access_set",
    check: (params) => {
      if (!isWideReachShare(params)) return undefined;
      return {
        title: "Share Slack list widely",
        description: `Grant ${params.accessLevel} access to list ${params.listId} for ${describeAccessTargets(params)}. Revoking access later can't un-show what people already saw.`,
        target: `list ${params.listId}`,
      };
    },
  },
  {
    toolName: "slack_list_item_delete",
    check: ({ listId, itemId }) => ({
      title: "Delete Slack list item",
      description: `Delete item ${itemId} from list ${listId}. This cannot be undone.`,
      target: `list ${listId}`,
    }),
  },
  {
    toolName: "slack_list_items_delete_multiple",
    check: ({ listId, itemIds }) => {
      const ids = Array.isArray(itemIds) ? itemIds : [];
      return {
        title: "Delete Slack list items",
        description: `Delete ${ids.length} item(s) (${ids.join(", ")}) from list ${listId}. This cannot be undone.`,
        target: `list ${listId}`,
      };
    },
  },
];
