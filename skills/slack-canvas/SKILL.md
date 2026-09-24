---
name: slack-canvas
description: "Writing a Slack canvas: a status board, meeting notes, a project brief, or any long-lived document in Slack. Use before slack_canvas_create or slack_canvas_edit, or when content is too long or too persistent for a message."
metadata: { "openclaw": { "emoji": "📝" } }
---

# Slack canvases

A canvas is a document, not a message. Reach for one when the content should outlive
the conversation: something people come back to, edit, or check at a glance.

## Start from a template

Slack has no canvas templating API, so this plugin ships its own. Pass `template` and
`values` to `slack_canvas_create` instead of `markdown`:

| Template | Use it for | Placeholders |
|---|---|---|
| `status-board` | A project or incident's current state | `status`, `owner`, `updated`, `summary`, `done`, `inProgress`, `blocked`, `next` |
| `meeting-notes` | One meeting's record | `date`, `facilitator`, `attendees`, `agenda`, `notes`, `decisions`, `actionItems` |
| `project-brief` | The why and what before work starts | `owner`, `targetDate`, `problem`, `goals`, `nonGoals`, `approach`, `milestones`, `openQuestions` |

```json
{
  "title": "Checkout redesign: status",
  "template": "status-board",
  "values": {
    "status": "On track",
    "owner": "Priya",
    "updated": "2026-09-23",
    "summary": "Payment step shipped behind a flag.",
    "done": "- [x] Payment step",
    "inProgress": "- [ ] Address autocomplete",
    "blocked": "Nothing blocked.",
    "next": "- [ ] Flag rollout to 10%"
  }
}
```

Every placeholder needs a value, and every value needs a placeholder. A missing or
misspelled name fails before anything reaches Slack, with the names listed. A value is
markdown and lands verbatim, so a list, a checklist, or a table works. Write "None."
rather than an empty string when a section has nothing in it, so it doesn't render as
a bare heading.

The template files live in `templates/` next to this file. Read one to see where each
value lands.

## Canvas markdown is not Block Kit

Canvases take standard markdown, not Slack mrkdwn and not Block Kit JSON. For the
dialect and its limits, read `references/canvas-markdown.md` next to this file.

## Keep one canvas current

Don't create a new canvas for each update. For a recurring status, use
`slack_canvas_status_update`, which rewrites only the section under a heading it owns.
For one-off edits, find the section with `slack_canvas_sections` and change it with
`slack_canvas_edit`.
