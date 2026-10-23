import { describe, expect, it, vi } from "vitest";
import type { DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import { classifyRecentReply } from "./routing-model.js";
import type { MessageOrigin } from "./routing-storage.js";

const origin: MessageOrigin = {
  accountId: "default", workspaceId: "TTEST", channelId: "DTEST",
  agentId: "main", sessionKey: "agent:main:research", sessionId: "session-test",
  messageTs: "1000.000001", createdAt: 1000, expiresAt: 100000,
  excerpt: "The routing proposal is ready for review.",
};
const success = (choice: string, probabilities: Record<string, number>) => ({
  status: "ok" as const,
  result: { model: "test/decision", answers: { route: { type: "choice" as const, choice, probabilities } } },
  provenance: { providerId: "test", rubricVersion: "1", runtimeGeneration: "test" },
});

describe("semantic reply classification", () => {
  it("selects only a supplied candidate using the owning agent's Decision model", async () => {
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue(success("session_0", { session_0: 0.97, none: 0.03 }));
    const utility = vi.fn();
    expect(await classifyRecentReply({ agentId: "main", message: "Go ahead with that proposal", candidates: [origin], signal: new AbortController().signal }, { decision: { evaluate }, utility })).toEqual(origin);
    expect(utility).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ questions: expect.objectContaining({ route: expect.objectContaining({ type: "choice" }) }) }), expect.objectContaining({ agentId: "main", purpose: "slack.reply-routing" }));
    const supplied = JSON.stringify(evaluate.mock.calls[0][0]);
    expect(supplied).not.toContain(origin.sessionKey);
    expect(supplied).not.toContain(origin.sessionId);
  });

  it("uses Utility only when Decision is unavailable", async () => {
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue({ status: "unavailable", reason: "not-configured" });
    const utility = vi.fn().mockResolvedValue('{"candidate":"session_0","related":true}');
    expect(await classifyRecentReply({ agentId: "main", message: "Ship it", candidates: [origin], signal: new AbortController().signal }, { decision: { evaluate }, utility })).toEqual(origin);
    expect(utility).toHaveBeenCalledOnce();
  });

  it("does not ask Utility to overrule ambiguity or a none decision", async () => {
    const utility = vi.fn();
    for (const outcome of [success("none", { session_0: 0.01, none: 0.99 }), success("session_0", { session_0: 0.51, none: 0.49 })]) {
      const decision = { evaluate: vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue(outcome) };
      expect(await classifyRecentReply({ agentId: "main", message: "What about that?", candidates: [origin], signal: new AbortController().signal }, { decision, utility })).toBeUndefined();
    }
    expect(utility).not.toHaveBeenCalled();
  });

  it("rejects fabricated targets, malformed output, and unrelated utility answers", async () => {
    for (const answer of ['{"candidate":"agent:main:other","related":true}', '{"candidate":"session_0","related":false}', 'not json', '{"candidate":"session_0","related":true,"sessionKey":"injected"}']) {
      expect(await classifyRecentReply({ agentId: "main", message: "hello", candidates: [origin], signal: new AbortController().signal }, { utility: async () => answer })).toBeUndefined();
    }
  });

  it("does not start inference without candidates or after cancellation", async () => {
    const utility = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(classifyRecentReply({ agentId: "main", message: "hello", candidates: [origin], signal: controller.signal }, { utility })).rejects.toThrow();
    expect(await classifyRecentReply({ agentId: "main", message: "hello", candidates: [], signal: new AbortController().signal }, { utility })).toBeUndefined();
    expect(utility).not.toHaveBeenCalled();
  });

  it("propagates cancellation during Decision without running Utility", async () => {
    const controller = new AbortController();
    const utility = vi.fn();
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(classifyRecentReply({ agentId: "main", message: "hello", candidates: [origin], signal: controller.signal }, { decision: { evaluate }, utility })).rejects.toThrow();
    expect(utility).not.toHaveBeenCalled();
  });

  it("bounds evidence and rejects oversized utility responses", async () => {
    const utility = vi.fn().mockResolvedValue("x".repeat(1025));
    expect(await classifyRecentReply({ agentId: "main", message: "x".repeat(10000), candidates: [{ ...origin, excerpt: "x".repeat(10000) }], signal: new AbortController().signal }, { utility })).toBeUndefined();
    expect(utility.mock.calls[0][0].length).toBeLessThan(7000);
  });
});
