---
name: slack-lists
description: "Designing or changing a Slack List: choosing its columns, adding rows, or keeping it in sync with outside data. Use before slack_list_create, and before scoping any tool that mirrors external records into a List."
metadata: { "openclaw": { "emoji": "📋" } }
---

# Slack Lists

A List is a table in Slack with typed columns. Create one with `slack_list_create`,
then read its column and option IDs with `slack_list_schema` before writing to it.
`slack_list_item_create` and `slack_list_item_update` accept column names and option
labels directly and resolve them for you. `slack_list_schema` is for seeing what
columns and options exist.
Read rows back with `slack_list_items_list` (pass `archived: true` for archived rows)
or one row and its subtasks with `slack_list_item_info`.
Share a list with `slack_list_access_set` (channels get read or write; users can also
get owner) and take access away with `slack_list_access_delete`.

## The schema is fixed once the list exists

`slackLists.update` accepts only `name`, `description_blocks`, and `todo_mode`. No
Slack method adds, removes, renames, or retypes a column after creation. Get the
columns right in the `slack_list_create` call:

- **Design a superset up front.** Include every column you might need, even ones
  that start empty. An unused column costs nothing; a missing one can't be added.
- **Pick types carefully.** A `text` column can't become a `select` later. If you
  want filtering or colored labels, use `select` from the start.
- **`todo_mode` is the one exception.** It's the only column-related setting
  `slackLists.update` can still change (`todoMode` in `slack_list_create`).

If the schema turns out wrong, the only fix is a new list. `copyFromListId` copies
columns (and with `includeCopiedListRecords`, items), but the new list has a new
`list_id` and every row gets a new `row_id`. Anything that stored the old IDs breaks.

## There is no upsert

Slack has no "create or update the row whose external key is X" method. Rows are
addressed only by the `row_id` Slack assigns at creation, and nothing lets you look a
row up by one of your own column values short of listing every item and matching
client-side.

## Before building a sync tool

Any tool that keeps a List in step with outside data (issues, tickets, a spreadsheet)
has to work within both constraints above:

1. **The schema must be a superset of every field the sync will ever write**, decided
   before the list is created. Adding a field later means a new list and a full
   re-sync, with every `row_id` changing.
2. **The tool must persist its own external-id → `row_id` mapping outside Slack.**
   Without it, every run either duplicates rows or lists and scans the whole list to
   find matches. Storing the external ID in its own text column helps recovery
   (you can rebuild the mapping by scanning), but it's not a lookup key.
3. **Recreating the list invalidates the mapping.** Plan a rebuild path, not just an
   incremental one.

**UNVERIFIED:** whether OpenClaw's plugin SDK gives a tool plugin any persistent
key-value storage for that mapping. Confirm it before designing a sync tool. If there
is none, the mapping needs another home (a file under a plugin-owned directory, the
calling agent's own memory, or an external store), and that choice shapes the tool.
