# Canvas markdown

`canvases.create` and `canvases.edit` take `document_content: { type: "markdown" }`.
It's standard markdown with a few Slack additions, and it's a different dialect from
both message mrkdwn and Block Kit.

## What works

- Headings: `#`, `##`, `###`. Only these three levels are addressable by
  `slack_canvas_sections` (`h1`, `h2`, `h3`, `any_header`).
- Emphasis: `**bold**`, `*italic*`, `` `code` ``.
- Links: `[text](https://example.com)`.
- Lists: `- item`, `1. item`, and checklists with `- [ ]` and `- [x]`.
- Blockquotes: `> quoted`.
- Tables: pipe tables with a header row.
- Code blocks: triple backticks.

`slack_canvas_sections` can also filter on `table`, `list`, `callout`, and
`blockquote` sections.

## What doesn't

- Slack mrkdwn: `*bold*` is italic here, and `<https://example.com|text>` isn't a link.
- Block Kit: there are no blocks. Don't paste block JSON into a canvas.
- Raw HTML.

## Limits

- 300 cells per table. Split a bigger table or link to a List.
- 1 MiB of markdown per change. Build a large canvas with several
  `slack_canvas_edit` appends instead of one create.
