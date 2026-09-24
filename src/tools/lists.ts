import { Type } from "typebox";
import { callSlack, resolveToken, type PluginConfig, type SlackCallContext } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import type { ToolFactory } from "../schemas.js";

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
];

export const listApprovals: ApprovalRule[] = [
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
