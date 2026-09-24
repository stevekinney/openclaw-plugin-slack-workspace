import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
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
];
