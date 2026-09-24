# Block Kit block types — verified against live Slack (Lost Gradient, 2026-09-22)

Reference: https://docs.slack.dev/reference/block-kit/blocks (21 block types)

Tested by posting through `slack_blocks_send`. "Posts" = Slack accepted it in a DM.

## Verified posting

| Block | Notes |
|---|---|
| `header` | `text` must be `plain_text`. |
| `section` | Supports `fields` for a two-column layout. |
| `rich_text` | Real bulleted/ordered lists and inline `code` styling. The only way to get a true list. |
| `divider` | — |
| `context` | — |
| `actions` | Link buttons work. |
| `table` | Cells are `raw_text`. Basic; no pagination or sorting. |
| `card` | `title`/`subtitle`/`body` are text objects (`{type:"mrkdwn",text}`), despite the field table saying "String". Max 3 action buttons. |
| `carousel` | `elements` must each be a `card` block. Min 1, max 10. |
| `plan` | `tasks` are task-card objects *without* `type`. Each `task_id` unique. Max 50. Task `status`: `pending`, `in_progress`, `complete`, `error`. |
| `markdown` | Standard markdown, NOT Slack mrkdwn: `**bold**`, `[text](url)`, `- bullets`. 12,000 char cumulative limit. |
| `data_table` | Rich table with pagination/sorting. `caption` is required. |
| `data_visualization` | `pie`/`bar`/`area`/`line`. Max 2 per message. |

## Not available in messages

- `alert` — **modals only**. Documented surface list is `Modals`; don't send it to a channel.

## Gotchas that cost a round-trip

- `data_table` `raw_number` cells require **both** `value` (number) and `text` (string).
  Sending only one fails with `invalid_blocks`.
- `data_table` header row (row 0) must be `raw_text`; `rich_text` is not allowed in header cells.
- `data_table` needs 2–201 rows (header + 1..200) and 1–20 columns, all rows the same length, with at most 10,000 characters of cell text across the whole table (header included).
- `task_card`/`plan` `block_id` should change on every message update.
- `data_visualization` `title` max 50 chars; pie segments max 12, labels max 20 chars.

## Debugging

`invalid_blocks` alone is useless. `callSlackRaw` unpacks `response_metadata.messages`, which
returns exact JSON pointers, e.g.:

```
missing required field: value [json-pointer:/blocks/2/rows/1/2]
```

Read the pointer as `blocks[2].rows[1][2]`.

## Surfaces not yet tested

`container`, `context_actions`, `file`, `image`, `input`, `video`, `task_card` standalone
(only exercised nested inside `plan`).
