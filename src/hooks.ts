/** The slice of a `before_tool_call` event this plugin's policy reads. */
export type ToolCallEvent = { toolName: string; params: Record<string, unknown> };

/**
 * `before_tool_call` policy for this plugin's own tools. Returning `undefined` means
 * "no decision": the call proceeds. Approval gates for destructive tools plug in here.
 */
export function beforeToolCall(_event: ToolCallEvent): undefined {
  return undefined;
}
