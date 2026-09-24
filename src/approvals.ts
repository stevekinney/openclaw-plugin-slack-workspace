import { bookmarkApprovals } from "./tools/bookmarks.js";
import { canvasApprovals } from "./tools/canvases.js";
import { channelApprovals } from "./tools/channels.js";
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
  pluginId: string;
};

/** Every tool call that needs a human's approval before it reaches Slack. */
export const APPROVAL_RULES: readonly ApprovalRule[] = [
  ...schedulingApprovals,
  ...canvasApprovals,
  ...bookmarkApprovals,
  ...channelApprovals,
];

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
      title: prompt.title,
      description: prompt.description,
      // Slack channels and canvases are visible inside the workspace, not to the public web.
      scope: { kind: "external-post", target: prompt.target, visibility: "restricted" },
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      pluginId: PLUGIN_ID,
    };
  }
  return undefined;
}
