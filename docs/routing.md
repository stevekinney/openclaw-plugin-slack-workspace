# Slack session routing

Status: implemented in this plugin with a companion OpenClaw host change. Routing is opt-in. Version 0.2.0 requires OpenClaw 2026.10.5 or later, including when routing is disabled, because older advertised hosts lack the imported asynchronous session reader. The stock 2026.10.5 and 2026.10.6 hosts do not include the companion inbound routing contract; enabling routing without contract version 1 fails at registration with an actionable error. Publishing or installing this plugin does not install the companion.

The live verification below records the explicitly authorized installation on 2026-10-23, rather than current production health. That installation enabled routing for the private Gowanus DM and passed live Slack checks after correcting callback namespace, retained-generation, and missing event-channel defects. Revalidate a subsequent deployment before describing it as live-verified.

## Routing contract

The plugin owns configuration, bounded persistent message ownership, prepared interactions, and follow-up classification. OpenClaw owns Slack authentication, sender admission, attachments, transcript recording, queues, and reply delivery. The host calls `resolve_inbound_route` after Slack admission and before session admission. A route includes `agentId`, `sessionKey`, and `expectedSessionId`; a terminal drop prevents stale controls from falling through. The host validates the expected concrete session at the database commit boundary.

The deployment companion checkout is `/Users/stevekinney/.agent-worktrees/codex/slack-routing-live`, branch `steve/slack-routing-live`, based on production revision `1b58cb9a1b4f4353e1add63c8506db4d890962e8` (OpenClaw 2026.10.5, state schema 20, agent schema 25). The earlier source fork at `2559f8f7cc9f1b2f74910915265ccd15d9d6606d` and the separate source checkout at `6215ad73a2d35595b942970268e04aec9cc59987` have different schema versions and are not deployment candidates. The companion preserves the deployed Railway plugin-loading and read-only state patch. Its routing-only changes are included in [openclaw-routing.patch](openclaw-routing.patch); the patch applies to the exact production base. The gateway and separately installed Slack channel must be installed together before enabling routing.

Prepared callback data starts with the registered `slack-workspace` namespace, matching the host dispatcher's first-colon namespace contract. Prepared action and callback identifiers take precedence over provider block/view identifiers. Message precedence is explicit reply, thread origin, unambiguous recent follow-up, conversation-specific DM rule, user-specific DM rule, default DM target, then ordinary host routing. An inactive explicit origin skips semantic inference. Ordinary text can follow configured rules; stale interactive controls are dropped. The default DM target is limited to `routing.accountId` and the workspace authenticated by the bot token. A workspace lookup failure disables that fallback. Explicit rules still require their own exact account, workspace, user, and optional channel match.

Configured targets pin the first resolved concrete session generation in persistent state. Archive, reset, replacement, or deletion makes that pin inactive. Removing a target from configuration removes its pin when fixed-target resolution next initializes. Session identity is checked again after inference, and the host guards admission against concurrent archive/reset.

## Ownership and storage

Successful tool sends are observed at the Slack mutation boundary before optional enrichment. Native Slack sends publish trusted concrete provenance through `message_sent`. Model-supplied parameters cannot establish ownership. Edits preserve the first origin and absolute expiry; deletes remove message associations. Bookkeeping failure after a committed Slack mutation produces a tool warning without repeating the mutation.

Message associations are scoped to account, workspace, and actual Slack conversation/message timestamp. Defaults are 30 days and 10,000 records. Excerpts are capped at 1,000 characters, identifiers at 256, candidates at five, and interaction state at 32 KiB. Prepared interactions default to 24 hours and 2,000 records. Their separate replay store holds at most two small claim records per configured interaction slot, preserving form state when a modal opens or submits. Pending scheduled/file associations have a separate bounded namespace. Fixed targets are capped at 101 pins. Host keyed stores enforce TTL and overflow eviction; reads never extend absolute expiry.

Slack does not deliver scheduled messages carrying metadata. Routed scheduling instead adds an opaque `block_id` on a small context footer, “Scheduled by OpenClaw.” Text-only messages become section blocks with at most 3,000 characters each. One of Slack's 50 blocks is reserved, leaving 49 content blocks. Pending ownership is promoted to the actual timestamp by bounded history/replies reads, requiring the authenticated bot's author ID, matching address, due time, and opaque marker. File shares use pending file IDs when the upload response lacks a message timestamp. No session identifiers are published in markers.

## Models and interactions

Recent follow-up inference uses the default-route agent's Decision model. Availability failures may fall back to its configured Utility model. Ambiguous Decision results retain normal routing; Utility does not overrule them. Evidence uses anonymous candidate labels and bounded message excerpts, with no session identifiers. Inference has a five-second deadline, respects cancellation, and revalidates the selected session.

`slack_interaction_prepare` requires an active Slack turn and stores a modal or external-select options list against its originating session, host-provided Slack conversation, and trusted requester. Optional `channelId` and `userId` must match that host context. Explicit arguments cannot create trusted context from cron jobs or another channel. Its opaque action identifier is attached to a Block Kit button or select. The native handler opens prepared modals and serves filtered options synchronously. Slack’s [block suggestion payload](https://docs.slack.dev/reference/interaction-payloads/block_suggestion-payload/) carries the typed query in `value`; the host maps it to the handler’s `query` field. Modal submission and selection fields travel through the native sanitized system event. Duplicate modal opens/submissions do not enqueue another agent turn; stale, forged, unauthorized, or cross-address controls expire. Trigger IDs and response URLs never enter persistent plugin state or model evidence. Native approval/question handlers retain their own policy.

The README and packaged Block Kit skill describe exact configuration and tool usage. General Block Kit controls continue through native Slack handling, with message-origin routing applied before enqueueing their agent event.

## Toolchain and verification

Development uses Node 24.22.1 (`.node-version`), OpenClaw SDK 2026.10.6, and Vitest 5.0.5. The overrides select npm 12.2.1, [Undici 8.12.3](https://github.com/advisories/GHSA-xjj6-f33q-929c) for the host dependency, and [Zod 4.6.7](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The latter two address the host dependency advisories. npm 12.2.1 still bundles Undici 6.29.0 and `ip-address` 10.7.2, which npm cannot replace through overrides. Their high and moderate advisories remain visible to `npm audit`; production-only auditing is clean. The earlier owner exception covered only the moderate `ip-address` advisory. A new exception or a patched npm release is required before treating the remaining high advisory as accepted.

Plugin quality gates are `npm run typecheck`, `npm test`, `npm run plugin:check`, and `npm run plugin:validate`, run with `mise exec node@24.22.1 --`. Focused regressions cover configuration rejection, deterministic precedence, absolute expiry/capacity, origin ownership, scheduled recovery and copied-marker rejection, fixed generation pinning, native provenance, classifier fallback/cancellation, and prepared interaction authorization/replay.

The release additionally runs `npm run test:artifact` against one packed tarball on the pinned SDK, the minimum supported stock host, and a reviewed companion image. The [README release procedure](../README.md#release) contains the exact commands. The checks verify packaged documentation and dependencies, actual installation and registration, ordinary tool execution, unsupported-host rejection, and routing with real SDK session and keyed-store persistence. Only Slack HTTP responses and the probe's registration capture are substituted; the host runtime and companion contract are real. Passing artifact checks does not establish live Socket Mode, rendered Block Kit behavior, or production readiness.

All Slack calls in automated repository tests use mocked fetch. The owner separately authorized installation, configuration changes, and live Slack verification in the private Gowanus direct message. Live proof requires the authenticated Slack client for buttons, modal rendering, external options, and submission; API receipts alone do not establish those behaviors.

## Verification record

The plugin passed `mise exec node@24.22.1 -- npm run ci`: type checking, build/manifest checking, plugin validation, and 704 tests across 55 files. Log: `/tmp/slack-routing-plugin-ci.log`. `npm audit --json` exited 1 with the single accepted moderate advisory and no high or critical findings; log: `/tmp/slack-routing-final-audit.json`.

The production-matched host passed 282 focused tests across ten files covering hooks, concrete session admission, native outbound ownership, runtime exposure, durable delivery, and system-event generation guards. Log: `/tmp/slack-routing-live-contract-tests.log`. Final core and extension type checks, formatting, and both source lint gates passed through the host's supported wrappers. Logs use the `/tmp/slack-routing-live-verified-` prefix.

The complete production-matched Slack suite passed 1,983 tests across 161 files after correcting question-card progress metadata and modal acknowledgement regressions. Log: `/tmp/slack-routing-live-verified-slack-suite.log`. The focused authenticated-workspace and modal regression run also passed all 92 tests. Concrete generation, cron routing, and inherited production patch regression gates passed. No test timeout, resource limit, assertion, or required gate was weakened. The final full host build passed, including declarations, SDK exports, plugin runtime output, and startup artifacts. Log: `/tmp/slack-routing-live-verified-build.log`.

The separate Railway recovery run restored a healthy gateway before stopping. The deployment candidate now preserves its exact deployed startup patch (SHA-256 `025c167347e2e4fef8cb33eb19cc831af97ae67617eedc405203fa504a11002b`) from template revision `7431d7ecc9c1523b7653f1fc896fa8be313b1edd`. The integrated candidate passed types, lint, the complete Slack suite, and the full build. Both plugin and configuration backups were verified. Final deployment `251111a1-9b2f-456a-b054-f343dbb5d09d` is successful. Its core image has OCI digest `sha256:8eae6bb3dee12abc0a70cd5c0696f7d54045f57a68ca7f41f0e6086c0815da1c`. The workspace plugin archive was installed in gateway generation 3 and the final Slack channel archive in generation 4. Final `healthz`, `startupz`, and `readyz` checks returned 200, with no readiness failures or event-loop degradation. Both Slack accounts were connected without a reported channel error.

The separate strict UI performance check reports an existing startup JavaScript budget overage: the exact base produces 373,907 compressed bytes against a 373,454-byte limit using the same installed toolchain; the controlled routing candidate produces 373,934 bytes. The base control exits 1 with the same violation. No UI source or budget was changed. Logs: `/tmp/slack-routing-live-ui-base-comparison.log`, `/tmp/slack-routing-live-ui-control.log`. The normal full host build exits 0; that result does not claim the separate absolute UI budget is green.

The packed workspace plugin registered its real runtime hooks under Node 24.22.1 against the compiled companion host. The packed Slack channel also loaded successfully against that host using fake credentials and isolated state. Logs: `/tmp/slack-routing-live-runtime-smoke.log`, `/tmp/slack-routing-live-channel-smoke.log`. The companion channel archive is `/tmp/slack-routing-channel-package/openclaw-slack-2026.10.5.tgz` (SHA-256 `86bb38d063bfd7096dd79f0614ab74c6a9ef130afdb3ac13811c3081e30aceaa`).

The final channel-only correction adds `channel: "slack"` in the shared inbound event builder and removes its unchecked type assertion. Existing ordinary-message and modal regressions failed before the correction and passed afterward. Extension types, lint, formatting, and all 1,983 Slack tests passed again; the official package-local channel build, lockfile validation, and packed runtime smoke passed. The unchanged core build evidence remains valid. The final routing-only patch has SHA-256 `1d572eb84e2a12c88c23848a97238bb18ad4a131f395aff9b3f57b3e3a42cb3f` and passes forward application against the exact production base and reverse application against the candidate.

### Live verification

The authenticated Slack client and receiving transcripts established these results in the private Gowanus DM:

- A reply to a message owned by the `postal-service` test session reached that same concrete session, with `route reason=thread`; it did not reach the default session.
- An unthreaded follow-up about the amber lighthouse reached its originating `main` test session, with `route reason=semantic`; it did not reach the default session.
- An unrelated direct message reached the configured `agent:main:main` target.
- Ordinary buttons and static selects rendered and accepted input. The receiving `postal-service` session reported the exact selected value and displayed label.
- Prepared modals opened, external options filtered actual typed queries, and submission closed the modal. An immediate model receipt in the originating session reported the unique submitted note and selected option/value. The earlier later-turn recall check was inconclusive; the immediate receipt is the submission evidence.
- Cancel closed a prepared modal without waking the default session.
- After archiving the originating test session, its old control displayed an expiration response. A text reply to its old message reached the configured main target; the archived session received no new test input and remained archived.
- Successful tool sends returned actual Slack permalinks. Native and tool sends retained the trusted originating agent, session key, and concrete session ID in persistent ownership records.
- The live agent advertised the packaged `slack-block-kit` skill and `slack_interaction_prepare` tool.

Both disposable test sessions were archived after verification. The temporary Railway SSH registration was revoked and its owned local key pair removed, with registry readback confirming revocation. The existing main session retained its original concrete ID and remained active. Final plugin state held 18 message associations, nine prepared interactions, seven small replay claims, and one fixed-target pin: approximately 15 KiB of JSON. Message records retain their absolute 30-day expiry; interactions and replay claims expire after 24 hours. Capacity eviction is verified by automated tests.

Workspace archive SHA-256: `5159d12b6e8a72548d63520686daaef25f961fd53b12f6c4f1fc2bf264206bba`. The final channel archive is retained remotely at `/data/.openclaw/repair-backups/slack-routing-20261023/openclaw-slack-2026.10.5-routing.tgz`, with the matching SHA-256 above. The private execution record and machine-readable receipts use `/tmp/slack-routing-` paths. Client screenshots are stored under `/Users/stevekinney/.codex/visualizations/2026/10/23/01a1668c-5a81-7262-b702-a310e8f5bfe2/`, including `slack-routing-verified-options.png` and `slack-routing-archived-fallback.png`.

The first activation of the corrected image completed Doctor but exhausted Railway's unchanged readiness window before gateway startup finished. A same-image restart used the completed activation receipt and became healthy. No readiness timeout, test assertion, or resource limit was raised. Startup emitted a Node exit-listener warning; it was recorded without suppression. Final readiness and both Slack connections passed.

The companion remains a custom OpenClaw change. The Railway template upgrade integration pins this repository’s complete patch by immutable commit and checksum, applies it during every source build, and runs routing regressions plus a runtime contract check. Source/release mismatches and patch conflicts reject the upgrade instead of producing an image without routing. The supported bundled install (`openclaw plugins install slack`) persists `/app/dist/extensions/slack` as the channel source so subsequent images supply the matched Slack implementation. A stock image outside this protected template does not contain the companion. The initial deployed core image records its core patch digest separately from the subsequently installed channel correction; the upgrade integration supersedes that temporary packaging.

Older companion build/test logs describe the previous schema-incompatible fork and are not deployment evidence for this candidate.

Coordinator token usage and a complete installation-wide cached versus uncached total were unavailable. Two verification RPCs returned per-call agent usage, retained in `/tmp/slack-routing-known-verification-usage.json`; these are partial receipts rather than a session total. No explicit token allowance was requested or inferred.

## Changed files

### Plugin

- `docs/openclaw-routing.patch`
- `.github/workflows/ci.yml`
- `README.md`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `skills/slack-block-kit/SKILL.md`
- `skills/slack-block-kit/references/block-kit.md`
- `src/client.ts`
- `src/doctor.ts`
- `src/index.test.ts`
- `src/index.ts`
- `src/remind.test.ts`
- `src/schemas.test.ts`
- `src/schemas.ts`
- `src/test-utils.ts`
- `src/tool-metadata.ts`
- `src/tool-schemas.test.ts`
- `src/permalink.test.ts`
- `src/tools/messaging.ts`
- `src/tool.ts`
- `src/tools/index.ts`
- `src/tools/scheduling.ts`
- `.node-version`
- `docs/routing.md`
- `src/interactions.test.ts`
- `src/interactions.ts`
- `src/routing-configuration.test.ts`
- `src/routing-configuration.ts`
- `src/routing-integration.test.ts`
- `src/routing-model.test.ts`
- `src/routing-model.ts`
- `src/routing-outbound.ts`
- `src/routing-resolver.test.ts`
- `src/routing-resolver.ts`
- `src/routing-storage.test.ts`
- `src/routing-storage.ts`
- `src/routing.ts`
- `src/tools/interactions.ts`

### OpenClaw companion

- `docs/plugins/hooks/messages.md`
- `extensions/slack/src/installation-identity-state.test.ts`
- `extensions/slack/src/installation-identity-state.ts`
- `extensions/slack/src/interactive-dispatch.ts`
- `extensions/slack/src/message-sent-hook.ts`
- `extensions/slack/src/monitor/events/interactions-routing.ts`
- `extensions/slack/src/monitor/events/interactions.block-actions.ts`
- `extensions/slack/src/monitor/events/interactions.modal.ts`
- `extensions/slack/src/monitor/events/interactions.shortcuts.ts`
- `extensions/slack/src/monitor/events/interactions.test-support.ts`
- `extensions/slack/src/monitor/events/interactions.test.ts`
- `extensions/slack/src/monitor/events/interactions.ts`
- `extensions/slack/src/monitor/message-handler/dispatch-setup.ts`
- `extensions/slack/src/monitor/message-handler/dispatch.ts`
- `extensions/slack/src/monitor/message-handler/prepare.test.ts`
- `extensions/slack/src/monitor/message-handler/prepare.ts`
- `extensions/slack/src/monitor/message-handler/types.ts`
- `extensions/slack/src/send-results.ts`
- `extensions/slack/src/send.blocks.test.ts`
- `extensions/slack/src/send.ts`
- `src/agents/command/prepare.ts`
- `src/channels/session.test.ts`
- `src/channels/session.ts`
- `src/channels/session.types.ts`
- `src/channels/turn/durable-delivery.ts`
- `src/channels/turn/execution.ts`
- `src/channels/turn/lifecycle.ts`
- `src/channels/turn/types.ts`
- `src/config/sessions/runtime-types.ts`
- `src/config/sessions/session-accessor.sqlite-entry.ts`
- `src/config/sessions/session-accessor.test.ts`
- `src/cron/isolated-agent/delivery-dispatch.double-announce.test.ts`
- `src/cron/isolated-agent/delivery-dispatch.ts`
- `src/hooks/message-hook-mappers.ts`
- `src/infra/heartbeat-dispatch.ts`
- `src/infra/heartbeat-runner-run.ts`
- `src/infra/outbound/deliver-core.ts`
- `src/infra/outbound/deliver-queue.ts`
- `src/infra/outbound/deliver.test.ts`
- `src/infra/outbound/message-sent-hook.ts`
- `src/infra/outbound/message.ts`
- `src/infra/outbound/session-context.test.ts`
- `src/infra/outbound/session-context.ts`
- `src/infra/system-events.test.ts`
- `src/infra/system-events.ts`
- `src/plugin-sdk/plugin-entry.ts`
- `src/plugin-sdk/test-helpers/plugin-runtime-mock.ts`
- `src/plugin-sdk/test-helpers/plugin-runtime-model-mock.ts`
- `src/plugins/hook-message.types.ts`
- `src/plugins/hook-types.ts`
- `src/plugins/hooks.resolve-inbound-route.test.ts`
- `src/plugins/hooks.ts`
- `src/plugins/loader-runtime-load.ts`
- `src/plugins/runtime/runtime-channel.ts`
- `src/plugins/runtime/system-events.ts`
- `src/plugins/runtime/types-channel.ts`
- `src/plugins/runtime/types-core.ts`

Target liveness uses `getSessionEntryAsync` from `openclaw/plugin-sdk/session-store-runtime`, selecting the configured agent store with `readConsistency: "latest"`. Local archive plugins cannot use the privileged Gateway RPC API; the regression denies that API and still resolves the configured target. Utility fallback requires the plugin LLM policy to allow the configured Utility model and explicit agent selection; the installation limits completion and override models to `openai/gpt-5.6-luna`.
