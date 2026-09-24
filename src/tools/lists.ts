import { Type } from "typebox";
import { callSlack, resolveToken, type PluginConfig, type SlackCallContext } from "../client.js";
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
];
