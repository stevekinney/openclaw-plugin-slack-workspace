# Slack Workspace — Roadmap

## Purpose

This is the execution backlog for the `slack-workspace` OpenClaw tool plugin (id
`slack-workspace`), consumed by the `ralph-pipeline` automation: it picks one
unchecked task at a time, implements it on its own branch/worktree, drives it
through review, and opens a PR. Tasks are written to be pickable independently —
each checkbox line is self-contained, and every dependency it needs already
merged is named explicitly.

## Current state

The plugin is one file, `src/index.ts` (927 lines), registering 16 tools via
`defineToolPlugin` (tools only — no hooks, no CLI, no services) across five
domains: identity/search (`slack_identity`, `slack_search`), scheduling
(`slack_schedule_message`, `slack_scheduled_list`, `slack_scheduled_cancel`),
structured messaging (`slack_post_table`, `slack_post_plan`, `slack_post_chart`,
`slack_blocks_send`, `slack_blocks_update`), canvases (`slack_canvas_create`,
`slack_canvas_edit`, `slack_canvas_sections`), and bookmarks
(`slack_bookmark_list`, `slack_bookmark_add`, `slack_bookmark_remove`). A single
`resolveToken()` picks a bot (`xoxb-`) or user (`xoxp-`) token per call, and a
single `callSlackRaw()`/`callSlack()` pair is the only HTTP boundary — every tool
goes through it. There are no module boundaries, no behavioral tests (the one
test file asserts only the static tool-name list), no git repository, and no
CI. `scripts/patch-manifest.mjs` hand-patches fields the manifest generator
drops (`configContracts.secretInputs`, `skills`) with nothing guarding that it
keeps working.

The Slack app ("Bowie", workspace `lostgradient`) grants 53 bot scopes and 6 user
scopes. Roughly half are exercised by no tool at all today: Lists
(`lists:read/write`), remote files (`remote_files:*`), usergroups
(`usergroups:read`), channel lifecycle (`channels:manage`,
`channels:write.topic`, `channels:write.invites`), message metadata
(`metadata.message:read`), assistant threads (`assistant:write`), workflow
triggers (`triggers:*`), workflow templates (`workflows.templates:*`),
`mcp:connect`, and `incoming-webhook`. One granted scope
(`workflow.steps:execute`) is for a Slack feature retired 2024-09-26 and cannot
do anything. Separately, `chat:write.public` is granted and *silently*
exercisable by every posting tool already shipped (`slack_post_table`/`plan`/
`chart`, `slack_blocks_send`) — it lets any of them post into a public channel
the bot hasn't joined, with no tool aware it's relying on it and no scope
hygiene decision recorded until this roadmap (see **Scope hygiene**).

OpenClaw ships a separate, bundled Slack **channel** plugin that already owns:
inbound/outbound chat and threads, pins/reactions/emoji, member info, native
file upload/download inside a chat turn, DM/MPIM opening, the Home tab
(`views.publish`), assistant typing/status (`assistant.threads.setStatus`), and
rendering portable `presentation` charts/tables as native
`data_visualization`/`data_table` with its own `invalid_blocks` recovery and
message-splitting. **This plugin is additive tooling for proactive/out-of-band
use (scheduled posts, live-updating cards via `updateTs`, canvases, bookmarks,
search) — it must not re-implement what the channel plugin already does.**

## Guiding principles

1. **No duplication of the bundled Slack channel plugin.** Before adding a
   tool, check whether the channel plugin already covers it (see Current
   state above, and `node_modules/openclaw/docs/channels/slack/*.md`).
2. **Scopes earn their keep through features.** Every granted scope should
   end up with an exercised code path or a documented justification — but
   scope *trimming* is deferred by the owner (see **Decisions**). An unused
   scope is first a prompt for a feature, not a removal. Broad or
   trust-sensitive scopes are kept and gated (O-02) rather than dropped.
3. **Every tool ships with mocked-fetch tests.** No PR touching `execute()`
   behavior merges without a test exercising it (Tier 0 builds the harness
   first).
4. **Token-type discipline.** Bot (`xoxb-`) vs. user (`xoxp-`) is a load-bearing
   design decision (see `resolveToken()`, `src/index.ts:13-18`) — every new
   tool states which it needs and why.
5. **PR-sized tasks.** Nothing here is XL; large findings are pre-split. If a
   task turns out bigger mid-implementation, split it further rather than
   growing the PR.
6. **Never commit secret values** — not in code, tests, docs, commit messages,
   or PR descriptions. Token/secret structure may be described; values never.
7. **Don't guess at UNVERIFIED claims.** Several tasks below carry a
   `verify:` note because the research that produced them could not confirm a
   Slack behavior without a mutating call. Confirm it as part of implementing
   the task (a real, deliberate call against `lostgradient`), don't assume the
   research's guess was right.

## How to run this roadmap

- **Repository:** github.com/stevekinney/openclaw-plugin-slack-workspace
  (private), base branch `main`. Pipeline config lives in
  `.claude/ralph-pipeline.config.md`; rules for unattended workers are in
  `CLAUDE.md`.
- **Checkbox states:** `- [ ]` = open, pipeline-eligible; `- [x]` = done;
  `- [!]` = skipped/stuck by the pipeline; **`- [~]` = human-only
  (`[MANUAL]`/`[DEFERRED]`) — invisible to the pipeline's task picker; check
  these off by hand (change to `- [x]`) once done.**
- The pipeline reads `- [ ]` checkbox lines top to bottom and works one task
  at a time. **Tasks are ordered so earlier tiers unblock later ones** — don't
  skip ahead of a task's `Depends on:` line.
- **Tasks titled `[MANUAL]` are not code changes.** They're edits to
  `~/.openclaw/openclaw.json`, the Slack app's manifest/settings on
  api.slack.com, or `openclaw automations`/`openclaw` CLI operations run by a
  human with access to those systems. They are marked `- [~]` so the
  automated pipeline never picks them up; check them off by hand once done. They are deliberately
  the last eight checkboxes in the file — **O-06** through **O-12**, plus
  **H-03** (the live webhook-bridge verification, which is `[MANUAL]` even
  though its ID prefix is `H` because it belongs with the other manual tasks
  in this section, not with H-01/H-02 back in Tier 3) — placed after every
  automatable task (69 of the 77 total checkboxes), and the pipeline
  stops once the code work is exhausted.
  (H-01 itself, unlike H-03, is fully automatable — it only writes a recipe
  doc from Slack's and OpenClaw's documented behavior, with no live run
  required; see H-01's own text.)
- **`ralph-pipeline`'s default `verify` commands don't match this project.**
  Its schema default is `npm test,npm run typecheck,npm run lint`, and this
  package has neither a `typecheck` nor a `lint` script. Set
  `verify: npm run build / npm test / npm run plugin:validate` (or whatever
  `package.json` actually defines) in `.claude/ralph-pipeline.config.md`
  before the first run.
- **Tasks marked "spike" or "research spike"** resolve an open question before
  (or instead of) shipping code. If a spike concludes a feature genuinely
  isn't buildable (e.g., blocked on a Slack platform limitation), check the
  box with a one-line note of the finding and fold the result into **Scope
  hygiene** or **Not doing** rather than leaving it open forever.
- Every task's acceptance criteria assumes `npm test`, `npm run build`,
  `openclaw plugins build --check`, and `openclaw plugins validate` all pass
  before a PR opens.
- File/line references below are accurate as of this roadmap's writing
  (pre-refactor). Once **F-04** (module split) lands, treat an `src/index.ts`
  reference as "wherever that logic now lives" — later tasks will find it via
  the new module layout, not the old line numbers.

---

## Tier 0 — Foundations

These unblock nearly everything else: a test harness, a hardened HTTP client,
module boundaries, and consistent tool metadata. Build them first so every
later task lands on top of them instead of duplicating the work per-tool.

- [ ] **F-01: Add a CI gate for build, validate, and test** — Add a CI workflow (or documented local pre-commit script) that runs `npm run build`, `openclaw plugins build --check`, `openclaw plugins validate`, and `npm test` on every change, so a 16-tool, 900+-line plugin stops shipping unreviewed regressions.
  - Why: there is currently no CI and no enforcement that the manifest, build, and tests stay in sync; `openclaw.plugin.json` already drifts from `src/index.ts` today (stale description).
  - Scope(s) & token type: none (repo tooling only).
  - API methods: none.
  - Files to touch: `.github/workflows/ci.yml` (or equivalent), `package.json` scripts.
  - Depends on: none (requires the manual git-init precondition in "How to run this roadmap").
  - Acceptance criteria: pushing a branch that fails `npm test` or `openclaw plugins validate` fails CI; a clean branch passes all four checks.
  - Tests: CI config exercised by a deliberately-broken throwaway commit during implementation (reverted before merge).
  - Size: S

- [ ] **F-02: Build a mocked-fetch test harness and cover existing execute() bodies** — Add a `withMockFetch`-style helper (following OpenClaw's `plugin-sdk` test-env conventions) and use it to cover the validation logic that currently has zero tests: row/column-width mismatch (`slack_post_table`), series/category mismatch (`slack_post_chart`), `postAt` bounds (past, >120 days), and the `missing_scope`/`not_allowed_token_type` error-hint text.
  - Why: `src/index.test.ts` (26 lines) only asserts the static tool-name list; none of the 927 lines of execute()-body logic has a single behavioral test, and every task below that touches behavior needs somewhere to put its test.
  - Scope(s) & token type: none (test infra).
  - API methods: none (fetch is mocked).
  - Files to touch: `src/test-utils.ts` (new), `src/index.test.ts`, `vitest.config.ts`.
  - Depends on: none.
  - Acceptance criteria: a reusable mock-fetch helper exists; at least 5 new passing tests cover the cases listed above; `npm test` runs them.
  - Tests: this task *is* the tests.
  - Size: M

- [ ] **F-03: Harden the shared Slack HTTP client (response guard, 429 backoff, richer hints, logging)** — In `callSlackRaw` (`src/index.ts:41-86`), guard `response.json()` against non-JSON bodies, add bounded retry with `Retry-After` handling on HTTP 429/`ratelimited`, extend the error-hint table with `cant_update_message` and the canvas/list error codes found during research (`free_teams_cannot_create_standalone_canvases`, `channel_canvas_already_exists`, `canvas_too_large`, `canvas_editing_locked`, `invalid_primary_column`, `over_column_maximum`), and add call-level logging (method, elapsed time, ok/error outcome — never tokens or full bodies).
  - Why: every one of the 16 tools goes through this one function, so fixing it once fixes rate-limit handling, error clarity, and observability everywhere at once; the bundled Slack channel plugin already retries 429s up to twice honoring `Retry-After` (`docs/channels/slack/messaging.md`) and this plugin currently has zero handling for that. Cursor pagination is split out into **F-07** so I-05/L-05 aren't serialized behind this larger PR.
  - Scope(s) & token type: none (client-layer change, all existing scopes apply).
  - API methods: none new; affects every method already called.
  - Files to touch: `src/index.ts` (or its successor after F-04).
  - Depends on: F-02 (need the mock-fetch harness to test retry/backoff and non-JSON-body paths).
  - Acceptance criteria: a non-JSON 500 raises a clear error instead of a raw `SyntaxError`; a 429 with `Retry-After` retries up to 2 times before failing; `cant_update_message` and the canvas/list codes above get one-line hints; a Slack call logs method/elapsed/outcome with no secret values.
  - Tests: mocked-fetch tests for a non-JSON 500, a 429-then-success, and each new hint code.
  - Size: M

- [ ] **F-07: Extract a standalone cursor-pagination helper** — Split out of F-03 (see nit there): add a small cursor-pagination helper (`cursor`/`limit` request params, `response_metadata.next_cursor` walking) that any tool can opt into, independent of the response-guard/429-backoff/hint-table/logging work.
  - Why: I-05 (`slack_scheduled_list`) and L-05 (Lists read tools) need only this helper, not the rest of F-03's larger PR; splitting it lets those land without waiting on F-03's full review, consistent with guiding principle 5 ("split further rather than growing the PR").
  - Scope(s) & token type: none (client-layer change).
  - API methods: none new.
  - Files to touch: `src/client.ts` (or `src/index.ts` pre-F-04).
  - Depends on: F-02.
  - Acceptance criteria: a helper exists that, given a fetch-a-page function, walks `next_cursor` until exhausted or returns `{items, cursor, hasMore}` for manual walking; used by at least one caller by the time I-05/L-05 land.
  - Tests: mocked two-page and three-page cursor responses; a response with no `next_cursor` terminates after one page.
  - Size: S

- [ ] **F-04: Split src/index.ts into modules (client, schemas, per-domain tools)** — Break the single 927-line file into at minimum: a Slack client module (fetch/retry/token resolution from F-03/F-07), a shared-schemas module (including one canonical `channelId` schema fragment, replacing the several inconsistently-worded inline copies — confirmed at `src/index.ts:167,321,415,651,692,723-724,866,886,911`, not just four), and per-domain tool modules (messaging, canvases, bookmarks, scheduling/search), re-exported from a thin `src/index.ts`.
  - Why: every fix in this roadmap currently touches the same 927-line file, which makes diffs hard to review and raises the chance of an unrelated regression; this also sets up the later `definePluginEntry` migration (O-01) to touch a smaller surface.
  - Scope(s) & token type: none (structural).
  - API methods: none (no behavior change).
  - Files to touch: `src/index.ts`, new `src/client.ts`, `src/schemas.ts`, `src/tools/*.ts`.
  - Depends on: F-03, F-07 (avoid refactoring mid-hardening, and land the pagination-helper split first since it also touches the client module).
  - Acceptance criteria: `openclaw plugins validate` and `openclaw plugins inspect slack-workspace --runtime --json` show the same 16 tool names, unchanged behavior; `npm test` still passes with no test rewritten to accommodate the split (only import paths change).
  - Tests: existing F-02/F-03 tests pass unmodified except import paths.
  - Size: L

- [ ] **F-05: Add outputSchema, toolMetadata, and integer/length constraints to every tool** — Add `outputSchema` to the 8 tools that lack one (`slack_identity`, `slack_search`, `slack_scheduled_list`, `slack_scheduled_cancel`, `slack_canvas_sections`, `slack_bookmark_list`, `slack_bookmark_add`, `slack_bookmark_remove`); add side-effect metadata (`sideEffecting`, `replaySafe`, `profiles: ["messaging"]`) to all 16; change `count`/`page` (`slack_search`, `src/index.ts:238,240`) and `pageSize` (`slack_post_table`, `src/index.ts:452`) from `Type.Number()` to `Type.Integer()`; add `maxLength`/uniqueness constraints for the limits `slack_post_chart` only documents in prose today (title ≤50 chars, labels ≤20 chars, unique series names — `src/index.ts:556,569,586`).
  - Why: 8 tools give Code Mode/Tool Search no typed output hint; none declare side-effect metadata that would let the host apply default safety profiles; documented-but-unenforced limits currently round-trip to Slack as an opaque `invalid_blocks` instead of failing fast with a clear message.
  - **Verify before implementing the metadata half:** this plugin still uses `defineToolPlugin` (the `definePluginEntry` migration is O-01, Tier 0.5, which lands right after this tier). The local `sdk-entrypoints/define-tool-plugin.md` and `tool-plugins.md` docs only document `outputSchema` and `optional` as fields `tool()` surfaces into the generated manifest — `sideEffecting`/`replaySafe`/`profiles` are only shown in `building-plugins.md`'s `definePluginEntry`/`api.registerTool` example and in `manifest/capabilities.md`'s hand-authored `openclaw.plugin.json` `toolMetadata` map. Whether `defineToolPlugin`'s `tool()` accepts these fields at all is UNVERIFIED. Confirm with `openclaw plugins inspect slack-workspace --runtime --json` after a trial build before writing them into `tool()` calls. If `tool()` does not emit them: route these three fields through `scripts/patch-manifest.mjs` instead (the same pattern it already uses for `configContracts.secretInputs`/`skills`), which makes this task depend on **F-06** as well; or — preferred now that O-01 is confirmed — defer this part of F-05 to O-01, where `api.registerTool` accepts it, shipping only `outputSchema` and the integer/length constraints now.
  - Scope(s) & token type: none (schema-only).
  - API methods: none.
  - Files to touch: `src/schemas.ts`, `src/tools/*.ts` (post-F-04), possibly `scripts/patch-manifest.mjs`.
  - Depends on: F-04; F-06 as well if the `patch-manifest.mjs` fallback is needed (confirm during implementation).
  - Acceptance criteria: all 16 tools have `outputSchema`; `openclaw plugins inspect slack-workspace --runtime --json` shows the `toolMetadata` fields actually present in the built manifest via whichever mechanism (native `tool()` field or patch-manifest) was confirmed to work; a chart call with a 21-character label or a duplicate series name fails local schema validation, not a Slack round-trip; `openclaw plugins validate` still passes.
  - Tests: schema-validation tests for the new length/uniqueness/integer constraints (reject bad input, accept boundary-valid input).
  - Size: M

- [ ] **F-06: Pin the OpenClaw dev dependency and guard the manifest patch step** — Pin `devDependencies.openclaw` (currently `"latest"`, `package.json:25`) to the version recorded in `openclaw.build.openclawVersion` (`2026.9.5`); fix `tsconfig.json`'s `include` (currently `["src/index.ts"]` only) to cover test files; add a test or CI step asserting `openclaw.plugin.json` still contains `configContracts.secretInputs` (botToken, userToken) and `skills: ["./skills"]` after a bare `openclaw plugins build` run, since `scripts/patch-manifest.mjs`'s own comment says the generator drops both.
  - Why: a floating `latest` devDependency means two contributors get two different plugin-API surfaces from the same commit, exactly the drift OpenClaw's own plugin docs warn against; nothing today catches `patch-manifest.mjs`'s effect being silently lost if someone runs the bare `openclaw plugins build` command the docs themselves recommend for troubleshooting.
  - Scope(s) & token type: none.
  - API methods: none.
  - Files to touch: `package.json`, `tsconfig.json`, `scripts/patch-manifest.mjs` or a new test asserting its output.
  - Depends on: F-01.
  - Acceptance criteria: `devDependencies.openclaw` matches `compat`/`build.openclawVersion` (or CI fails the mismatch); `tsc` type-checks test files; a test fails if `configContracts.secretInputs` or `skills` disappears from the built manifest.
  - Tests: the guard test itself, run against a real `plugin:build` invocation in CI.
  - Size: S

---

## Tier 0.5 — Plugin entry migration (confirmed)

The owner confirmed the move to the fuller plugin API (see **Decisions**). These
land right after Tier 0 so hooks, approvals and the doctor CLI exist before any
new trust-sensitive tool is written.

- [ ] **O-01: Migrate slack-workspace from defineToolPlugin to definePluginEntry** — `defineToolPlugin` (`src/index.ts:184-188`) "only adds agent-callable tools: no channel, model provider, hook, service, or setup backend" (confirmed live: `openclaw plugins inspect slack-workspace --runtime --json` shows `hookCount: 0`). Every feature needing `api.on(...)` hooks (permission requests, message-sending policy) or `api.registerCli(...)` (a doctor subcommand) requires `definePluginEntry`. Hand-author `openclaw.plugin.json` going forward (the delta from today is smaller than it looks, since `scripts/patch-manifest.mjs` already hand-patches it) and keep the 16 (by then, many more) tool definitions via `api.registerTool`.
  - Why: gates permission requests (O-02), a scope-audit doctor CLI (O-03), and (eventually, as separate future work) `link_shared` unfurl handling and modal `view_submission` round-tripping. Confirmed by the owner (see **Decisions**) and scheduled directly after Tier 0 so that every later tool is written against `definePluginEntry`/`api.registerTool` rather than migrated afterwards.
  - Scope(s) & token type: none (architecture change).
  - API methods: none directly; affects how every existing tool is registered.
  - Files to touch: `src/index.ts` (entry point), `openclaw.plugin.json` (now hand-authored), `scripts/patch-manifest.mjs` (retire once hand-authored, or repurpose).
  - Depends on: F-04, F-05 (migrate the already-modularized, already-schema-complete version, not the original monolith).
  - Acceptance criteria: the plugin exposes the same tool set (verified via `openclaw plugins inspect slack-workspace --runtime --json` `toolNames`), registers at least one hook (`hookCount > 0`), and `openclaw plugins validate` passes.
  - Tests: existing tool tests pass unchanged; a new test confirms at least one hook is registered.
  - Size: L

- [ ] **O-02: Add before_tool_call permission requests for destructive operations** — No tool in this plugin requests approval before executing. `slack_canvas_edit` (`replace`/`delete` operations), `slack_bookmark_remove`, `slack_scheduled_cancel`, and S-01/S-02's channel-lifecycle tools are all irreversible, hard-to-undo, or disruptive. Use `api.on("before_tool_call", ...)` returning `requireApproval` with an `external-post`-style scope.
  - Why: the workspace already has `channels.slack.execApprovals: { enabled: "auto", target: "dm" }` configured and Slack already renders plugin approvals as native Block Kit buttons — this is a config-compatible feature, not a new integration.
  - Scope(s) & token type: none new.
  - API methods: none new.
  - Files to touch: `src/index.ts` (hook registration), new `src/approvals.ts` (a small registry: tool name + predicate on its params → requires approval), `src/tools/canvases.ts`, `src/tools/bookmarks.ts`, `src/tools/scheduling.ts`.
  - Extension point: later tasks that add trust-sensitive tools (**S-01** archive/rename, **S-02** kickoff) register their predicates in `src/approvals.ts` as part of their own PR — O-02 lands first, so they never ship ungated.
  - Depends on: O-01.
  - Acceptance criteria: the approval registry exists and is exported for later tasks; attempting a canvas replace/delete, bookmark remove, or scheduled-message cancel from Slack surfaces a native Slack approval button before the Slack API call fires; only `allow-once`/`deny` are offered (no `allow-always`) unless the plugin explicitly persists trust itself.
  - Tests: a test simulating the hook's approval/denial decision short-circuits the underlying Slack call.
  - Size: M

- [ ] **O-03: Add a slack-workspace doctor/scope-audit CLI subcommand** — The Slack app's manifest lists more scopes than the installed token may actually carry if it hasn't been reinstalled. `slack_identity` already calls `auth.test` and returns granted scopes; add `api.registerCli("slack-workspace", { doctor: ... })` that diffs the live token's scopes against what each tool actually needs, for both bot and user tokens.
  - Why: turns scope drift from a mid-task runtime surprise into a proactive, human-runnable check.
  - Scope(s) & token type: none new (reads via `auth.test`, already used).
  - API methods: `auth.test`.
  - Files to touch: `src/index.ts` (CLI registration), `src/client.ts`.
  - Depends on: O-01.
  - Acceptance criteria: `openclaw slack-workspace doctor` prints granted vs. required scopes for bot and user tokens and flags any gap, without making a mutating Slack call.
  - Tests: mocked `auth.test` responses for a scope-complete and a scope-missing case.
  - Size: M

---

## Tier 1 — Improve existing tools

Concrete, verified bugs and gaps in the 16 shipped tools. Independent of each
other except where noted; all assume F-02/F-03 exist for test coverage.

- [ ] **I-01: Fix the malformed canvas permalink URL** — `canvasUrl()` (`src/index.ts:119`) builds `https://slack.com/docs/${canvasId}`, which is not a real Slack canvas URL shape (canvas permalinks are workspace-scoped) and which `canvases.create`'s documented response never actually returns (`{ok, canvas_id}` only — no `url` field). Cache the workspace origin/team id from one `auth.test` call (already made in `slack_identity`) and build a URL whose shape is verified against a live, read-only follow-up call.
  - Why: every canvas link this plugin hands back (`slack_canvas_create`, `slack_canvas_edit`) 404s today.
  - Scope(s) & token type: none new; uses the existing bot or user token already used for `auth.test`.
  - API methods: `auth.test` (cached, not re-called per canvas op); a read-only lookup (e.g. `canvases.sections.lookup` or `conversations.info`, whichever resolves against the constructed URL's team id) to validate the URL shape without a browser.
  - Files to touch: `src/tools/canvases.ts` (or `src/index.ts` pre-F-04), `src/client.ts`.
  - Depends on: F-04 (nice-to-have, not required — can land pre-split if picked first, just touches `src/index.ts` directly).
  - Acceptance criteria (primary, autonomous-verifiable): after a real `canvases.create` against `lostgradient`, a scripted check confirms the constructed URL's shape (workspace/team id segment + canvas id) matches the team id returned by `auth.test` and the `canvas_id` just created — this is what the pipeline checks before opening the PR. A unit test separately asserts the URL-building function's output shape. Opening the URL in a browser signed into `lostgradient` is a one-time manual sanity check noted in the PR description, not a blocking acceptance criterion.
  - Tests: unit test asserting URL shape; the scripted live check above; the browser open is a PR-description note only (no secret values included).
  - Size: S

- [ ] **I-02: Verify and fix the plan-block task status enum** — `slack_post_plan`'s `status` enum is `in_progress | complete | error` (`src/index.ts:503-510`); Slack's plan-block reference documents `in_progress | pending | complete` and does not document `error`. Post a plan with one task in each of `in_progress`/`pending`/`complete` against a real message in `lostgradient` and confirm Slack renders all three without `invalid_blocks`; then either add `pending` (there's currently no way to represent a not-yet-started step) and remove `error`, or find and cite the exact accepted value for a failed step if one exists.
  - Why: callers cannot represent a not-started step today, and `error` may be silently coerced or rejected — a failure mode with no test coverage.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage` (plan block).
  - Files to touch: `src/tools/messaging.ts` (or `src/index.ts`).
  - Depends on: F-02.
  - Acceptance criteria: enum matches what Slack actually accepts, confirmed by a real post, not by docs alone; `pending` is representable.
  - Tests: schema test for the new enum values; a note in the PR of what the live verification showed.
  - Size: S

- [ ] **I-03: Return Slack's resolved channel, not the caller's input, from posting tools** — `postOrUpdate` (`src/index.ts:139-164`, used by `slack_post_table`/`plan`/`chart`) and `slack_schedule_message` (`src/index.ts:315-375`) both return the caller's original `channelId` unchanged. When a caller passes a user ID to open a DM, Slack resolves and returns the actual `D…` channel in `data.channel`, and this plugin currently discards it.
  - Why: a follow-up call using the tool's own returned `channelId` (e.g., `slack_blocks_update`, `slack_scheduled_cancel`) then targets the wrong ID and fails with `channel_not_found`.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage` (special ~1 msg/sec/channel tier), `chat.update`, `chat.scheduleMessage` (Tier 3).
  - Files to touch: `src/tools/messaging.ts`, `src/tools/scheduling.ts`.
  - Depends on: F-02.
  - Acceptance criteria: both functions return `String(data.channel ?? args.channelId)`.
  - Tests: mocked test posting with a user ID, asserting the returned `channelId` matches the mocked `data.channel`, not the input.
  - Size: S

- [ ] **I-04: Don't lose the canvas on a partial share failure** — In `slack_canvas_create` (`src/index.ts:740-767`), `canvases.create` runs first and returns `canvas_id`; if the following `canvases.access.set` call throws, the whole tool call throws and the agent never learns the canvas exists.
  - Why: the canvas is now orphaned and unshared with no way to recover its ID to retry sharing or clean it up.
  - Scope(s) & token type: `canvases:write` (existing), bot or user token.
  - API methods: `canvases.create`, `canvases.access.set`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-02.
  - Acceptance criteria: when `canvases.access.set` fails after a successful `canvases.create`, the tool returns (not throws) `{ canvasId, url, sharedWith: null, shareError: <message> }`.
  - Tests: mocked create-succeeds/share-fails sequence.
  - Size: S

- [ ] **I-05: Paginate slack_scheduled_list** — `chat.scheduledMessages.list` supports cursor pagination (`cursor`/`limit`, `response_metadata.next_cursor`), but `slack_scheduled_list` (`src/index.ts:377-408`) neither sends nor follows it.
  - Why: a workspace with more scheduled messages than one page gets a silent, confident "no more scheduled messages" that's wrong.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.scheduledMessages.list`.
  - Files to touch: `src/tools/scheduling.ts`.
  - Depends on: F-07 (pagination helper).
  - Acceptance criteria: the tool follows `next_cursor` until exhausted, or exposes `cursor`/`limit` plus a `hasMore` boolean.
  - Tests: mocked two-page response.
  - Size: S

- [ ] **I-06: Harden slack_schedule_message's postAt parsing** — `postAt` accepts `string | number` (`src/index.ts:323-357`); an all-digit string (e.g., `"1790000000"`, a valid Unix timestamp typed as JSON string) hits `Date.parse` and produces `NaN`, surfacing a misleading error. Separately, a timezone-less ISO string (`"2026-09-23T09:00:00"`) is parsed as local time in whatever timezone the OpenClaw host runs in, with no warning.
  - Why: both are silent-wrong-behavior traps for an LLM caller computing "now + N seconds" or an ISO string without an offset.
  - Scope(s) & token type: none (parsing only).
  - API methods: none.
  - Files to touch: `src/tools/scheduling.ts`.
  - Depends on: F-02.
  - Acceptance criteria: an all-digit string is treated as Unix seconds instead of failing; an ISO string with no `Z`/`±HH:MM` offset is rejected with a clear error naming the ambiguity (or the assumed timezone is explicitly documented in the tool description — pick one and implement it).
  - Tests: `postAt: "1790000000"` schedules correctly; a timezone-less ISO string is rejected (or documented) per the chosen behavior.
  - Size: S

- [ ] **I-07: Generate a real plain-text fallback for tables and charts** — `postOrUpdate`'s `text` argument for `slack_post_table`/`slack_post_chart` is just the caption/title (`src/index.ts:486,634`) — none of the actual data. `text` is what shows in push notifications and is what Slack's search index falls back to for block-only messages (per the comment already in `slack_search`, `src/index.ts:294-299`).
  - Why: a table or chart posted through these tools is effectively invisible to search and to anyone previewing the notification.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: none new.
  - Files to touch: `src/tools/messaging.ts`.
  - Depends on: none.
  - Acceptance criteria: `text` for a table includes a short rendering of the first few rows (`col: value` pairs); `text` for a chart includes the top segments/series as numbers.
  - Tests: unit test asserting the generated fallback text contains real data, not just the caption/title.
  - Size: M

- [ ] **I-08: Make link-unfurl behavior explicit and consistent on proactive posts** — `postOrUpdate` and `slack_blocks_send` never set `unfurl_links`/`unfurl_media`, so Slack applies its own default (on) regardless of the channel plugin's own `unfurlLinks` default (`false`, per `docs/channels/slack.md`).
  - Why: a URL in a table cell or plan step unexpectedly unfurls in a channel where the agent's ordinary replies don't, producing an inconsistent experience across the two plugins' posts.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage`.
  - Files to touch: `src/tools/messaging.ts`, `src/schemas.ts` (targetParams).
  - Depends on: F-04.
  - Acceptance criteria: `postOrUpdate` and `slack_blocks_send` accept optional `unfurlLinks`/`unfurlMedia` booleans defaulting to `false`; documented in the block-kit skill.
  - Tests: mocked test asserting the default request body sets `unfurl_links: false` unless overridden.
  - Size: S

- [ ] **I-09: Add reply_broadcast parity to table/plan/chart** — `slack_blocks_send` accepts `replyBroadcast` (`src/index.ts:661-665`); the shared `postOrUpdate`-backed tools (`slack_post_table`/`plan`/`chart`) don't expose it at all.
  - Why: a live-updating plan/table card posted in a thread has no way to also broadcast to the channel, unlike a hand-built Block Kit message.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage` (`reply_broadcast`).
  - Files to touch: `src/schemas.ts` (targetParams), `src/tools/messaging.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `targetParams` gains an optional `replyBroadcast` forwarded consistently by `postOrUpdate`.
  - Tests: mocked test asserting `reply_broadcast: true` is sent when set.
  - Size: S

- [ ] **I-10: Document (and partially close) the gap with core's native presentation renderer** — OpenClaw's core `presentation` contract already renders portable chart/table blocks as native `data_visualization`/`data_table` with the same Slack limits this plugin re-implements, plus resiliency this plugin lacks: an aggregate 10,000-character table limit, splitting >2 charts across follow-up messages, and `invalid_blocks` recovery (strip and re-send as text). Add the missing aggregate-character check to `slack_post_table` and either add chart-splitting to `slack_post_chart` or explicitly document in the block-kit skill when to prefer the core `presentation` path (portable, resilient, but no `updateTs`/proactive posting) versus these Slack-only tools (proactive posts, live card edits via `updateTs`).
  - Why: two independent implementations of the same Slack contract will drift; these tools remain justified for proactive/automation use and in-place edits, which the reply-turn `presentation` path doesn't offer the same way — but callers need to know which to reach for.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: none new.
  - Files to touch: `src/tools/messaging.ts`, `skills/slack-block-kit/SKILL.md`.
  - Depends on: F-03 (shares limit-checking helpers).
  - Acceptance criteria: `slack_post_table` enforces the 10,000-char aggregate limit; the skill explicitly documents the presentation-vs-these-tools tradeoff so a future contributor doesn't "fix" this by fully re-implementing the channel plugin's resiliency.
  - Tests: mocked test asserting an over-limit table throws before any network call.
  - Size: M

- [ ] **I-11: Fix stale plugin description, config docs, and configSchema strictness** — The plugin description ("Create and edit Slack canvases and manage channel bookmarks.", `src/index.ts:187`, `openclaw.plugin.json:4`) covers 2 of the plugin's 6 tool domains; the `userToken` description (`src/index.ts:114`) says it's required by "search and reminders" but there is no reminders tool (until R-01 ships); `configSchema` (`src/index.ts:104-117`) has no `additionalProperties: false`, so a typo'd config key like `boToken` passes validation silently and only fails later as a confusing "No Slack bot token" error.
  - Why: this is the first thing anyone reads to understand what the plugin does, and it currently undersells and mis-describes it.
  - Scope(s) & token type: none.
  - API methods: none.
  - Files to touch: `src/index.ts`/`src/schemas.ts`, `openclaw.plugin.json` (via `scripts/patch-manifest.mjs` if it round-trips through the generator).
  - Depends on: F-06 (so the manifest-patch guard test already exists to keep this fix from regressing).
  - Acceptance criteria: description names all six tool domains (identity/scheduling, search, structured messaging, raw Block Kit, canvases, bookmarks); `userToken` description drops the reminders reference (or is updated once R-01 ships); `configSchema` round-trips with `additionalProperties: false` and rejects an unknown config key.
  - Tests: schema test asserting an unknown config key fails validation.
  - Size: S

- [ ] **I-12: Warn on a token/kind prefix mismatch in resolveToken** — `resolveToken()` (`src/index.ts:19-35`) only checks a token string is non-empty; it never checks a `botToken` actually starts with `xoxb-` or a `userToken` with `xoxp-`.
  - Why: a misconfigured token (a user token pasted into `botToken`) passes this check and only fails later as an opaque Slack error several layers removed from the actual misconfiguration.
  - Scope(s) & token type: none.
  - API methods: none.
  - Files to touch: `src/client.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `resolveToken` warns (doesn't hard-fail, since Slack's prefixes could change) when a configured token's prefix doesn't match the requested kind, naming the config path to check.
  - Tests: unit test asserting a warning fires for a mismatched prefix and not for a matching one.
  - Size: S

- [ ] **I-13: Align bookmark/canvas-section output shaping with a documented convention** — `slack_search`/`slack_scheduled_list` curate and reshape Slack's raw response; `slack_bookmark_list`/`slack_bookmark_add`/`slack_canvas_sections` return Slack's raw objects untouched. There's no written rule for which a new tool should do.
  - Why: without a stated convention, the next tool added does whichever the author feels like, and the bookmark/canvas-section tools already forward large, noisy Slack objects the agent doesn't need in full.
  - Scope(s) & token type: `bookmarks:read`/`canvases:read`, existing.
  - API methods: none new.
  - Files to touch: `src/tools/bookmarks.ts`, `src/tools/canvases.ts`, `README.md`.
  - Depends on: F-04.
  - Acceptance criteria: a short convention is documented directly in this PR (in `README.md` and/or a code comment near the shared schemas — doesn't need to wait on the full README rewrite in D-01) stating curate-vs-passthrough rules (curate when the raw object is large/noisy or has agent-irrelevant fields); bookmark and canvas-section tools are brought in line with it.
  - Tests: snapshot test of the curated shape for each tool touched.
  - Size: M

---

## Tier 2 — Channel management (owner priority)

The owner's priority feature set beyond the core roadmap: managing public
channels and letting the agent join them on its own. Scheduled first in Tier 2.

- [ ] **S-01: Add public-channel lifecycle tools, with a built-in confirm guard on archive/rename** — `channels:manage`, `channels:write.topic`, `channels:write.invites` are granted and unused; the channel plugin doesn't expose channel-management actions either. Add `slack_channel_create`, `slack_channel_archive`, `slack_channel_rename`, `slack_channel_set_topic`, `slack_channel_set_purpose`, `slack_channel_invite`. **Every one of these granted scopes is confirmed public-channel-only** (the private-channel equivalents — `groups:write`, `groups:write.topic`, `groups:write.invites` — are not granted), so every tool must detect `is_private` and fail with an explicit "needs `groups:write*`" message rather than a bare `missing_scope`. `slack_channel_archive` and `slack_channel_rename` register with **O-02**'s approval gate, and additionally require an explicit `confirm: true` argument (schema-enforced, no default) as a belt-and-braces guard for non-interactive contexts (cron/automation) where no approval surface is present.
  - Why: a real, requested capability gap on a public, irreversible-ish (archive) or disruptive (rename) surface, with a hard, easy-to-hit scope limitation that must be surfaced clearly rather than discovered as a confusing runtime failure.
  - Scope(s) & token type: `channels:manage` (or `channels:write.topic`/`channels:write.invites`), bot token.
  - API methods: `conversations.create`, `.archive`, `.unarchive`, `.rename`, `.setTopic`, `.setPurpose` (all Tier 2), `.invite` (Tier 3).
  - Files to touch: `src/tools/channels.ts` (new).
  - Depends on: F-04, O-02.
  - Acceptance criteria: each tool works for public channels; each returns a clear, custom error naming the missing `groups:write*` scope when called against a private channel (not Slack's bare `missing_scope`); `slack_channel_archive`/`slack_channel_rename` reject the call with a clear error if `confirm: true` is not passed, and archive/rename surface an O-02 approval prompt when called from Slack.
  - Tests: mocked success path + mocked private-channel rejection for each tool; a test asserting archive/rename without `confirm: true` never reaches the network call.
  - Size: M

- [ ] **S-02: Add slack_channel_kickoff composite tool** — Compose S-01's create/set-topic/set-purpose/invite plus the existing `slack_canvas_create` and `slack_bookmark_add` into one "stand up a project room" call.
  - Why: the highest-value composite of the channel-lifecycle tools, but touches multiple destructive/high-blast-radius operations in one call.
  - Scope(s) & token type: same as S-01, plus `canvases:write`/`bookmarks:write` (existing).
  - API methods: same as S-01, plus `canvases.create`, `bookmarks.add`.
  - Files to touch: `src/tools/channels.ts`.
  - Depends on: S-01.
  - Acceptance criteria: `slack_channel_kickoff(name, topic?, purpose?, invite?[], canvas?, bookmark?)` composes the steps and reports partial failure per step rather than an all-or-nothing throw; description states this should be treated as requiring confirmation before use (real enforcement: registers with **O-02**'s approval gate).
  - Tests: mocked full-success sequence; mocked partial-failure sequence (e.g., invite fails after create succeeds).
  - Size: M

- [ ] **S-07: Add channel join/leave tools and auto-join public channels on demand** — The owner wants the agent to join public channels on its own. Add `slack_channel_join(channelId)` and `slack_channel_leave(channelId)`, and make the shared client auto-join: when a bot-token call against a **public** channel fails with `not_in_channel`, call `conversations.join` once and retry the original call once. Tool results report `autoJoined: true` when this happened so the agent knows it is now a member.
  - Why: today any read (`conversations.history`, pins, bookmarks) or write in a channel the bot hasn't been invited to fails with `not_in_channel` and the agent has to ask a human to `/invite` it; for public channels it can simply join.
  - Scope(s) & token type: `channels:join` (bot) for `conversations.join` — **not currently granted; added by O-12**. `conversations.leave` works with the already-granted `channels:manage` (bot). Verified against docs.slack.dev on 2026-09-23.
  - API methods: `conversations.join`, `conversations.leave`, `conversations.info` (to check `is_private`/`is_archived` before joining).
  - Behavior rules: never attempt to join private channels, DMs or MPIMs — return a clear "the bot must be invited (`/invite @OpenClaw`)" error instead; surface `is_archived` as a clear error; retry at most once per call (no join loops); a `missing_scope` from `conversations.join` returns a hint naming `channels:join` and O-12. Plugin config gains `autoJoin` (boolean, default `true`) and `autoJoinDeny` (list of channel IDs never to auto-join). Join/leave are not approval-gated by O-02: both are visible, reversible and low-risk.
  - Host interplay (document in the tool description and D-01): this workspace runs the channel plugin with `groupPolicy: "open"`, so every joined channel is an "allowed" channel — the agent will answer @-mentions there (channel messages are mention-gated by default) and the channel plugin posts one join introduction per channel unless `channels.slack.joinIntro` is `false` (decided in O-12).
  - Files to touch: `src/client.ts` (auto-join-and-retry wrapper), `src/tools/channels.ts`, `src/schemas.ts`, `openclaw.plugin.json` `configSchema` (`autoJoin`, `autoJoinDeny`).
  - Depends on: F-03, F-04, S-01 (shares `src/tools/channels.ts`); live verification additionally needs **O-12** (the `channels:join` scope).
  - Acceptance criteria: `slack_channel_join`/`slack_channel_leave` work on public channels; a mocked `not_in_channel` on a public channel triggers exactly one join and one retry and returns `autoJoined: true`; private/archived/denylisted channels and `autoJoin: false` never call `conversations.join`; after O-12, a live `slack_channel_join` in `lostgradient` succeeds.
  - Tests: mocked join→retry success; mocked private channel (no join attempted); mocked join failure (no second retry); `autoJoin: false` and `autoJoinDeny` paths; leave success.
  - Size: M

---

## Tier 2 — Canvases

Canvases are already partially implemented (`slack_canvas_create`,
`slack_canvas_edit` with 4 of 7 operations, `slack_canvas_sections`). This tier
completes the CRUD/access surface and adds the two capabilities most requested:
channel (tab) canvases and canvas-from-thread summaries.

- [ ] **C-01: Add insert_after, insert_before, and delete to slack_canvas_edit** — `canvases.edit` supports `insert_after`/`insert_before` (both take a `section_id` — exactly what `slack_canvas_sections` exists to produce) and a section-level `delete`, none of which the tool's `operation` union exposes (`src/index.ts:769-833`, union at `776-784`, `sectionId` wired only to `replace` at `819-823`).
  - Why: today you can look up a section via `slack_canvas_sections` but never insert relative to it or remove it — half the workflow the two tools were designed to support together.
  - Scope(s) & token type: `canvases:write`, bot or user token.
  - API methods: `canvases.edit`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `operation` gains `insert_after`, `insert_before` (both require `sectionId`, error if missing) and `delete` (section-level, requires `sectionId`); each operation's request body matches the documented `canvases.edit` change shape.
  - Tests: one test per new operation asserting the correct `changes[]` payload.
  - Size: M

- [ ] **C-02: Add a sectionTypes filter to slack_canvas_sections** — The tool's description promises filtering "by heading level" (`src/index.ts:838`), but only `containsText` (mapped to `criteria.contains_text`, `src/index.ts:842-844`) exists. `canvases.sections.lookup`'s real `criteria` also accepts `section_types` (`h1`, `h2`, `h3`, `any_header`, `table`, `list`, `callout`, `blockquote`).
  - Why: the advertised heading-level filter is currently unreachable.
  - Scope(s) & token type: `canvases:read`, bot or user token.
  - API methods: `canvases.sections.lookup`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-04.
  - Acceptance criteria: a `sectionTypes` array param maps to `criteria.section_types`, usable alone or combined with `containsText`; confirm (during implementation) whether Slack accepts an empty `criteria: {}` when neither filter is set, and guard against it if it errors.
  - Tests: mocked tests for `containsText` alone, `sectionTypes` alone, and combined.
  - Size: S

- [ ] **C-03: Add slack_canvas_delete** — `canvases.delete` (canvas-level, distinct from the section-level `delete` in C-01) removes a standalone canvas entirely; no tool wraps it.
  - Why: the plugin can create canvases freely but has no cleanup path — agent-created scratch/status canvases accumulate forever.
  - Scope(s) & token type: `canvases:write`, bot or user token.
  - API methods: `canvases.delete` (Tier 3).
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-04.
  - Acceptance criteria: new `slack_canvas_delete(canvasId)` tool; returns `{ deleted: true, canvasId }`; `canvas_not_found`/`access_denied` surface as clear errors (via F-03's hint table).
  - Tests: mocked success and mocked `canvas_not_found`.
  - Size: S

- [ ] **C-04: Add multi-target canvas access management** — `slack_canvas_create` wraps a single `channelId` into a one-item `channel_ids` array with `access_level` limited to `read`/`write` (`src/index.ts:719-765`); there is no way to share to multiple channels or specific users, no `owner` level, and no way to revoke access once granted (`canvases.access.delete` is unused).
  - Why: once shared, access can currently only grow, never shrink, through this plugin.
  - Scope(s) & token type: `canvases:write`, bot or user token.
  - API methods: `canvases.access.set`, `canvases.access.delete`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: C-03.
  - Acceptance criteria: new `slack_canvas_access_set(canvasId, channelIds[]|userIds[], accessLevel: read|write|owner)` and `slack_canvas_access_delete(canvasId, channelIds[]|userIds[])`; `slack_canvas_create`'s `channelId` becomes an optional array reusing the same helper.
  - Tests: mocked tests for channel-array, user-array, and revoke paths.
  - Size: M

- [ ] **C-05: Support channel (tab) canvases** — The plugin only creates standalone canvases shared as a file; it never creates or resolves a channel's single native canvas tab (`conversations.canvases.create`, one per channel, id readable from `conversations.info`'s `channel.properties.canvas`; creating a second returns `channel_canvas_already_exists`).
  - Why: channel canvases are the most discoverable home for a status board — they appear in the channel UI with no bookmark needed.
  - Scope(s) & token type: `canvases:write` + `channels:read`, bot or user token.
  - API methods: `conversations.info`, `conversations.canvases.create`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-04.
  - Acceptance criteria: new `slack_canvas_channel_get_or_create(channelId, title?, markdown?)` reads `conversations.info` first and only calls `conversations.canvases.create` if no canvas exists yet; returns the resolved `canvasId` either way.
  - Tests: mocked "canvas exists" and "canvas missing, create" paths.
  - Size: M

- [ ] **C-06: Add slack_canvas_from_thread** — Nothing in this plugin reads channel or thread content (`conversations.history`/`conversations.replies` are called nowhere in `src/index.ts` despite the bot already having `channels:history`/`groups:history`/`im:history`/`mpim:history`). Add a tool that fetches a thread, synthesizes a markdown summary, and creates or appends into a canvas, then shares it via C-04.
  - Why: this is the one explicitly-requested Canvas capability the plugin currently cannot do at all.
  - Scope(s) & token type: `channels:history`/`groups:history`/`im:history`/`mpim:history` (read) + `canvases:write`, bot or user token.
  - API methods: `conversations.replies`, `canvases.create` or `canvases.edit`, `canvases.access.set`.
  - Files to touch: `src/tools/canvases.ts` (introduces a small `fetchThread` helper other future thread-reading tools — including **L-08** — should reuse rather than re-implementing).
  - Depends on: C-04.
  - Acceptance criteria: `slack_canvas_from_thread(channelId, threadTs)` fetches the thread, builds markdown, creates/updates a canvas, and shares it.
  - Tests: mocked thread fetch + canvas create/share sequence.
  - Size: M

- [ ] **C-07: Living status-canvas helper (idempotent section replace)** — Combine C-01's `insert_after`/`insert_before`, C-05's channel-canvas lookup, and `slack_canvas_sections` to maintain one canvas per channel where a scheduled/triggered run rewrites only a stable, agent-owned section (matched by heading text via `sectionTypes` + `containsText`), leaving the rest untouched. Because `canvases.sections.lookup` appears to return only an opaque `id` (not the section's current text — confirm this live during implementation), the update must anchor on a stable heading string and re-look-up the section id fresh before every replace rather than caching a previously-seen id (id stability across intervening edits is unverified).
  - Why: this is the natural pattern for "keep one status board current" that several of the other findings point toward.
  - Scope(s) & token type: `canvases:read`/`canvases:write`, bot or user token.
  - API methods: `canvases.sections.lookup`, `canvases.edit`.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: C-01, C-05.
  - Acceptance criteria: a helper that resolves the channel canvas id, looks up the target section fresh every call, and replaces it — safe to run repeatedly without assuming a cached section id is still valid.
  - Tests: mocked test running the helper twice in a row with different lookup results, asserting no crash and the correct section replaced each time.
  - Size: L

- [ ] **C-08: Canvas markdown templates via a new skill** — Neither `canvases.create` nor `canvases.edit` documents any template/duplicate mechanism (unlike Lists' `copy_from_list_id`). Ship `skills/slack-canvas/` with 2-3 starter markdown templates (status board, meeting notes, project brief) using `{{placeholder}}` substitution, consumed by `slack_canvas_create`.
  - Why: "templated canvases" has to be a plugin-side feature since Slack provides no canvas templating API; canvas markdown is also a materially different dialect from Block Kit (no Block Kit at all; flexbox columns, callouts, blockquotes, checklists, a 300-cell-per-table limit, 1 MiB-per-change limit) and deserves its own skill the way Block Kit does.
  - Scope(s) & token type: `canvases:write`, bot or user token.
  - API methods: `canvases.create`.
  - Files to touch: `skills/slack-canvas/SKILL.md`, `skills/slack-canvas/references/*.md`, `src/tools/canvases.ts` (template loader).
  - Depends on: F-04.
  - Acceptance criteria: at least 2-3 templates ship; `slack_canvas_create` (or a new `slack_canvas_from_template`) fills placeholders before calling the API.
  - Tests: unit test asserting placeholder substitution produces valid markdown for each template.
  - Size: M

- [ ] **C-09: Spike + ship canvas discovery** — Every canvas feature above assumes the caller already has a `canvas_id`. Confirm the discovery method (canvases are internally stored as files, so `files.list` filtered to canvas-type files is the likely candidate, using the already-granted `files:read` scope, not a search scope) and ship `slack_canvas_list`.
  - Why: standalone canvases (not the one-per-channel canvas from C-05) are otherwise undiscoverable without already knowing the ID.
  - Scope(s) & token type: `files:read`, bot or user token per whichever method is confirmed.
  - API methods: `files.list` (Tier 3, to confirm) with a canvas-type filter.
  - Files to touch: `src/tools/canvases.ts`.
  - Depends on: F-04.
  - Acceptance criteria: the correct discovery method is confirmed via a live smoke test (not assumed from docs); `slack_canvas_list` ships if confirmed, or this task is checked off with the negative finding recorded if no such method exists.
  - Tests: mocked test against the confirmed method's response shape.
  - Size: M

---

## Tier 2 — Lists

`lists:read`/`lists:write` are granted bot scopes with zero implementation
today — the largest fully-provisioned, unused capability in the plugin. List
schemas are immutable after creation (no add/remove/retype column method
exists), so build the schema-resolution helper before anything that needs to
translate human-readable column names into Slack's opaque IDs. L-01 through
L-07 are CRUD/access/discovery wrappers; **L-08** is the compelling
outcome-level feature on top of them (thread action items → a synced List),
matching the Canvases tier's C-06/C-07.

- [ ] **L-01: Add slack_list_create** — Wrap `slackLists.create` (name, `schema` of typed columns, `todo_mode`, optional `copy_from_list_id`/`include_copied_list_records` for templating).
  - Why: this is the entry point every other Lists tool needs a real `list_id` to operate against.
  - Scope(s) & token type: `lists:write`, bot or user token (both work identically per research — confirm during implementation).
  - API methods: `slackLists.create`.
  - Files to touch: `src/tools/lists.ts` (new).
  - Depends on: F-04.
  - Acceptance criteria: tool creates a list with a typed column schema and returns its `list_id`; `todo_mode` and `copy_from_list_id`/`include_copied_list_records` are supported.
  - Tests: mocked create, including a copy-from-template call.
  - Size: M

- [ ] **L-02: Add slack_list_schema (column/option name resolver)** — `slackLists.items.update` needs a `row_id` and `column_id` per cell, and select-type columns need option IDs, not labels — none of which an LLM caller can know without first reading the schema. Wrap `slackLists.items.list` (`include_list=true`) or `.info` to resolve human column names and option labels to Slack's internal IDs.
  - Why: every other Lists item-CRUD tool needs this to let callers work in names instead of opaque IDs.
  - Scope(s) & token type: `lists:read`, bot or user token.
  - API methods: `slackLists.items.list` (`include_list=true`) or `slackLists.items.info`.
  - Files to touch: `src/tools/lists.ts`.
  - Depends on: L-01.
  - Acceptance criteria: `slack_list_schema(listId)` returns `{ columns: [{ id, name, type, options? }] }`.
  - Tests: mocked response with text, select, and user-type columns.
  - Size: M

- [ ] **L-03: Document the List schema-immutability constraint** — `slackLists.update` only accepts `name`, `description_blocks`, and `todo_mode` — there is no method to add/remove/retype columns after creation, and there is no upsert-by-external-key method, so any future "sync with external data" tool must persist its own external-id-to-row_id mapping outside Slack.
  - Why: this constraint must shape any sync-tool design before one is built, or it'll be built on a false assumption and need a rewrite.
  - Scope(s) & token type: n/a (documentation).
  - API methods: n/a.
  - Files to touch: `skills/slack-block-kit/SKILL.md` or a new `skills/slack-lists/SKILL.md` (whichever exists after L-01..L-05).
  - Depends on: L-01.
  - Acceptance criteria: the constraint (immutable schema, no upsert-by-external-key, must design schema as a superset up front or recreate-and-lose-IDs) is written down where a future sync-tool designer will read it before scoping one; also note as UNVERIFIED whether OpenClaw's plugin-sdk exposes any persistent KV storage a tool plugin could use for an external-id-to-row_id mapping, and confirm that before any sync tool is designed.
  - Tests: none (doc task).
  - Size: S

- [ ] **L-04: Add Lists item CRUD tools** — `slack_list_item_create` (`initial_fields`, `parent_item_id` for subtasks), `slack_list_item_update` (batched cells against `row_id`/`column_id`, accepting column *names* resolved via L-02), `slack_list_item_delete`, and `slack_list_items_delete_multiple`.
  - Why: this is the write half of the Lists CRUD surface.
  - Scope(s) & token type: `lists:write` (+ `lists:read` via L-02), bot or user token.
  - API methods: `slackLists.items.create` (Tier 3), `.update` (Tier 3), `.delete` (Tier 2), `.deleteMultiple` (Tier 2).
  - Files to touch: `src/tools/lists.ts`.
  - Depends on: L-02.
  - Acceptance criteria: each tool accepts column names (not raw IDs) and resolves them via `slack_list_schema` before calling Slack; column write shapes are encoded correctly per type (rich_text blocks for text, ID arrays for user/date/select/email/phone/channel, bare number for number/rating, bare boolean for checkbox).
  - Tests: one test per column type's write shape; a create-with-parent (subtask) test.
  - Size: L (split further into create/update vs. delete/deleteMultiple if it grows mid-implementation)

- [ ] **L-05: Add Lists read tools** — `slack_list_items_list` (cursor pagination via F-07's helper, archived filter) and `slack_list_item_info` (single record + subtasks).
  - Why: completes the read half of the Lists CRUD surface.
  - Scope(s) & token type: `lists:read`, bot or user token.
  - API methods: `slackLists.items.list` (Tier 2), `slackLists.items.info` (Tier 2).
  - Files to touch: `src/tools/lists.ts`.
  - Depends on: L-02, F-07.
  - Acceptance criteria: `slack_list_items_list` paginates via F-07's cursor helper and supports an archived filter; `slack_list_item_info` returns a record with its subtasks.
  - Tests: mocked two-page list, mocked single-item-with-subtasks fetch.
  - Size: M

- [ ] **L-06: Add Lists access management** — `slack_list_access_set`/`slack_list_access_delete`, mirroring the channel/user/access-level pattern established for canvases in C-04.
  - Why: completes CRUD parity with the canvas access tools.
  - Scope(s) & token type: `lists:write`, bot or user token.
  - API methods: `slackLists.access.set`, `slackLists.access.delete` (confirm exact argument shape and rate tier during implementation — unverified in research).
  - Files to touch: `src/tools/lists.ts`.
  - Depends on: L-01.
  - Acceptance criteria: tools mirror C-04's shape (`channelIds[]`/`userIds[]`, `accessLevel`).
  - Tests: mocked set and delete calls.
  - Size: S

- [x] **L-07: Spike — Lists discovery** — Confirm whether a Lists analog of `files.list` exists for discovering all Lists in a workspace/channel; the 12-method Lists API inventory found during research showed no list-all/search method.
  - **Finding (2026-09-24): no discovery method exists; callers must use already-known IDs, with `search.files` as an unverified best-effort fallback.** The documented `slackLists.*` family is exactly 12 methods (`create`, `update`, `access.set`/`.delete`, `download.start`/`.get`, `items.create`/`.update`/`.delete`/`.deleteMultiple`/`.info`/`.list`), none of which enumerates Lists. `files.list`'s documented `types` filter (`all`, `spaces`, `snippets`, `images`, `gdocs`, `zips`, `pdfs`) has no Lists value. No `slack_list_discovery` tool ships; recorded in `skills/slack-lists/SKILL.md` and under **Not doing**. UNVERIFIED (needs a live check): whether Lists appear in unfiltered `files.list` or `search.files` results as file objects — if they reliably do, reopen as a small tool task.
  - Why: without discovery, every Lists tool above requires the caller to already know a `list_id`.
  - Scope(s) & token type: `lists:read`, bot or user token.
  - API methods: TBD — spike output.
  - Files to touch: `src/tools/lists.ts` if a method is confirmed.
  - Depends on: L-01.
  - Acceptance criteria: either a discovery method is confirmed and a `slack_list_discovery` tool ships, or the negative finding ("no discovery method exists; rely on `search.files`/already-known IDs") is recorded and this task is checked off with that note.
  - Tests: mocked test against the confirmed method, if one exists.
  - Size: S

- [ ] **L-08: Add slack_list_from_thread (thread action items → synced List)** — The Lists tasks above (L-01..L-07) are exclusively create/read/update/delete/access/discovery CRUD wrappers; add one outcome-level composite, mirroring Canvases' **C-06**: fetch a thread (`conversations.replies`, already-granted history scopes), extract candidate action items, create a `todo_mode` List (or append rows to an existing one) via L-01/L-04, and return the created `list_id` plus row count.
  - Why: the review brief specifically asked whether Lists is covered with compelling features, not just CRUD; this gives Lists the same kind of outcome-level task Canvases already has in C-06/C-07, reusing the same `fetchThread` helper C-06 introduces instead of duplicating it.
  - Scope(s) & token type: `channels:history`/`groups:history`/`im:history`/`mpim:history` (read, existing) + `lists:write`, bot or user token.
  - API methods: `conversations.replies`, `slackLists.create` or `slackLists.items.create`.
  - Files to touch: `src/tools/lists.ts`.
  - Depends on: L-01, L-04, C-06 (reuses its `fetchThread` helper rather than re-implementing thread-fetching a third time).
  - Acceptance criteria: `slack_list_from_thread(channelId, threadTs, listId?)` fetches the thread, produces one List row per extracted action item (`todo_mode` list created if `listId` is omitted), and returns `{ listId, itemsCreated }`.
  - Tests: mocked thread fetch + list-create-and-populate sequence; a second-call test appending to an existing `listId`.
  - Size: M

---

## Tier 2 — Rich messages & assistant surfaces

Message metadata, file uploads, a structured rich_text builder, and the
assistant-thread methods this plugin can safely own (the ones the bundled
channel plugin does *not* already own — see **Not doing**, below).

- [ ] **M-01: Add message metadata write support** — Add an optional `metadata: { eventType, eventPayload }` param to `postOrUpdate` and `slack_blocks_send`/`slack_blocks_update`, threaded into `chat.postMessage`/`chat.update`'s `metadata` field. **Manifest registration is a confirmed requirement, not an open question**: Slack's docs (docs.slack.dev/messaging/message-metadata/) state apps must register metadata schemas in the app manifest's `metadata.event_subscriptions` before sending metadata, and "invalid metadata returns a warning and is ignored" — `chat.postMessage`/`chat.update` still return `ok: true`, so an unregistered `event_type` silently drops the metadata with no error surfaced anywhere. `Bowie`'s manifest currently has no `metadata.event_subscriptions` configured, so this **will** silently no-op until the companion manual task below is done.
  - Why: this lets a plan/table/chart card carry a machine-readable payload (task id, revision, source data) directly on the message, enabling later reconstruction without re-parsing rendered text — cheap, and the write side needs no new scope (`chat:write` already covers it).
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage`, `chat.update`.
  - Files to touch: `src/tools/messaging.ts`, `src/schemas.ts`.
  - Depends on: F-04.
  - Acceptance criteria: split into what's independently testable now vs. gated on the manual step: (1) **code-level, testable via mock now** — the four posting tools accept optional `metadata` and it's forwarded in the `chat.postMessage`/`chat.update` request body when set, absent when not, without breaking calls that omit it; (2) **live round-trip, gated on `O-10`** — metadata actually persists on a real posted message and is readable back (verified together with M-02), which requires `O-10` (manifest `metadata.event_subscriptions` registration + app reinstall) to have been done first. M-01 itself can merge on (1) alone; note (2) as blocked-on-O-10 in the PR rather than silently assuming it works.
  - Tests: mocked test asserting `metadata` is forwarded when set and absent when not.
  - Size: M

- [ ] **M-02: Add slack_message_get (read metadata back)** — A tool wrapping `conversations.history`/`conversations.replies` with `include_all_metadata=true` (gated by the already-granted `metadata.message:read` bot scope) so the agent can re-find/update its own cards by the id stamped in M-01, without caching `ts` values or fuzzy text search.
  - Why: completes the read half of message metadata; note `message_metadata_posted/updated/deleted` events are not in the app's subscribed bot events, so this is poll-only via history reads, not event-driven, until the channel plugin subscribes those events (a cross-plugin follow-up, not this task).
  - Scope(s) & token type: `metadata.message:read`, bot token.
  - API methods: `conversations.history`, `conversations.replies`.
  - Files to touch: `src/tools/messaging.ts`.
  - Depends on: M-01, and (for the live-verification half only — see M-01's split acceptance criteria) **O-10**, since metadata never round-trips at all until the manifest registers the event type.
  - Acceptance criteria: `slack_message_get(channelId, eventType, matchPayload?)` (or similar) retrieves a prior message by its stamped metadata id and returns its `ts`/`channel`/payload; mocked tests can merge without O-10, but the PR notes that a live verification against `lostgradient` requires O-10 to have landed first, or M-02 will find nothing to read back; description states it's poll-only, not event-driven.
  - Tests: mocked `conversations.history` response containing metadata, asserting correct match/extraction.
  - Size: M

- [ ] **M-03: Add a structured rich_text builder** — `rich_text` is the only way to get true bulleted/ordered lists, quotes, and inline code in a Slack message, but today it's only reachable via the internal single-paragraph `richText()` helper (`src/index.ts:134-137`) or by hand-authoring deeply nested `rich_text_section`/`rich_text_list`/`rich_text_quote`/`rich_text_preformatted` JSON through `slack_blocks_send`.
  - Why: hand-authored rich_text JSON is exactly the kind of thing that costs a round-trip on `invalid_blocks`, per the block-kit skill's own gotchas section.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage`.
  - Files to touch: `src/tools/messaging.ts`.
  - Depends on: F-04.
  - Acceptance criteria: a new tool or `slack_blocks_send` param accepts a flat list of `{type: paragraph|bullet_list|ordered_list|quote|code, text|items[]}` and compiles valid `rich_text` blocks; verified against a real post or `blocks.validate`.
  - Tests: one test per section type asserting the compiled JSON shape.
  - Size: M

- [ ] **M-04: Add file upload support (files.getUploadURLExternal → PUT → files.completeUploadExternal)** — `files:read`/`files:write` are granted but no tool exists for pushing a generated file (report, CSV, chart image) to a channel proactively. Slack requires the 3-step external-upload flow since `files.upload` was retired.
  - Why: this is a genuinely new capability, distinct from the channel plugin's in-turn upload/download (which handles ordinary chat-turn attachments, not proactive/out-of-band sends).
  - Scope(s) & token type: `files:write`, bot token.
  - API methods: `files.getUploadURLExternal` (Tier 4), a raw `PUT` to the returned URL, `files.completeUploadExternal`.
  - Files to touch: `src/tools/files.ts` (new).
  - Depends on: F-04.
  - Acceptance criteria: `slack_file_upload(title, content, channelId?, threadTs?, initialComment?)` completes all three calls and returns `{ fileId, permalink, channelId, ts }`; description explicitly calls out that the file stays private if `channelId` is omitted.
  - Tests: mocked three-call sequence (URL fetch, PUT, complete).
  - Size: L

- [ ] **M-05: Add slack_post_ephemeral** — Wrap `chat.postEphemeral` for a private, per-user nudge in a shared channel.
  - Why: `chat:write` already covers it and nothing today lets the agent message just one person in a channel without cluttering it for everyone.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postEphemeral`.
  - Files to touch: `src/tools/messaging.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `slack_post_ephemeral(channelId, userId, text, blocks?, threadTs?)`; output schema explicitly does not promise an updatable `ts` (Slack: `chat.update` cannot target an ephemeral message's `message_ts`).
  - Tests: mocked call asserting correct params and the output-schema shape.
  - Size: S

- [ ] **M-07: Add slack_assistant_set_title** — Wrap `assistant.threads.setTitle` to rename the visible Agent View/Assistant thread title once the agent understands the conversation's topic.
  - Why: clean, additive use of the already-granted `assistant:write` scope with no overlap with anything the channel plugin owns (it doesn't call `setTitle` anywhere in the bundled docs).
  - Scope(s) & token type: `assistant:write`, bot token.
  - API methods: `assistant.threads.setTitle`.
  - Files to touch: `src/tools/assistant.ts` (new).
  - Depends on: F-04.
  - Acceptance criteria: `slack_assistant_set_title(channelId, threadTs, title)`; documented as Agent View/Assistant View only; before shipping, confirm the channel plugin doesn't already call `assistant.threads.setTitle` itself (the app subscribes `agent_session_title_changed`, which hints core may already touch thread titles) — if it does, this tool should call the same underlying mechanism rather than compete with it.
  - Tests: mocked call.
  - Size: S

- [ ] **M-08: Spike + stopgap — slack_assistant_suggest_prompts** — Check the status of `openclaw/openclaw#50481` (dynamic `assistant.threads.setSuggestedPrompts` support) before building. If core has not shipped an equivalent message-tool action, add a scoped `slack_assistant_suggest_prompts(channelId, threadTs, prompts[≤4])` as a stopgap, flagged for removal/merge if core ships the equivalent later.
  - Why: core's Slack channel plugin already calls `setSuggestedPrompts` once, threadlessly, only for view detection — not for dynamic per-reply suggestions — so this is a real gap, but two competing code paths writing the same Slack surface would be worse than the gap.
  - Scope(s) & token type: `assistant:write`, bot token.
  - API methods: `assistant.threads.setSuggestedPrompts`.
  - Files to touch: `src/tools/assistant.ts`.
  - Depends on: M-07.
  - Acceptance criteria: issue status checked and recorded in the PR; tool ships only if core hasn't shipped the equivalent, capped at 4 `{title, message}` prompts, with a code comment noting it should be retired if core catches up.
  - Tests: mocked call; schema test enforcing the ≤4 cap.
  - Size: S

- [ ] **M-09: Verify and document the context_actions feedback-button pattern** — `context_actions` (message-surface feedback buttons, max 5 elements) is listed in the block-kit skill under "Surfaces not yet tested." Verify it renders via `slack_blocks_send` and document a 👍/👎 pattern (not necessarily a new tool, since raw blocks likely suffice).
  - Why: cheap way to let users rate an agent's answer with one tap.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.postMessage`.
  - Files to touch: `skills/slack-block-kit/references/block-kit.md`.
  - Depends on: F-04.
  - Acceptance criteria: `block-kit.md`'s "Verified posting" table gains a `context_actions` row once tested; a documented JSON snippet or small helper exists for the feedback pattern.
  - Tests: none required beyond the live verification noted in the PR.
  - Size: S

- [x] **M-10: Spike — is a modal (views.open) tool even reachable from this plugin?** — `views.open` requires a `trigger_id` minted from a live Slack interaction payload (a button click, slash command, or shortcut) and that id expires in 3 seconds. An agent-invoked tool's `execute()` context has no such id today, and the interaction payload itself arrives on the Socket Mode connection the bundled channel plugin owns, not this tool plugin. Confirm whether the channel plugin exposes a `trigger_id` to tool context (via `toolContext` or similar) for any in-flight interaction; if not, record modal support under **Not doing** as fully gated on both a channel-plugin relay of `trigger_id` and the O-01 architecture migration (Tier 0.5), and do not schedule a build task for it.
  - **Finding (2026-09-24): no — an agent tool cannot obtain a `trigger_id`, so no `slack_modal_open` tool ships.** Checked against the pinned `openclaw@2026.9.5` SDK and docs: `OpenClawPluginToolContext` (the `toolContext` handed to tool factories/`execute`) carries session, sender, delivery-route and config fields but no interaction payload, `trigger_id`, or `response_url`; and `docs/channels/slack/events.md` states outright that the channel plugin redacts trigger IDs and response URLs from agent context when it turns block actions, shortcuts and modal events into `Slack interaction: ...` system events. The only surface that sees a raw interaction is `api.registerInteractiveHandler({ channel: "slack", namespace, handler })` (available now that this plugin uses `definePluginEntry`), but that is a gateway-side callback, not an agent tool: it fires inside the 3-second window only for actions routed to the plugin's own namespace (`openclaw:<namespace>:...` callback/action IDs), and whether the Slack handler context even includes `trigger_id` is UNVERIFIED (the SDK types it as `unknown`; the `@openclaw/slack` package that defines it isn't installed in this repo). Recorded under **Not doing**.
  - Why: this closes out the "modals" question definitively instead of leaving a half-buildable tool on the backlog with acceptance criteria that assume an input the agent can't actually supply.
  - Scope(s) & token type: n/a (spike; `views.open` needs no scope beyond an existing interaction context).
  - API methods: `views.open` (for reference only — not called in this task).
  - Files to touch: none, unless the spike finds a real path, in which case a new task is scoped.
  - Depends on: F-04.
  - Acceptance criteria: the `trigger_id`-availability question is answered and recorded (in this file's **Not doing** section if the answer is no); no `slack_modal_open` tool ships without a confirmed source for `trigger_id`.
  - Tests: none (spike).
  - Size: S

---

## Tier 3 — Workflows & triggers

- [x] **W-01: Spike — workflows.triggers.create/update/delete** — Confirm the exact Web API method(s) for creating a runtime trigger from a bot token, and whether it can target a Workflow-Builder-authored workflow this app doesn't itself own. Research found only `workflows.triggers.permissions.*` (who may use an existing trigger) confirmed as callable; trigger *creation* prose exists but no confirmed plain Web API method was found outside the Slack CLI/Deno Functions platform.
  - **Finding (2026-09-24): the methods exist but are undocumented automation-platform internals, and they can only target workflows defined in an app's own manifest — so no `slack_trigger_*` tools ship.** The family is `workflows.triggers.create`, `.update`, `.delete`, `.list` and `.info` (plus the documented `workflows.triggers.permissions.add`/`.list`/`.remove`/`.set`). Sources: the method constants and request structs in the Slack CLI (`slackapi/slack-cli`, `internal/api/workflows.go`) and the typed client in `slackapi/deno-slack-api` (`src/typed-method-types/workflows/triggers/mod.ts`). Both send a JSON `POST` to `https://slack.com/api/<method>`, so a plain `fetch` could reach them. But: (1) only the `permissions.*` methods have reference pages on docs.slack.dev, and those pages say they're "for apps created with the Deno Slack SDK." `create`/`update`/`delete` have no reference page at all, which means no documented scope, token type or rate-limit tier. The Deno SDK guides require `triggers:write` in the app manifest for runtime trigger creation. `@slack/web-api` (node) has none of these methods. (2) A trigger's target is `workflow: "#/workflows/<callback_id>"` together with `workflow_app_id` (the CLI sets it to the app being deployed, and the API returns `invalid_workflow_app_id` if it's missing or wrong). That resolves to a workflow declared in *that app's* manifest. Neither the CLI, the SDK types nor the docs offer any way to name a Workflow Builder–authored workflow, which belongs to Workflow Builder, not to this app. (3) This app's manifest declares no `workflows`/`functions`. Adding them would mean Socket Mode function execution, which the bundled channel plugin owns (the same gate as the **Not doing** entry for modern custom Workflow Steps). (4) The Slack CLI creates triggers with the developer's CLI auth token, not a bot token; the Deno SDK creates them from inside a running function. Whether a plain `xoxb` bot token with `triggers:write` is accepted by `workflows.triggers.create` at all is UNVERIFIED and needs a live check. It's moot either way, because there's no workflow of ours to point it at. The workable path for "start a Workflow Builder workflow conversationally" is **W-02**: a webhook trigger created once in Workflow Builder, then POSTed to. Recorded in **Scope hygiene** and **Not doing**.
  - Live verification pending: a single `workflows.triggers.list` call with the bot token against `lostgradient`, to see whether bot tokens are accepted at all (`not_allowed_token_type` vs `ok`). Informational only; it doesn't change the decision above.
  - Why: `triggers:read`/`triggers:write` are granted and completely unused; this determines whether building `slack_trigger_create`/`list`/`delete` is even possible from this plugin's plain-fetch architecture.
  - Scope(s) & token type: `triggers:write`, bot token.
  - API methods: `workflows.triggers.*` (to confirm).
  - Files to touch: `src/tools/workflows.ts` (new) if confirmed.
  - Depends on: F-04.
  - Acceptance criteria: either a concrete method + scope + tier is confirmed (live, against `lostgradient`) and the tools ship, or the Deno/CLI-platform dependency is confirmed and documented, and this task is checked off with that finding recorded in **Scope hygiene**.
  - Tests: mocked test against the confirmed method, if any.
  - Size: S

- [x] **W-02: Add slack_workflow_trigger_run** — Once a webhook trigger is created once in Workflow Builder (a stable `hooks.slack.com/triggers/...` URL is minted), add a tool accepting a configured named map of these URLs and POSTing a JSON body to start the workflow conversationally.
  - Done (2026-09-24): `slack_workflow_trigger_run(name, payload?)` in `src/tools/workflows.ts`, configured by the new `workflowTriggers` map (string or SecretRef per entry). `scripts/patch-manifest.mjs` doesn't exist, since the manifest is hand-authored, so `workflowTriggers.*` was added to `configContracts.secretInputs` in `openclaw.plugin.json` directly (OpenClaw supports `*` wildcards for map segments). The URL is never logged or echoed in errors.
  - Live verification pending: create a webhook trigger in Workflow Builder on `lostgradient`, configure it, and run the tool once to confirm Slack answers `200 {"ok":true}` and the workflow starts.
  - Why: needs no new bot scope — the URL is the credential, mirroring `resolveToken()`'s existing SecretRef pattern — and directly answers the "Workflows" feature ask.
  - Scope(s) & token type: none (URL-as-credential, configured like botToken/userToken).
  - API methods: plain `POST` to the configured trigger URL.
  - Files to touch: `src/tools/workflows.ts`, `src/index.ts` configSchema (a new `workflowTriggers` map, string or SecretRef per entry), `scripts/patch-manifest.mjs` (add the new map's entries to `configContracts.secretInputs` alongside `botToken`/`userToken`).
  - Depends on: F-04.
  - Acceptance criteria: `slack_workflow_trigger_run(name, payload)` posts to the configured URL for `name` and returns the HTTP status/response.
  - Tests: mocked POST, including an unconfigured-name error case.
  - Size: S

- [x] **W-03: Spike — workflows.templates:read/write** — Confirm the concrete Web API method(s) for creating/publishing a Workflow Builder template and their payload shape; research found only scope-reference pages, no confirmed method.
  - **Finding (2026-09-24): no Web API method consumes either scope, so no `slack_workflow_template_*` tool ships.** The scope reference pages on docs.slack.dev (`workflows.templates:read`, "Manage Slack workflow template on user's behalf", and `workflows.templates:write`, "Write Slack workflow template on user's behalf"; both list Bot and User tokens) list no methods that use them. The docs.slack.dev method index has no method containing "template". Its whole `workflows.*` family is `workflows.featured.add`/`list`/`remove`/`set`, which use `bookmarks:*` scopes (`workflows.featured.add` requires `bookmarks:write`) and act on link-trigger IDs, not templates, plus `workflows.triggers.permissions.*`. The `admin.workflows.*` family has no template methods either. The undocumented internals have none too: the Slack CLI's API client (`slackapi/slack-cli`, `internal/api/*.go`) defines `workflows.triggers.*`, `functions.workflows.steps.*`, `functions.distributions.permissions.*` and `apps.*`, and nothing template-shaped. `slackapi/deno-slack-api`, `@slack/web-api` and the fully generated `slack-edge/slack-web-api-client` have no template method. The scope strings show up only in scope enumerations (e.g. `slack-edge/slack-web-api-client`'s `src/manifest/scopes.ts`). Slack's help center describes Workflow Builder templates only as a gallery that end users pick from and customize in the UI. It mentions no app- or API-authored templates. The likely explanation is that the scopes are reserved for an internal or partner surface that isn't public. Recorded in **Scope hygiene** and **Not doing**.
  - Live verification pending: none needed for the decision. There's no method name to call, so no live check against `lostgradient` can confirm or refute a payload shape. Revisit only if a `workflows.templates.*` method appears in the docs.slack.dev method index or changelog.
  - Why: this scope is granted on both bot *and* user tokens (unusual — most families here are bot-only), suggesting deliberate intent, and it directly answers the "Workflows" feature ask if a method exists.
  - Scope(s) & token type: `workflows.templates:write`, bot and/or user token (to confirm).
  - API methods: TBD — spike output.
  - Files to touch: `src/tools/workflows.ts` if confirmed.
  - Depends on: W-01 (shares the workflow-tools module).
  - Acceptance criteria: a concrete method + payload is confirmed and a `slack_workflow_template_*` tool is scoped, or the scope is flagged for removal in **Scope hygiene** with the negative finding recorded.
  - Tests: mocked test against the confirmed method, if any.
  - Size: S

- [x] **W-04: Spike — mcp:connect** — Confirm whether any Web API method actually consumes `mcp:connect`, or whether it's purely an admin/workspace-console-configured capability (an org admin adding OpenClaw's own MCP server into Slack's native AI) with zero code surface for a tool plugin.
  - **Finding (2026-09-24): no Web API method consumes `mcp:connect`, so this tool plugin has nothing to build.** The scope is inbound-only. The docs.slack.dev scope page (`mcp:connect`, Bot token only) describes it as "Allows your Slack app to connect to Slack AI features through Model Context Protocol (MCP) servers" and lists no methods. The feature it gates is the **Slackbot MCP client** (docs.slack.dev `ai/slackbot-mcp-client`). The app declares a remote MCP server in its manifest's `mcp_servers` block (`url`, `auth_type` of `no_auth`/`slack_identity_auth`/`dynamic_client_registration`/`manual_auth`, and `auth_provider_key` for the OAuth types), or in the "MCP Servers" section of App Settings, which writes the same block and adds `mcp:connect` automatically. From then on, *Slack* calls *the server*: Slackbot sends JSON-RPC over the Streamable HTTP transport to a public HTTPS endpoint, discovers its tools and invokes them from user prompts. The docs say stdio and the old HTTP+SSE transport aren't supported, and a tool call that takes more than 60 seconds is aborted. The app never sends a token-bearing request that uses this scope. The only MCP-related Web API methods are `admin.apps.mcp.servers.list` and `admin.apps.mcp.servers.permissions.list`/`.set`. Those are Enterprise-plan org-admin methods that take a *user* token with `admin.apps:read`/`admin.apps:write`, not `mcp:connect`, and they manage the org allowlist and who may use a server. This workspace has no admin scopes, and admin tooling is out of scope anyway. So the real "use" of `mcp:connect` would be exposing **OpenClaw itself** as an MCP server to Slackbot. That needs (1) an OpenClaw Gateway endpoint that speaks Streamable HTTP MCP, which a `defineToolPlugin` tool can't provide, (2) a public HTTPS origin, which `lostgradient` lacks (**O-06**), and (3) a manifest edit on api.slack.com (manual). Recorded in **Scope hygiene**, **Not doing** and **Open questions**.
  - Live verification pending: none needed for the decision. There's no method to call with a bot token. A future live check, if the owner pursues the Slackbot-MCP route, is whether Slackbot in `lostgradient` lists a registered server's tools, and it would need a public Gateway MCP endpoint first.
  - Why: granted but nothing in this plugin (or research) found a callable method for it.
  - Scope(s) & token type: `mcp:connect`, bot token.
  - API methods: TBD — spike output, likely none.
  - Files to touch: none, unless a method is found.
  - Depends on: none.
  - Acceptance criteria: either a method is found and a follow-up task is scoped, or it's documented as install/admin-console-only and flagged for removal in **Scope hygiene**.
  - Tests: none (spike).
  - Size: S

---

## Tier 3 — Webhooks

- [x] **H-01: Write the Workflow Builder → OpenClaw Gateway webhook bridge recipe (doc only, no live run required)** — Document how a Workflow Builder workflow can hand a request to OpenClaw's Gateway `POST /hooks/agent` endpoint (Bearer `hooks.token` auth) and get the agent's reply posted back into Slack. The corrected recipe: any trigger → a custom step (a small Bolt app handling `function_executed`) that POSTs to `/hooks/agent` with `deliver: true`, `channel: "slack"`, `to: "channel:C…"` → OpenClaw posts the reply itself, and the step's outputs carry only run status (see the finding below). Written from the documented shape of both sides, without requiring a live workflow run — `lostgradient` has no public Gateway origin configured today (`gateway.publicOrigin` is unset; that's **O-06**, a manual task), so a live test isn't possible yet and this task must not block on it.
  - Why: zero new Slack scopes, zero plugin code — just a `hooks.enabled` config, a public Gateway URL, and a documented recipe/skill — and it directly answers the "Webhooks" feature ask for the highest-value case (Slack → OpenClaw). Splitting the doc from the live verification (see **H-03**, Manual section) keeps this pickable by the automated pipeline instead of stalling on a missing public origin.
  - Scope(s) & token type: none new.
  - API methods: none (Workflow Builder UI step + existing OpenClaw Gateway endpoint, described from docs).
  - Files to touch: `skills/slack-block-kit/references/` or a new doc, README.
  - Depends on: none.
  - Acceptance criteria: the recipe doc exists, is accurate to both sides' documented request/response shapes, and is written as a step-by-step a human can follow in Workflow Builder; it explicitly says live verification is tracked separately as **H-03** once `gateway.publicOrigin` (O-06) exists.
  - Tests: none (doc task; no live verification in this task).
  - Size: S
  - **Finding (2026-09-24): recipe written to `docs/workflow-builder-gateway-bridge.md`, with two corrections to this entry's premise.** (1) Workflow Builder has no built-in "Send a webhook" or "Extract values from JSON" step. Both came from the third-party Workflow Buddy app, built on the legacy Steps from Apps feature Slack retired on 2024-09-12. The outbound POST now has to come from a custom step (a small separate Bolt app with a `function_executed` handler) or a third-party connector. (2) `/hooks/agent` never returns the agent's reply text, not even with `waitForCompletion: true`; `completion` carries only `status`, `replyDisposition` and delivery flags. So the reply comes back through OpenClaw's own delivery (`channel: "slack"`, `to: "channel:C…"`), not through extracted JSON. Live verification stays with **H-03**, after **O-06**.

- [x] **H-02: Document inbound webhook alerting via OpenClaw's own Gateway/webhooks mechanisms** — External-system-to-OpenClaw-via-Slack is already solved by OpenClaw core (`POST /hooks/wake`/`/hooks/agent` with direct Slack delivery, plus the bundled webhooks plugin for stateful TaskFlow ingress). Add a short doc/skill section mapping the inbound patterns (Gateway hooks vs. the webhooks plugin vs. Slack's own `incoming-webhook`) to when to use each.
  - Why: prevents this plugin from re-implementing an HTTP listener OpenClaw core already provides — directly serves the "no duplication" guiding principle for the "Webhooks" feature ask.
  - Scope(s) & token type: none.
  - API methods: none.
  - Files to touch: README or a new doc.
  - Depends on: H-01.
  - Acceptance criteria: the doc section exists and clearly states when to use each of the three inbound patterns.
  - Tests: none (doc task).
  - Size: S
  - **Finding (2026-09-24): written to `docs/inbound-webhooks.md` and linked from the README, with one correction to this entry's premise.** The bundled Webhooks plugin never starts an agent. Its routes create and advance TaskFlow *records* (`create_flow`, `run_task`, `finish_flow`, …) for an external controller, so it's not an alerting path on its own. For alerts the doc recommends `/hooks/agent` with `channel: "slack"` + `to` when the agent should triage first, and a Slack incoming webhook when only the raw text is needed. `/hooks/wake` suits short trusted nudges, and its message follows the agent's heartbeat target rather than a chosen channel.

---

## Tier 3 — Reminders

- [x] **R-01: Add slack_remind as a working reminder replacement** — Slack's own current docs state, for both `reminders.add` and `reminders.list`: "Retirement of API methods for interfacing with reminders began March 2023, and as such have become degraded or useless." (Token type is a separate, UNVERIFIED-by-itself question: `reminders.add`'s scopes panel lists only a user token, but its own prose says "Setting reminders for other users with `reminders.add` can now only be done with a bot token," and the `reminders:write` scope reference page lists Bot as a supported token type — Slack's docs are internally inconsistent here, so don't cite "confirmed user-token only" as fact; the retirement/degradation language above is the solid justification and is sufficient on its own.) This confirms the plugin's existing internal rationale (`src/index.ts:319`). Build `slack_remind` on `conversations.open` (`im:write`, granted) + `chat.scheduleMessage` instead — fully working, bot-token-only.
  - Done (2026-09-24): `slack_remind(userId | channelId, text, when)` in `src/tools/scheduling.ts`. A `userId` goes through `conversations.open` (which returns the existing DM when there is one) and then `chat.scheduleMessage`; a `channelId` schedules directly. `when` shares `slack_schedule_message`'s parsing and 120-day bounds and is checked before any Slack call. The reminder is an ordinary scheduled message, so `slack_scheduled_list`/`slack_scheduled_cancel` cover it.
  - Live verification pending: remind a real user on `lostgradient` a minute out and confirm the DM arrives from the bot.
  - Why: gives the agent a genuinely working one-off reminder tool instead of a documented-broken one, and removes the need for the `reminders:*` bot scopes entirely (see **Scope hygiene**).
  - Scope(s) & token type: `im:write` + `chat:write`, bot token.
  - API methods: `conversations.open`, `chat.scheduleMessage` (Tier 3).
  - Files to touch: `src/tools/scheduling.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `slack_remind(userId|channelId, text, when)` opens/reuses a DM and schedules via `chat.scheduleMessage`; its description tells the agent to use `openclaw automations` for recurrence instead of reimplementing it.
  - Tests: mocked `conversations.open` + `chat.scheduleMessage` sequence.
  - Size: S

- [x] **R-02: Harden slack_schedule_message with Slack's documented limits** — `chat.scheduleMessage` enforces a 30-messages-per-5-minutes-per-channel cap (`restricted_too_many`) not currently surfaced anywhere; there's also no edit-scheduled-message method, only delete+recreate.
  - Why: callers hit a rate-limit wall with no warning, and rescheduling requires two manual tool calls today.
  - Scope(s) & token type: `chat:write`, bot token (existing).
  - API methods: `chat.scheduleMessage` (Tier 3), `chat.deleteScheduledMessage`.
  - Files to touch: `src/tools/scheduling.ts`.
  - Depends on: F-03 (hint table).
  - Acceptance criteria: the tool description and error hints name the 30-per-5-minutes-per-channel cap; a new `slack_schedule_reschedule` tool does cancel+recreate in one call.
  - Tests: mocked `restricted_too_many` response asserting a clear hint; mocked reschedule sequence.
  - Size: S
  - Done (2026-09-24): `restricted_too_many` now carries a hint naming the 30-per-5-minutes-per-channel cap (`src/client.ts`), and `slack_schedule_message`'s description states it. New `slack_schedule_reschedule(channelId, scheduledMessageId, text, postAt, blocks?, threadTs?)` schedules the replacement first, then cancels the original; if the cancel fails it withdraws the replacement, so a failure never leaves two copies or loses the original.
  - Live verification pending: reschedule a real pending message on `lostgradient` and confirm only the replacement posts.

---

## Tier 3 — Other scope-backed features

- [ ] **S-03: Add slack_bookmark_edit and check bookmarks.add's type coverage** — `bookmarks:write` already covers `bookmarks.edit` (title/link/emoji in place) but only add/remove/list exist today; editing requires remove+re-add, which changes the bookmark's id/position. Separately, `slack_bookmark_add` hardcodes `type: "link"` with no way to add other bookmark types Slack's API may support (e.g. a message-permalink bookmark) — confirm what `bookmarks.add`'s `type` field actually accepts and expose any additional values found.
  - Why: trivial, same shape as the three existing bookmark tools, completes the CRUD surface; the `type` coverage gap was flagged during research and otherwise has no task tracking it.
  - Scope(s) & token type: `bookmarks:write`, bot or user token (existing).
  - API methods: `bookmarks.edit` (Tier 2), `bookmarks.add` (type-coverage check only, no new tool).
  - Files to touch: `src/tools/bookmarks.ts`.
  - Depends on: F-04.
  - Acceptance criteria: `slack_bookmark_edit(channelId, bookmarkId, { title?, link?, emoji? })` calls `bookmarks.edit` and returns the updated bookmark; `bookmarks.add`'s supported `type` values are confirmed (docs and/or a live call) and, if more than `"link"` exists, `slack_bookmark_add`'s `type` param is widened to expose them.
  - Tests: mocked edit call; mocked add call for each additional type exposed (if any).
  - Size: S

- [ ] **S-04: Add read-only usergroup tools** — `usergroups:read` is granted but only used internally by the channel plugin (to resolve `<!subteam^...>` mentions); no agent-facing tool exists. Add `slack_usergroup_list` and `slack_usergroup_members`. `usergroups:write` is **not** granted, so this ships read-only and says so explicitly.
  - Why: lets an agent answer "who is on @oncall" without guessing from message mentions.
  - Scope(s) & token type: `usergroups:read`, bot or user token.
  - API methods: `usergroups.list` (Tier 2), `usergroups.users.list` (Tier 2).
  - Files to touch: `src/tools/usergroups.ts` (new).
  - Depends on: F-04.
  - Acceptance criteria: `slack_usergroup_list` returns id/handle/name/channel defaults; `slack_usergroup_members(usergroupId)` returns member user ids; both descriptions state "read-only, `usergroups:write` not granted."
  - Tests: mocked calls for both.
  - Size: S

- [ ] **S-05: Add remote-file tools** — `remote_files:read`/`write`/`share` are granted and unused by both plugins (distinct from `files:read`/`write`, which cover native Slack file upload/download in a chat turn). Add `slack_remote_file_add` (register an external document — e.g. a Linear issue or generated report link — as a native Slack file object with a preview card), plus `update`/`remove`/`share`.
  - Why: lets the agent surface external documents as first-class Slack file objects instead of bare hyperlinks; `files.remote.add` requires a **bot token specifically** (verified — user tokens are rejected).
  - Scope(s) & token type: `remote_files:write`, bot token only.
  - API methods: `files.remote.add` (Tier 2), `.info`, `.list`, `.update`, `.remove`, `.share`.
  - Files to touch: `src/tools/remote-files.ts` (new).
  - Depends on: F-04.
  - Acceptance criteria: `slack_remote_file_add(externalId, externalUrl, title)` creates a remote file object; `update`/`remove` manage it; `share` attaches it to a channel; the bot-token-only requirement is documented.
  - Tests: mocked calls for add/update/remove/share.
  - Size: M

- [ ] **S-06: Record a decision on link unfurling / Work Objects** — `links:read`, `links:write`, `links.embed:write` are granted but architecturally inert today: `chat.unfurl` requires a prior `link_shared` event, and `link_shared` is not in this app's subscribed bot events; even if it were, `defineToolPlugin` (this plugin's current base) cannot receive raw Slack events at all — only `definePluginEntry` (O-01) can register that kind of hook.
  - Why: this is a decision point, not a build task — implementing it for real would need both a cross-plugin change (channel plugin subscribes `link_shared` and forwards it) and the O-01 plugin-architecture migration (Tier 0.5, confirmed), or the scopes become trim candidates (trimming is deferred — see **Decisions**).
  - Scope(s) & token type: `links:read`/`links:write`/`links.embed:write`, bot token.
  - API methods: `chat.unfurl` (blocked pending the above).
  - Files to touch: none (decision record only) unless the decision is to proceed, in which case it becomes a new task building on O-01 (Tier 0.5).
  - Depends on: none — this task only records a decision.
  - Acceptance criteria: a decision is recorded — either (a) a follow-up ticket exists, with an owner, to add `link_shared` + an App Unfurl Domain to the channel-plugin's manifest and coordinate the relay, or (b) `links:read`/`links:write`/`links.embed:write` are dropped at the next manifest review (see **Scope hygiene**).
  - Tests: none.
  - Size: S

---

## Tier 4 — OpenClaw integration polish

Smaller host-integration improvements. The core architecture work (O-01..O-03) was
promoted to Tier 0.5 once the migration was confirmed (see **Decisions**).

- [ ] **O-04: Default channelId to the active Slack turn via nativeChannelId** — Every tool requires an explicit `channelId` even inside an active Slack conversation turn. `factory`-style tools (supported inside `defineToolPlugin` today, no migration required) receive `nativeChannelId` for the active platform conversation.
  - Why: removes a common source of wrong-channel or missing-`channelId` tool-call errors during ordinary chat use, while leaving explicit `channelId` available for out-of-turn automations.
  - Scope(s) & token type: none new.
  - API methods: none new.
  - Files to touch: `src/tools/messaging.ts`, `src/schemas.ts`.
  - Depends on: F-04. (Does **not** depend on O-01 — factory tools work under `defineToolPlugin` today.)
  - Acceptance criteria: inside an active Slack turn, calling e.g. `slack_post_table` without `channelId` posts into the current conversation; calling it from a cron/automation context without an active turn still requires explicit `channelId` and fails clearly if omitted.
  - Tests: mocked test with and without an active-turn context.
  - Size: M

- [ ] **O-05: Add manifest categories, uiHints, and plugin artwork** — `openclaw.plugin.json` has no `categories` (ClawHub browse taxonomy — `inbox-collaboration` fits better than `channels`, which is reserved for plugins people talk to the agent through), no `uiHints` marking `botToken`/`userToken` as `sensitive: true`, and no `assets/icon.png`/`assets/activity.svg`.
  - Why: without `sensitive: true`, the Settings UI has no declared reason to mask these fields beyond generic name heuristics; missing artwork/category is a ClawHub discoverability gap.
  - Scope(s) & token type: none.
  - API methods: none.
  - Files to touch: `openclaw.plugin.json` (via `scripts/patch-manifest.mjs` or its O-01 hand-authored successor), `assets/icon.png`, `assets/activity.svg`.
  - Depends on: F-06.
  - Acceptance criteria: manifest declares one category; `uiHints.botToken.sensitive`/`uiHints.userToken.sensitive` are `true`; icon + activity assets ship in the package `files` list.
  - Tests: `openclaw plugins validate` passes with the new fields.
  - Size: S

---

## Documentation & skills

- [ ] **D-01: Rewrite README.md** — Currently 12 lines of build commands only. Document all 16+ tools grouped by capability, the `botToken`/`userToken` config shape (string or SecretRef) and which tools need which, required Slack scopes per token kind, and a pointer to `skills/slack-block-kit`.
  - Why: everything currently lives only in code comments and one skill file; anyone besides the original author has to reverse-engineer the plugin from source.
  - Scope(s) & token type: n/a.
  - API methods: n/a.
  - Files to touch: `README.md`.
  - Depends on: none (can be picked up any time; will need re-touching as new tools ship, but ships real value immediately).
  - Acceptance criteria: README lists tools by capability, documents `botToken` vs `userToken` requirements per group, and links to the skill.
  - Tests: none (doc task).
  - Size: S

- [ ] **D-02: Fix SKILL.md's incorrect updateTs claim** — `skills/slack-block-kit/SKILL.md` states "All four tools accept `updateTs`," but `slack_blocks_send`'s parameters have no `updateTs` field — only `slack_blocks_update` (a separate tool, taking `ts` not `updateTs`) can edit an existing raw-blocks message. Fix the claim rather than adding `updateTs` to `slack_blocks_send`: the two tools already have single, clear responsibilities (post new vs. update existing), and duplicating `slack_blocks_update`'s job inside `slack_blocks_send` would just create two ways to do the same thing.
  - Why: an agent following the skill's literal claim gets a schema-rejection round-trip today.
  - Scope(s) & token type: n/a.
  - API methods: n/a.
  - Files to touch: `skills/slack-block-kit/SKILL.md`.
  - Depends on: none.
  - Acceptance criteria: SKILL.md accurately states which 3 tools take `updateTs` and directs readers to `slack_blocks_update` (by `ts`) for editing raw-block messages.
  - Tests: none (doc task).
  - Size: S

- [ ] **D-03: Document legacy attachments, the scheduled-digest recipe, and other out-of-scope items explicitly** — Slack's legacy `attachments` parameter is deprecated in favor of Block Kit for new development; this plugin correctly has none. Record this, and the other items in **Not doing** below, in the skill/README so a future contributor doesn't "discover" the gap and implement something already deliberately excluded. Also write up the "scheduled-digest recipe" pattern from **O-08** (rewriting a recurring automation's prompt to call `slack_post_table`/`slack_canvas_edit(append)` and reuse `updateTs` so N future messages become one edited card) so it's discoverable for future automations, not just applied once to the one job O-08 touches by hand.
  - Why: prevents re-litigating settled decisions, and makes a manually-applied pattern (O-08) reusable rather than one-off.
  - Scope(s) & token type: n/a.
  - API methods: n/a.
  - Files to touch: `README.md` or `skills/slack-block-kit/SKILL.md`.
  - Depends on: D-01.
  - Acceptance criteria: the exclusions are written down where a contributor would see them before proposing the feature again; a short "scheduled-digest recipe" section documents the updateTs-reuse pattern with a small example.
  - Tests: none (doc task).
  - Size: S

---

## OpenClaw configuration & Slack app settings — MANUAL (do not run through the automated pipeline)

These are edits to `~/.openclaw/openclaw.json`, the Slack app's own
manifest/settings on api.slack.com, a live Workflow Builder workflow built
through Slack's web UI, or `openclaw automations`/CLI operations — not code
changes to this repository. A human with access to those systems does these
directly; do not hand them to `ralph-pipeline`. (**H-03** lives here rather
than back in Tier 3 with H-01/H-02 because it's the one Tier-3-Webhooks task
that's a live, browser-driven verification, not code or a doc — see H-03 and
"How to run this roadmap" above.)

- [~] **O-06: [MANUAL] Set gateway.publicOrigin so Slack cards get an "Open in OpenClaw" link** — `~/.openclaw/openclaw.json`'s `gateway` block sets `mode`/`auth`/`reload` but not `publicOrigin`. Progress cards, the Block Kit session card, and task-completion notifications all gain an "Open in OpenClaw"/"Inspect" link only when `publicOrigin` is set and the Control UI is enabled.
  - Why: a one-line config change unlocks a link OpenClaw already knows how to render.
  - Scope(s) & token type: n/a (host config).
  - API methods: n/a.
  - Files to touch: `~/.openclaw/openclaw.json` (structure only — never paste secret values into this repo).
  - Depends on: none.
  - Acceptance criteria: `gateway.publicOrigin` is set to the reachable Gateway origin; a Slack progress card or task-completion message shows the link.
  - Tests: n/a (manual verification).
  - Size: S

- [~] **O-07: [MANUAL] Configure approvals.plugin routing for Slack** — `~/.openclaw/openclaw.json` configures `channels.slack.execApprovals` for host *exec* approvals, but there is no `approvals.plugin` block or `channels.slack.allowFrom` for *plugin* approvals — a separately-configured surface. Once O-02 ships, plugin approval prompts have no route configured and will report "no connected approval surface can resolve it."
  - Why: without this, O-02's permission requests silently fail to render anywhere.
  - Scope(s) & token type: n/a (host config).
  - API methods: n/a.
  - Files to touch: `~/.openclaw/openclaw.json`.
  - Depends on: O-02.
  - Acceptance criteria: `approvals.plugin.targets` (or the equivalent Slack plugin-approver route) is configured and a slack-workspace approval prompt renders as a native Slack button in the same owner DM already used for exec approvals.
  - Tests: n/a (manual verification).
  - Size: S

- [~] **O-08: [MANUAL] Point existing Slack-delivering automations at the plugin's structured tools** — `openclaw automations list` shows recurring cron jobs delivering to Slack via plain-text `announce` today. Rewrite at least one recurring digest job's prompt to call `slack_post_table`/`slack_canvas_edit(append)` and reuse `updateTs` so N future messages become one edited card.
  - Why: puts already-shipped plugin capability to work with zero plugin-code changes — only automation prompt/config edits via `openclaw automations update`. See **D-03**, which writes this pattern up so it's discoverable beyond the one automation this task touches by hand.
  - Scope(s) & token type: n/a (automation config).
  - API methods: n/a (automation prompt change; the automation itself calls this plugin's existing tools at runtime).
  - Files to touch: automation definitions (via `openclaw automations` CLI, not this repo).
  - Depends on: none (the tools it would call already exist).
  - Acceptance criteria: at least one recurring Slack-delivering automation's prompt calls a slack-workspace structured tool instead of relying only on plain-text `announce`, and reuses `updateTs` where the content is a rolling digest.
  - Tests: n/a (operational change, verified by observing the next run).
  - Size: S

- [~] **O-09: [MANUAL] Review ambient-room-event configuration for the two open Slack channels** — `~/.openclaw/openclaw.json` sets `requireMention: false` for two channels under `groupPolicy: "open"` with no `messages.groupChat.unmentionedInbound: "room_event"` override, meaning the agent replies to every unmentioned message in those channels rather than treating them as ambient context. Confirm this is intentional, or set `unmentionedInbound: "room_event"` + `visibleReplies: "message_tool"`, and confirm the `main` agent's effective tool profile includes the `message` tool (it ships in the `messaging` profile, not `minimal`/`coding`).
  - Why: this is either a deliberate choice or an unnoticed default that makes the agent noisier in those two channels than intended.
  - Scope(s) & token type: n/a (host config).
  - API methods: n/a.
  - Files to touch: `~/.openclaw/openclaw.json`.
  - Depends on: none.
  - Acceptance criteria: either the "reply to everything" behavior is confirmed intentional (documented, no change), or `unmentionedInbound: "room_event"` is set and a probe turn confirms the `message` tool is available to `main`.
  - Tests: n/a (manual verification).
  - Size: S

- [~] **O-10: [MANUAL] Register message-metadata event_type(s) in the Slack app manifest and reinstall** — Per Slack's docs (docs.slack.dev/messaging/message-metadata/), apps must register metadata schemas under the app manifest's `metadata.event_subscriptions` before `chat.postMessage`/`chat.update`'s `metadata` field does anything — unregistered metadata is silently dropped with a warning, not an error. `Bowie`'s manifest has no `metadata.event_subscriptions` today. Add the event_type(s) **M-01** uses (e.g. `openclaw_card_v1`, or whatever name that task settles on) to the manifest on api.slack.com and reinstall the app to `lostgradient`.
  - Why: without this, **M-01**'s write path and **M-02**'s read path both appear to work (Slack calls return `ok: true`) while metadata is silently discarded — a live-verification blocker that must be done by a human with app-manifest access, not the automated pipeline.
  - Scope(s) & token type: n/a (Slack app manifest/settings).
  - API methods: n/a (api.slack.com manifest editor + app reinstall).
  - Files to touch: none in this repo (Slack app manifest on api.slack.com).
  - Depends on: M-01 (need to know the exact `event_type` name(s) it settles on before registering them).
  - Acceptance criteria: `metadata.event_subscriptions` in the Bowie manifest lists the event_type(s) M-01 uses; the app is reinstalled; a live `chat.postMessage` with that metadata, followed by a `conversations.history` read with `include_all_metadata=true`, shows the metadata persisted (unblocks M-01/M-02's live-verification acceptance criteria).
  - Tests: n/a (manual verification).
  - Size: S

- [~] **O-12: [MANUAL] Add the channels:join scope, reinstall, and decide on join introductions** — Add `channels:join` to the Bowie manifest's bot scopes on api.slack.com and reinstall the app to `lostgradient`, so **S-07** can call `conversations.join`. Also decide whether auto-joins should announce themselves: with `groupPolicy: "open"`, the channel plugin posts an introduction in every channel the bot joins unless `channels.slack.joinIntro` is set to `false` in `~/.openclaw/openclaw.json`.
  - Why: `conversations.join` requires `channels:join` for bot tokens (docs.slack.dev, verified 2026-09-23); the app does not request it today. Adding a scope is compatible with the deferred-trimming decision.
  - Scope(s) & token type: adds `channels:join` (bot).
  - API methods: n/a (manifest editor + reinstall).
  - Files to touch: none in this repo (Slack app manifest; optionally `~/.openclaw/openclaw.json` for `joinIntro`).
  - Depends on: none.
  - Acceptance criteria: the manifest lists `channels:join`; the app is reinstalled; `auth.test`'s `x-oauth-scopes` header (or `slack_identity`) includes `channels:join`; the `joinIntro` choice is recorded in **Decisions**.
  - Tests: n/a (manual verification).
  - Size: S

- [~] **O-11: [MANUAL] [DEFERRED] Trim dead/low-value scopes from the manifest and reinstall** — **Deferred by the owner on 2026-09-23: do not execute until explicitly re-opened; the owner may keep some of these scopes for new features.** **Scope hygiene** below identifies several scopes with no live code path and no scheduled justification: `workflow.steps:execute` (permanently retired Slack feature), `reminders:read`/`reminders:write` (superseded by **R-01**'s bot-token approach), `incoming-webhook` (redundant with `chat:write`), and `users:write` (only affects bot presence, already covered by `bot_user.always_online`). Remove these from the Slack app manifest on api.slack.com and reinstall.
  - Why: **Scope hygiene**'s findings are otherwise permanent prose with no execution path, unlike O-06..O-10, which are actionable; this closes that gap so least-privilege (guiding principle 2) is actually enforced, not just documented.
  - Scope(s) & token type: n/a (Slack app manifest/settings).
  - API methods: n/a.
  - Files to touch: none in this repo (Slack app manifest on api.slack.com).
  - Depends on: R-01 (don't drop `reminders:*` until its bot-token replacement ships).
  - Acceptance criteria: the four scopes above are removed from the manifest; the app is reinstalled; `slack_identity`'s `auth.test` output (or **O-03**'s doctor CLI, once it exists) no longer lists them as granted.
  - Tests: n/a (manual verification).
  - Size: S

- [~] **H-03: [MANUAL] Live-verify the webhook bridge recipe end-to-end** — Build the actual Workflow Builder workflow described in **H-01**'s recipe doc in `lostgradient` (webhook trigger → "Send a webhook" step → "Extract JSON" → message step showing the agent's reply) and confirm it works, once a public Gateway origin exists.
  - Why: this is the live, human/browser-dependent half of H-01 that an automated, code-focused pipeline cannot perform — building and clicking through a Workflow Builder workflow in Slack's web UI.
  - Scope(s) & token type: none new.
  - API methods: none (Workflow Builder UI + existing OpenClaw Gateway endpoint).
  - Files to touch: none in this repo (Slack Workflow Builder + `~/.openclaw/openclaw.json`'s `gateway.publicOrigin`, if not already set by O-06).
  - Depends on: O-06 (needs `gateway.publicOrigin` set), H-01 (the recipe doc to follow).
  - Acceptance criteria: the workflow runs once in `lostgradient` and returns the agent's reply through the "Extract JSON" step into a message; H-01's recipe doc is corrected if the live run surfaces any inaccuracy.
  - Tests: n/a (manual verification).
  - Size: S

---

## Scope hygiene

**Status: advisory only.** The owner deferred all scope trimming on
2026-09-23 and may keep broad scopes (`users:write`, `chat:write.customize`,
`chat:write.public`, `channels:manage`, …) for the features they enable. Read
"Drop"/"Trim candidate" below as *candidate for trimming if no feature claims
it*, not as an instruction. Trust-sensitive scopes that are kept should be
gated through **O-02**. Findings:

- **Trim candidate: `workflow.steps:execute` (bot).** Slack permanently retired legacy
  "Steps from Apps" 2024-09-26 (apps couldn't even add this scope since
  October 2023). Dead weight — drop as part of **O-11**.
- **Trim candidate: `reminders:read`/`reminders:write` (bot).** Token-type support for
  `reminders.add`/`reminders.list` is UNVERIFIED and internally inconsistent
  in Slack's own docs (see **R-01**'s note) — don't cite "bot-token entry
  doesn't exist" as the reason. The solid reason to drop these is that both
  methods are documented as retired/degraded since March 2023 regardless of
  token type. Once **R-01** ships (bot-token-based reminders via
  `conversations.open` + `chat.scheduleMessage`), there's no remaining reason
  for either the bot or user `reminders:*` grants; drop both at the same
  manifest reinstall as **O-11**.
- **Reconsider `incoming-webhook`.** Strictly weaker than and redundant with
  the already-granted `chat:write` bot token used for every post in this
  plugin; no code path (in this plugin or the channel plugin) uses it. Drop
  as part of **O-11** unless a concrete future use is scheduled.
- **Reconsider `users:write`.** Confirmed to enable only `users.setActive`/
  `users.setPresence` — the **bot's own** presence, not a human's. The
  manifest already sets `bot_user.always_online: true`, which covers the only
  presence signal Slack shows for an app bot, so this scope currently has no
  visible effect. Drop as part of **O-11** unless a future "set my own human
  presence during focus time" (user-token) feature is scheduled — that would
  be a distinct, separately-justified feature.
- **`links:read` / `links:write` / `links.embed:write`** — see **S-06**;
  decision pending, architecturally gated on `link_shared` event subscription
  (a channel-plugin change) plus **O-01**.
- **`triggers:read` / `triggers:write` (W-01: no usable path; flag for
  removal).** `workflows.triggers.create/update/delete/list/info` exist, but
  they're undocumented internals of the Deno/CLI automation platform and can
  only target workflows declared in the calling app's own manifest
  (`#/workflows/<callback_id>` + `workflow_app_id`). This app declares none
  and can't host any without Socket Mode function handling, which the channel
  plugin owns. They can't target Workflow Builder–authored workflows. W-02's
  webhook-trigger URL needs no scope at all. Drop both at the next manifest
  review (fold into **O-11**) unless the app ever ships manifest-defined
  workflows.
- **`workflows.templates:read` / `workflows.templates:write` (W-03: no
  method exists; flag for removal).** The docs.slack.dev scope pages list no
  consuming methods. The method index has no template method (`workflows.*`
  is only `featured.*`, which uses `bookmarks:*`, and
  `triggers.permissions.*`). Neither the Slack CLI, the Deno/Node SDKs nor the
  generated `slack-edge` client define one. Nothing in this plugin can
  exercise them. Drop both at the next manifest review (fold into **O-11**)
  unless Slack publishes a `workflows.templates.*` method.
- **`mcp:connect` (W-04: no method consumes it; flag for removal).** The
  scope only lets Slackbot call an MCP server declared in the app manifest's
  `mcp_servers` block. Slack is the client, and the app never makes a request
  that uses it. The MCP-related Web API methods
  (`admin.apps.mcp.servers.list`, `admin.apps.mcp.servers.permissions.*`)
  are Enterprise org-admin methods on `admin.apps:*` user tokens, not
  `mcp:connect`. Nothing in this plugin can exercise it. Drop it at the next
  manifest review (fold into **O-11**) unless the owner decides to expose
  OpenClaw's Gateway as an MCP server to Slackbot (see **Open questions**).
- **`usergroups:write`** is correctly **not** granted — keep it that way
  unless a write-capable usergroup feature is explicitly scoped and justified
  (see S-04, which ships read-only by design).
- **`groups:write`, `groups:write.topic`, `groups:write.invites`** are
  correctly **not** granted, which is why S-01/S-02's channel-lifecycle tools
  are public-channel-only. This appears to be a deliberate risk decision, not
  an oversight — confirm with whoever owns the Slack app before requesting
  them (see **Open questions**).
- **Justify or drop `search:read.public`/`search:read.files` (bot).** These
  are consumed only by `assistant.search.context`. Its docs list three bot
  scopes — `search:read.files`, `search:read.public`, `search:read.users`
  (only the first two are granted) — but do **not** clearly state whether all
  three are required together (AND) or any one is sufficient (OR); treat that
  as UNVERIFIED rather than a confirmed second blocker. The one **clearly
  confirmed** blocker, and reason enough on its own to drop these scopes, is
  that `assistant.search.context`'s `action_token` appears to only be
  mintable inside a live Slack Agent-View/assistant-thread interaction —
  meaning only the channel plugin, not this tool plugin, could ever obtain
  one (see **Open questions**). The working search path today, and the one
  this roadmap keeps, is user-token `slack_search` (`search.messages`/
  `search.files`, `search:read`/`search:read.files` user scopes). Drop the
  bot-scope grants unless a concrete `assistant.search.context` path is
  confirmed.
- **Justify or drop `chat:write.public` (bot).** Granted, and lets every
  `chat.postMessage`-based tool in this plugin post into *any* public channel
  the bot hasn't joined — a real posting-scope-hygiene concern with no
  current mention anywhere in this roadmap, in violation of guiding principle
  2. No tool today deliberately exercises "post into a channel the bot isn't
  a member of" as a feature, and none of S-01/S-02's channel-lifecycle tools
  need it (they use `channels:manage`/`chat:write`, joining or creating the
  channel first). Either: (a) document a concrete scenario that needs it
  (e.g. `slack_post_table`/`slack_blocks_send` posting into an arbitrary
  public channel by ID without the bot joining first — if kept, gate it
  behind a confirmation the way S-01's
  archive/rename are gated, since posting into a channel with no
  members/context is itself a spoofing-adjacent risk), or (b) drop it at the
  next manifest reinstall (fold into **O-11**) and require the bot to be a
  member of a channel before this plugin will post to it.

---

## Explicitly out of scope ("not doing")

Recorded so a future pass through this backlog doesn't re-propose them:

- **Per-message personas via `chat:write.customize` (formerly M-06).** Dropped
  by the owner on 2026-09-23. `chat:write.customize` stays granted (trimming
  is deferred) but no feature uses it.
- **Features for `chat:write.public` and `users:write`.** The owner has no
  interest in dedicated features for these scopes (2026-09-23).
- **`assistant.threads.setStatus` (typing/thinking indicator).** Already
  owned by the bundled Slack channel plugin, which drives session status
  (processing/suspended/active).
- **App Home / `views.publish`.** Already owned by the channel plugin, which
  publishes a default Home view on every `app_home_opened`. A plugin-local
  `views.publish` call would race it.
- **Legacy message `attachments`.** Deprecated by Slack in favor of Block
  Kit; this plugin correctly has none (see D-03).
- **`chat.unfurl` / Work Objects without event wiring.** Blocked on
  `link_shared` not being a subscribed bot event and `defineToolPlugin`'s
  inability to receive raw Slack events — see S-06. Not buildable as a
  standalone tool-plugin feature today.
- **Legacy Workflow Steps from Apps (`workflow.steps:execute`).** Retired by
  Slack 2024-09-26; cannot be built regardless of scope.
- **Modern custom Workflow Steps (`functions.completeSuccess`/`Error`).**
  Works fine in Bolt over Socket Mode, but this app's one Socket Mode
  connection is owned by the bundled channel plugin, and `defineToolPlugin`
  cannot register the interactive/event handlers this needs. Would require
  both **O-01** and a documented forwarding mechanism from the channel
  plugin that doesn't exist today — track as a future cross-plugin
  architecture question, not a task on this list.
- **A `slack_modal_open` (`views.open`) agent tool (M-10).** `views.open`
  needs a `trigger_id` from a live interaction that expires in 3 seconds. The
  bundled channel plugin owns the Socket Mode connection that receives those
  payloads and redacts trigger IDs from agent context; `toolContext` has no
  such field. Fully gated on (a) a channel-plugin relay of `trigger_id` to
  this plugin and (b) the **O-01** entry migration, and even then the modal
  would be opened by a plugin interactive handler reacting to a button
  click, not by an agent tool call. No build task is scheduled.
- **`slack_trigger_create`/`list`/`delete` tools (W-01).**
  `workflows.triggers.*` only target workflows defined in the calling app's
  own manifest, never Workflow Builder–authored ones. This app has no
  manifest workflows and can't host them while the channel plugin owns Socket
  Mode. The methods are also undocumented outside the Deno SDK/Slack CLI.
  Starting a Workflow Builder workflow goes through **W-02**'s webhook-trigger
  URL instead.
- **`slack_workflow_template_*` tools (W-03).** No public or internal Web API
  method reads, creates or publishes Workflow Builder templates, despite the
  `workflows.templates:*` scopes existing. Templates are a UI-only gallery
  today. Revisit if Slack documents a `workflows.templates.*` method.
- **Any `mcp:connect`-backed tool (W-04).** The scope has no Web API
  surface. It authorizes Slackbot to call *into* an MCP server listed in the
  app manifest, so there's nothing for an agent tool to call. Making OpenClaw
  reachable from Slackbot would be Gateway work (a public Streamable HTTP MCP
  endpoint) plus a manual manifest edit, not a tool in this plugin.
- **A `slack_list_discovery` tool (L-07).** Slack has no documented method
  that enumerates Lists in a workspace or channel. Callers must already know a
  `list_id` (from `slack_list_create` or a shared link); `search.files` may
  surface Lists by name, but that's unverified pending a live check.
- **Pins, reactions, emoji list, member info, in-turn file upload/download,
  conversation-open for ordinary chat, assistant thread status.** All
  already owned by the bundled Slack channel plugin.

---

## Decisions

Recorded 2026-09-23 by the owner:

- **`lostgradient` is on a paid Slack plan.** Canvases, Lists, Workflow
  Builder and webhook triggers are all available; the Canvases, Lists,
  Workflows and Webhooks tiers stand as written.
- **Adopt the fuller plugin API.** The `defineToolPlugin` →
  `definePluginEntry` migration (**O-01**) is confirmed and moved to
  **Tier 0.5**, together with approvals (**O-02**) and the doctor CLI
  (**O-03**).
- **Scope trimming is deferred.** **O-11** is on hold and **Scope hygiene**
  is advisory. The owner is inclined to keep several broad scopes for the
  features they unlock; gate them through O-02 rather than remove them.
- **Scope-driven extras: channel management and self-joining only.** The
  owner wants channel management (S-01, S-02) and the agent joining public
  channels on its own (S-07, which needs O-12 to add `channels:join`). These
  are moved to a priority section at the start of Tier 2. Personas (M-06) and
  features for `chat:write.public`/`users:write` are dropped.

---

## Open questions / needs-human-decision

- **Does `canvases.sections.lookup` return section text, or only an opaque
  `id`?** One example response showed `{"id": "temp:C:..."}` only. If it's
  id-only, there is no way to read a canvas's current content back via the
  API at all — confirm live before finalizing C-07's design.
- **Are canvas section IDs stable across subsequent edits, or must they be
  re-looked-up before every edit?** Treat as re-lookup-required (C-07's
  current design) until verified live.
- **Does OpenClaw's plugin-sdk provide any persistent key-value storage** a
  tool plugin can use for an external-id-to-row-id mapping, needed by any
  future Lists external-data-sync feature (see L-03)? Not investigated.
- **Is there an actual Web API method to discover/list all Lists in a
  workspace or channel** (a Lists analog of `files.list`)? See L-07.
- **What do the Lists `reference` and `canvas` column types actually do** —
  do they link to other Lists or Canvas documents natively? Not detailed in
  docs found during research.
- **What columns does `todo_mode: true` auto-create on `slackLists.create`?**
  Not documented in the pages found.
- **What is `over_column_maximum`'s actual numeric ceiling** (max columns per
  list), and is there a max-items-per-list limit? Not stated in docs found.
- **Does `canvases.access.set`'s note that "canvas must be shared with
  user/channel before permission changes via API" conflict with the existing
  `slack_canvas_create` flow**, which relies on `canvases.access.set` for the
  *first* share? Needs a live smoke test against a real `canvas_id`, not
  further doc reading — fold into I-01/C-04's implementation.
- **Should OpenClaw be exposed to Slackbot as an MCP server?** This is the
  only real use of the granted `mcp:connect` scope (see W-04). It would need
  an OpenClaw Gateway endpoint speaking Streamable HTTP MCP, a public HTTPS
  origin (**O-06**) and an `mcp_servers` manifest entry, and it would overlap
  with the channel plugin's own conversational surface. If the owner says no,
  drop the scope with **O-11**.
- **Are `channels:manage`/`channels:write.topic`/`channels:write.invites`
  being deliberately scoped to public channels only** (a risk decision), or
  should `groups:write*` be requested for private-channel automation? Ask
  whoever owns the Slack app before requesting new scopes.
- **Can a bot token ever obtain the `action_token` `assistant.search.context`
  needs**, or is it only mintable inside a live Slack Agent-View/assistant
  interaction the channel plugin alone can hold? This is the one clearly
  confirmed blocker and is sufficient on its own — see **Scope hygiene**.
  Separately and UNVERIFIED: whether `assistant.search.context`'s three bot
  scopes (`search:read.files`/`search:read.public`/`search:read.users`, only
  the first two granted) are required together (AND) or any one suffices
  (OR) — Slack's docs don't say, so don't treat the missing
  `search:read.users` grant as a second confirmed blocker on its own.
- **Does `openclaw secrets reload` exist as a real CLI command?**
  `resolveToken`'s error message (`src/index.ts:25`) tells operators to run
  it — unverified against CLI reference docs in this research pass.
- **Is `channels.slack.botToken` (channel plugin config) intentionally kept
  independent of this plugin's own `botToken` config**, or should this plugin
  fall back to the channel plugin's already-resolved runtime token? Worth a
  maintainer sanity check before treating either pattern as supported.

---

## Research appendix

Key sources consulted while compiling this roadmap (Slack platform docs;
OpenClaw's locally bundled docs are under `node_modules/openclaw/docs/` in
this repo and were also read in full for the OpenClaw-integration items):

- Slack Web API rate limits: https://docs.slack.dev/apis/web-api/rate-limits/
- `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage/
- `chat.update` (`cant_update_message`): https://docs.slack.dev/reference/methods/chat.update/
- `chat.scheduleMessage`: https://docs.slack.dev/reference/methods/chat.scheduleMessage/
- `chat.scheduledMessages.list`: https://docs.slack.dev/reference/methods/chat.scheduledMessages.list
- `chat.postEphemeral`: https://docs.slack.dev/reference/methods/chat.postEphemeral/
- Plan block reference: https://docs.slack.dev/reference/block-kit/blocks/plan-block/
- Rich text block: https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/
- Context actions block: https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/
- Canvases surface overview: https://docs.slack.dev/surfaces/canvases
- `canvases.create`/`canvases.edit`/`canvases.delete`/`canvases.sections.lookup`/`canvases.access.set`/`canvases.access.delete`: https://docs.slack.dev/reference/methods/
- `conversations.canvases.create`: https://docs.slack.dev/reference/methods/conversations.canvases.create
- Slack Lists changelog/inventory: https://docs.slack.dev/changelog/2025/09/02/list-api
- `slackLists.create`/`.update`/`.items.*`/`.access.*`: https://docs.slack.dev/reference/methods/
- Message metadata: https://docs.slack.dev/messaging/message-metadata/
- `metadata.message:read` scope: https://docs.slack.dev/reference/scopes/metadata.message.read/
- Files external upload: https://docs.slack.dev/reference/methods/files.getUploadURLExternal/, https://docs.slack.dev/reference/methods/files.completeUploadExternal/
- `files.remote.add` / `remote_files:write` scope: https://docs.slack.dev/reference/methods/files.remote.add/, https://docs.slack.dev/reference/scopes/remote_files.write/
- `usergroups.list`/`usergroups.users.list`: https://docs.slack.dev/reference/methods/usergroups.list/
- Channel management scopes: https://docs.slack.dev/reference/scopes/channels.manage/, channels.write.invites/
- `reminders.add`/`reminders.list`: https://docs.slack.dev/reference/methods/reminders.add/, reminders.list/
- `workflow.steps.execute` retirement: https://docs.slack.dev/reference/scopes/workflow.steps.execute/
- Custom Workflow Steps (functions): https://docs.slack.dev/tools/bolt-js/concepts/custom-steps/
- `triggers.write` scope / workflow triggers: https://docs.slack.dev/reference/scopes/triggers.write/
- Webhook triggers (Workflow Builder): https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-webhook-triggers
- `mcp.connect` scope: https://docs.slack.dev/reference/scopes/mcp.connect/
- `chat.write.customize` scope: https://docs.slack.dev/reference/scopes/chat.write.customize/
- `chat.write.public` scope: https://docs.slack.dev/reference/scopes/chat.write.public/
- `assistant.search.context`: https://docs.slack.dev/reference/methods/assistant.search.context/
- `reminders.write` scope: https://docs.slack.dev/reference/scopes/reminders.write/
- `bookmarks.edit`: https://docs.slack.dev/reference/methods/bookmarks.edit/
- OpenClaw docs (local): `plugins/tool-plugins.md`, `plugins/building-plugins.md`, `plugins/hooks.md`, `plugins/plugin-permission-requests.md`, `plugins/message-presentation.md`, `plugins/manifest*.md`, `plugins/sdk-testing.md`, `plugins/sdk-runtime/config-and-utilities.md`, `automation/cron-jobs/*.md`, `automation/taskflow.md`, `automation/standing-orders.md`, `channels/slack.md`, `channels/slack/*.md` (setup, messaging, rich-messages, threads-and-sessions, ambient-room-events, access-control, manifest-and-scopes, media, events, bot-loop-protection).
