import { approvalFor, type ApprovalRequest } from "./approvals.js";

/** The slice of a `before_tool_call` event this plugin's policy reads. */
export type ToolCallEvent = { toolName: string; params: Record<string, unknown> };

/**
 * `before_tool_call` policy for this plugin's own tools. Destructive calls matched by
 * the approval registry wait for a human; returning `undefined` lets the call proceed.
 */
export function beforeToolCall(
  event: ToolCallEvent,
): { requireApproval: ApprovalRequest } | undefined {
  const requireApproval = approvalFor(event.toolName, event.params ?? {});
  return requireApproval ? { requireApproval } : undefined;
}
