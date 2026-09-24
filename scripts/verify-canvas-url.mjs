#!/usr/bin/env node
// Live, read-only check that a canvas permalink this plugin builds matches the
// workspace and canvas Slack actually reports. Run after a real
// `slack_canvas_create`, against the canvas id it returned:
//
//   npm run build
//   SLACK_BOT_TOKEN=... node scripts/verify-canvas-url.mjs F0123456789
//
// Makes only `auth.test` and `canvases.sections.lookup` calls; never prints the token.
import { callSlack, canvasPermalink, resolveToken, workspaceFor } from "../dist/client.js";

const canvasId = process.argv[2];
if (!canvasId) {
  console.error("usage: node scripts/verify-canvas-url.mjs <canvas id>");
  process.exit(2);
}

const token = resolveToken({}, "bot");
const workspace = await workspaceFor(token);
if (!workspace) {
  console.error("auth.test failed or returned no url/team_id.");
  process.exit(1);
}

// Proves the canvas resolves for this token's workspace.
await callSlack("canvases.sections.lookup", token, { canvas_id: canvasId, criteria: {} });

const url = canvasPermalink(workspace, canvasId);
const match = new URL(url).pathname.match(/^\/docs\/([^/]+)\/([^/]+)$/);
const ok =
  new URL(url).origin === workspace.origin &&
  match?.[1] === workspace.teamId &&
  match?.[2] === canvasId;

console.log(`${ok ? "ok" : "MISMATCH"}: ${url}`);
process.exit(ok ? 0 : 1);
