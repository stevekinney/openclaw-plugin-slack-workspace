# Changelog

## 0.2.1

### Security fixes

- Prevent Real-time Search fallback from discarding conversation-type, content-type, or time restrictions and pagination cursors. If Real-time Search is unavailable, these requests fail without calling legacy search; unrestricted message searches retain the documented fallback.

- Require the existing sharing approvals when converting threads into canvases or Lists, including implicit source-channel sharing and owner access.
- Restrict the default direct-message target to the configured account and the workspace authenticated by the bot token. An unavailable workspace identity disables that fallback; explicitly scoped rules retain their own account and workspace requirements.
- Derive prepared-interaction identity from trusted Slack host context and reject caller-supplied identity mismatches.
- Update development host dependency overrides to Undici 8.12.3 and Zod 4.6.7. The two previously approved npm-bundled advisories remain disclosed in the [routing guide](docs/routing.md#toolchain-and-verification).

OpenClaw compatibility and the opt-in companion requirement remain as documented for 0.2.0.

## 0.2.0

This release adds opt-in Slack session routing and interaction ownership. Existing workspace tools remain available on stock OpenClaw when routing is disabled.

### Compatibility

- Requires OpenClaw 2026.10.5 or later. Older advertised versions do not export the asynchronous session reader imported by this plugin, even with routing disabled.
- Development and plugin metadata validation use OpenClaw SDK 2026.10.6 and Node 24.22.1. The Node engine range in `package.json` also permits supported newer runtimes.
- Routing is disabled by default. Enabling it requires the companion inbound routing contract version 1, including its utility-model resolver and Slack interactive dispatch changes. The stock 2026.10.5 and 2026.10.6 hosts do not provide that contract. Installation of this package does not install the companion or modify the host.
- Enabling routing on an unsupported host rejects plugin registration with an actionable error. Keep routing disabled until the companion host and matched Slack channel are installed.

### Routing and interactions

- Configure direct-message targets and account, workspace, user, and channel rules. Targets are pinned to concrete session identities.
- Replies return to the agent and session that sent the original message. Bounded semantic classification uses the Decision model first and an authorized Utility model fallback.
- Block Kit controls, prepared modals, and external option requests retain their originating session and user restrictions. Native approvals remain owned by OpenClaw.
- Archived, reset, replaced, or deleted sessions are excluded. Message and interaction records have bounded counts and lifetimes.
- Includes the [routing guide](docs/routing.md) and [companion source patch](docs/openclaw-routing.patch) in the published artifact. The guide records the companion's source revision, installation requirements, and the scope of live verification.

The package-artifact checks use disposable OpenClaw state and mocked Slack responses. They verify installation, ordinary tools, unsupported-host rejection, and routing against a real companion runtime. They do not establish production deployment health or live Slack connectivity.
