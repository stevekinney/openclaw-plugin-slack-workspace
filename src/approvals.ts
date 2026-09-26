import { bookmarkApprovals } from "./tools/bookmarks.js";
import { canvasApprovals } from "./tools/canvases.js";
import { channelApprovals } from "./tools/channels.js";
import { listApprovals } from "./tools/lists.js";
import { messagingApprovals } from "./tools/messaging.js";
import { remoteFileApprovals } from "./tools/remote-files.js";
import { schedulingApprovals } from "./tools/scheduling.js";

const PLUGIN_ID = "slack-workspace";

/**
 * What a gated call needs a human to see. `target` names the Slack object the call
 * changes (e.g. `canvas F0123`, `channel C0123`); it becomes the approval's
 * `external-post` scope.
 */
export type ApprovalPrompt = { title: string; description: string; target: string };

/**
 * One entry in the approval registry. `check` receives the raw, not-yet-validated
 * tool params and returns a prompt when this call needs approval, `undefined` when
 * it can proceed. Tools that add trust-sensitive operations (channel archive, rename,
 * kickoff, ...) register a rule here in the same change that adds the tool.
 */
export type ApprovalRule = {
  toolName: string;
  check: (params: Record<string, unknown>) => ApprovalPrompt | undefined;
};

/** The `requireApproval` payload of a `before_tool_call` result. */
export type ApprovalRequest = {
  title: string;
  description: string;
  scope: { kind: "external-post"; target: string; visibility: "public" | "restricted" };
  severity: "warning";
  /** No `allow-always`: this plugin does not persist trust, so every call asks. */
  allowedDecisions: ["allow-once", "deny"];
  /** How long the prompt stays answerable before the call is blocked. */
  timeoutMs: number;
  pluginId: string;
};

/**
 * The host's default is 2 minutes, which was too short to notice a card posted in a
 * busy DM: it expired and the card flipped to "Denied". 10 minutes is the host's cap.
 */
export const APPROVAL_TIMEOUT_MS = 600_000;

/** Every tool call that needs a human's approval before it reaches Slack. */
export const APPROVAL_RULES: readonly ApprovalRule[] = [
  ...schedulingApprovals,
  ...canvasApprovals,
  ...bookmarkApprovals,
  ...channelApprovals,
  ...listApprovals,
  ...remoteFileApprovals,
  ...messagingApprovals,
];

/**
 * Rules interpolate raw, agent-supplied params (IDs, headings) into the prompt. Strip
 * control characters and line breaks so a crafted value can't add lines that read as
 * part of the prompt, and bound the length. Hosts sanitize too; this doesn't rely on it.
 */
export function cleanPromptText(text: string, max = 400): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The approval request for this call, or `undefined` if no rule gates it. */
export function approvalFor(
  toolName: string,
  params: Record<string, unknown>,
): ApprovalRequest | undefined {
  for (const rule of APPROVAL_RULES) {
    if (rule.toolName !== toolName) continue;
    const prompt = rule.check(params);
    if (!prompt) continue;
    return {
      title: cleanPromptText(prompt.title, 120),
      description: cleanPromptText(prompt.description),
      // Slack channels and canvases are visible inside the workspace, not to the public web.
      scope: { kind: "external-post", target: cleanPromptText(prompt.target, 120), visibility: "restricted" },
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: APPROVAL_TIMEOUT_MS,
      pluginId: PLUGIN_ID,
    };
  }
  return undefined;
}
