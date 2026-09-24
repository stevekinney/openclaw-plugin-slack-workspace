---
name: slack-block-kit
description: "Posting structured content to Slack — a table or comparison, a multi-step checklist or progress card, numbers worth charting, or a rich layout. Use when a Slack reply is about to become a Markdown table, a bullet list of steps, or a wall of numbers."
metadata: { "openclaw": { "emoji": "🧱" } }
---

# Structured content in Slack

Slack renders Markdown tables as unreadable text and has no checkbox syntax. When
content has shape, post the shape.

## Pick the tool

| Content | Tool |
|---|---|
| Rows and columns, any comparison | `slack_post_table` |
| Steps, checklist, progress on multi-step work | `slack_post_plan` |
| Numbers worth seeing — counts, trends, breakdowns | `slack_post_chart` |
| Anything else structured | `slack_blocks_send` |

The first three take plain values and build the Block Kit JSON for you. Reach for
`slack_blocks_send` only when none of them fit — it takes raw blocks and expects you
to know the schema.

## Keep one card current

All four tools accept `updateTs`. Post once, keep the returned `ts`, then pass it as
`updateTs` to rewrite that message in place. A six-step task should be one card that
changes, not six messages.

## Link previews

New posts from all four tools set `unfurl_links` and `unfurl_media` to `false`,
matching the Slack channel plugin's replies, so a URL in a table cell or plan step
doesn't expand into a preview. Pass `unfurlLinks: true` or `unfurlMedia: true` when
you want the preview. Both are ignored with `updateTs`: an edit keeps the original
post's unfurl behavior.

## Raw blocks

`slack_blocks_send` passes `blocks` to Slack verbatim. `text` is required — it is the
notification preview and the screen-reader fallback.

Verified to render in messages: `header`, `section` (with `fields`), `rich_text`,
`divider`, `context`, `actions`, `table`, `card`, `carousel`, `plan`, `markdown`,
`data_table`, `data_visualization`.

`alert` is **modals only** and will not render in a message.

Two that differ from expectation:

- `markdown` blocks take **standard markdown** (`**bold**`, `[text](url)`, `- item`),
  not Slack mrkdwn. Plain `section` blocks still take mrkdwn (`*bold*`, `<url|text>`).
- `card` `title`/`subtitle`/`body` are text objects (`{type:"mrkdwn",text}`), not bare
  strings, despite what the field table says.

For exact schemas, per-block limits, and the gotchas that cost a round-trip, read
`references/block-kit.md` next to this file.

## When a post is rejected

`invalid_blocks` on its own says nothing. These tools unpack Slack's
`response_metadata.messages`, which names the offending field with a JSON pointer:

```
missing required field: value [json-pointer:/blocks/2/rows/1/2]
```

Read that as `blocks[2].rows[1][2]` and fix that cell. Do not retry unchanged.
