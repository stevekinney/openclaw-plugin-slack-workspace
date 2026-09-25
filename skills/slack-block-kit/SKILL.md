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
| Prose with real bullet or numbered lists, quotes, code blocks | `slack_post_rich_text` |
| Anything else structured | `slack_blocks_send` |

The first four take plain values and build the Block Kit JSON for you. Reach for
`slack_blocks_send` only when none of them fit — it takes raw blocks and expects you
to know the schema.

## These tools or core `presentation`?

OpenClaw's core `presentation` contract also renders chart and table blocks, as
the same native `data_visualization` and `data_table`, when the reply lands in
Slack. It overlaps with `slack_post_table` and `slack_post_chart` on purpose;
each path does something the other doesn't.

| Reach for | When |
|---|---|
| Core `presentation` | You're replying in the current conversation. It's portable to other channels and more resilient: it splits more than 2 charts across follow-up messages and, on `invalid_blocks`, strips the blocks and re-sends as text. |
| These tools | You need to post proactively (another channel, a DM, from automation or a cron job) or edit a card in place (`updateTs`, or `slack_blocks_update` for raw blocks). The reply-turn `presentation` path does neither. |

The tools share Slack's limits with core — 1–20 columns, 1–200 rows, 10,000
characters of cell text per table, 2 charts per message — and reject over-limit
input before calling Slack. They don't copy core's recovery: an over-limit or
rejected post fails with an error for you to fix. Post a third chart as a
separate `slack_post_chart` call.

For contributors: don't close this gap by re-implementing the channel plugin's
splitting and text fallback here. Two copies of that logic will drift. Keep
these tools to what `presentation` can't do, and send everything else through
core.

`slack_post_rich_text` takes a flat list of `sections`, each
`{ type: "paragraph" | "quote" | "code", text }` or
`{ type: "bullet_list" | "ordered_list", items: [...] }`, and builds one `rich_text`
block. Wrap spans in `backticks` for inline code in paragraphs, quotes, and list
items; `code` sections are posted verbatim.

## Keep one card current

`slack_post_table`, `slack_post_plan`, `slack_post_chart`, and `slack_post_rich_text`
accept `updateTs`. Post once, keep the returned `ts`, then pass it as `updateTs` to
rewrite that message in place. A six-step task should be one card that changes, not
six messages.

`slack_blocks_send` does not take `updateTs`: it only posts new messages. To edit a
raw-blocks message, call `slack_blocks_update` with the `ts` that `slack_blocks_send`
returned.

## Link previews

New posts from all five tools set `unfurl_links` and `unfurl_media` to `false`,
matching the Slack channel plugin's replies, so a URL in a table cell or plan step
doesn't expand into a preview. Pass `unfurlLinks: true` or `unfurlMedia: true` when
you want the preview. Both are ignored with `updateTs`: an edit keeps the original
post's unfurl behavior, and so does `slack_blocks_update`.

## Message metadata

All five tools and `slack_blocks_update` accept an optional
`metadata: { eventType, eventPayload }`, sent as Slack's `metadata` field. Use it to
stamp a card with a machine-readable id (task id, revision) so it can be found later
without parsing its text. Use `eventType: "openclaw_card"`, this plugin's event
type, and tell cards apart by payload (e.g. `{ "digest": "open-prs" }`). Put
versions in the payload, not the type name.

To find a stamped card again, call `slack_message_get` with the `channelId` and
`eventType`, plus `matchPayload` (e.g. `{ "taskId": "T-1" }`) to pick one card.
It returns matches newest first, each with the `ts` to pass as `updateTs` (or as
`ts` to `slack_blocks_update`), so you don't need to remember timestamps. Pass `threadTs` to search one thread. The tool
reads history each time you call it. Slack doesn't push anything when metadata
changes. If `truncated` is true, it stopped before the end of the history. Narrow
the search with `oldest`/`latest` or raise `maxPages`.

## Scheduled-digest recipe

A recurring automation (an `openclaw automations` cron job) that posts a fresh
plain-text message every run fills the channel with N near-identical messages.
Rewrite its prompt so every run edits one card instead:

1. Look for the card: `slack_message_get` with the channel, a fixed `eventType`,
   and `matchPayload` naming this digest.
2. If there's a match, post with `updateTs` set to its `ts`. If not, post new and
   stamp it with the same `metadata`. Either way it's one call.
3. For history worth keeping, append the run's summary to a canvas with
   `slack_canvas_edit` (`operation: "append"`) rather than posting it.

A run can't remember the last run's `ts`. The metadata lookup is how it finds the
card again. Example prompt for the automation:

```text
Build the daily open-PR digest for channel C0123ABCD.
Call slack_message_get with channelId C0123ABCD, eventType "openclaw_card",
matchPayload { "digest": "open-prs" }. Then call slack_post_table with columns
["PR", "Author", "Age (days)"], one row per open PR, caption "Open PRs, updated
<today>", and metadata { eventType: "openclaw_card", eventPayload:
{ "digest": "open-prs" } }. If slack_message_get returned a match, pass its ts as
updateTs. Then call slack_canvas_edit on canvas F0456EFGH with operation
"append" and markdown "## <today>\n- <count> open PRs, oldest <n> days".
Post nothing else.
```

If the lookup ever comes back empty (say, someone deleted the card), the run posts
a fresh card and the next run finds that one. Swap in
`slack_post_plan` or `slack_post_chart` when the digest is a checklist or a
trend. All three take `updateTs` and `metadata`.

## No legacy `attachments`

None of these tools take Slack's legacy `attachments` parameter (colored
sidebars, `fields`, `fallback`). Slack deprecated it in favor of Block Kit for
new development. Use `context` blocks or `section` `fields` instead. For
contributors: don't add it. See "Not built on purpose" in the README.

## Raw blocks

`slack_blocks_send` passes `blocks` to Slack verbatim. `text` is required — it is the
notification preview and the screen-reader fallback.

Verified to render in messages: `header`, `section` (with `fields`), `rich_text`,
`divider`, `context`, `actions`, `table`, `card`, `carousel`, `plan`, `markdown`,
`data_table`, `data_visualization`.

`alert` is **modals only** and will not render in a message.

To let a user rate an answer 👍/👎, add a `context_actions` block with
`feedback_buttons` under it. The JSON is under "Feedback buttons" in
`references/block-kit.md`. It hasn't been live-verified yet, and this plugin
doesn't receive the clicks.

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
