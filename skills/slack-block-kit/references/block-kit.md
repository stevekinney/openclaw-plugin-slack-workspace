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

## Feedback buttons

`context_actions` puts one-tap controls in a message's footer. Use it with a
`feedback_buttons` element to let a user rate an answer 👍/👎. You don't need a
dedicated tool. Post these blocks with `slack_blocks_send` under the answer:

```json
[
  { "type": "markdown", "text": "Here's the answer…" },
  {
    "type": "context_actions",
    "elements": [
      {
        "type": "feedback_buttons",
        "action_id": "answer_feedback",
        "positive_button": {
          "text": { "type": "plain_text", "text": "👍" },
          "accessibility_label": "Mark this answer as helpful",
          "value": "positive"
        },
        "negative_button": {
          "text": { "type": "plain_text", "text": "👎" },
          "accessibility_label": "Mark this answer as unhelpful",
          "value": "negative"
        }
      }
    ]
  }
]
```

- Max 5 elements. They must be `feedback_buttons` or `icon_button`.
- Messages only. It isn't a modal or Home tab block.
- `value` is what comes back when a user clicks. Put an answer or task id in it
  (e.g. `"positive:T-1"`) if you need to match the vote to the answer later.
- Clicks come back as `block_actions` events over the Slack channel plugin's Socket
  Mode connection, not to this plugin. The buttons render and take a click, but
  none of these tools read the vote.

**Live verification pending.** The snippet passes through `slack_blocks_send`
unchanged (mocked test). It hasn't been posted to a real workspace yet. Once it
has, move `context_actions` into the "Verified posting" table.

## Surfaces not yet tested

`container`, `context_actions` (documented above, live post pending), `file`, `image`,
`input`, `video`, `task_card` standalone (only exercised nested inside `plan`).
