import { describe, expect, it, vi } from "vitest";
import { resolveRoutingConfiguration } from "./routing-configuration.js";
import { resolveMessageRoute, type InboundRoutingMessage, type RoutingTarget } from "./routing-resolver.js";
import type { SessionTarget } from "./routing-configuration.js";
import type { MessageOrigin } from "./routing-storage.js";

const configuration = resolveRoutingConfiguration({ enabled: true, directMessages: { defaultTarget: { agentId: "default", sessionKey: "global" }, rules: [
  { accountId: "a", workspaceId: "w", userId: "u", target: { agentId: "user", sessionKey: "global" } },
  { accountId: "a", workspaceId: "w", userId: "u", channelId: "D1", target: { agentId: "channel", sessionKey: "global" } },
] } })!;
const message = (overrides: Partial<InboundRoutingMessage> = {}): InboundRoutingMessage => ({ accountId: "a", workspaceId: "w", channelId: "D1", userId: "u", messageId: "m", text: "hello", isDirect: true, ...overrides });
const origin = (overrides: Partial<MessageOrigin> = {}): MessageOrigin => ({ accountId: "a", workspaceId: "w", channelId: "D1", agentId: "agent", sessionKey: "global", sessionId: "s1", messageTs: "1", createdAt: 900, expiresAt: 10_000, excerpt: "outbound", ...overrides });
function harness(options: { records?: MessageOrigin[]; resolve?: (target: SessionTarget, expected?: string) => Promise<RoutingTarget | undefined>; classify?: (candidates: MessageOrigin[], text: string) => Promise<MessageOrigin | undefined>; now?: number } = {}) {
  const classify = vi.fn(options.classify ?? (async (candidates: MessageOrigin[]) => candidates[0]));
  const resolve = vi.fn(options.resolve ?? (async (target: SessionTarget, expected?: string) => ({ ...target, sessionId: expected ?? `${target.agentId}-session` })));
  return {
    storage: { findMessage: async (_address: unknown, ts: string) => options.records?.find((record) => record.messageTs === ts), recentMessages: async () => options.records ?? [] },
    services: { resolveTarget: resolve, classify, now: () => options.now ?? 1000 },
    resolve,
    classify,
  };
}

describe("resolveMessageRoute", () => {
  it("uses exact replies and threads before any model call", async () => {
    const h = harness({ records: [origin()] });
    expect(await resolveMessageRoute(message({ replyToTs: "1" }), configuration, h.storage, h.services)).toMatchObject({ reason: "reply", target: { sessionId: "s1" } });
    expect(await resolveMessageRoute(message({ replyToTs: undefined, threadTs: "1" }), configuration, h.storage, h.services)).toMatchObject({ reason: "thread" });
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("falls back from a stale explicit origin without semantic inference", async () => {
    const h = harness({ records: [origin({ sessionId: "stale" })], resolve: async (target, expected) => expected === "stale" ? undefined : { ...target, sessionId: "default-session" } });
    const result = await resolveMessageRoute(message({ channelId: "D9", userId: "other", replyToTs: "1" }), configuration, h.storage, h.services);
    expect(result).toMatchObject({ reason: "direct-message-default", target: { agentId: "default" } });
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("prefers channel rules over user rules and does not route non-DMs", async () => {
    const h = harness();
    expect(await resolveMessageRoute(message(), configuration, h.storage, h.services)).toMatchObject({ reason: "direct-message-rule", target: { agentId: "channel" } });
    expect(await resolveMessageRoute(message({ isDirect: false }), configuration, h.storage, h.services)).toEqual({ reason: "normal" });
  });

  it("filters future, expired, unauthorized, duplicate-generation, and cross-address candidates", async () => {
    const h = harness({ records: [
      origin({ sessionId: "future", messageTs: "future", createdAt: 2000 }),
      origin({ sessionId: "expired", messageTs: "expired", expiresAt: 999 }),
      origin({ sessionId: "unauthorized", messageTs: "unauthorized" }),
      origin({ sessionId: "s1", messageTs: "duplicate" }),
      origin({ sessionId: "other-address", messageTs: "other", channelId: "D2" }),
    ], resolve: async (target, expected) => expected === "unauthorized" ? undefined : { ...target, sessionId: expected! } });
    const result = await resolveMessageRoute(message({ isDirect: false }), { ...configuration, directMessages: { rules: [] } }, h.storage, h.services);
    expect(result.reason).toBe("semantic");
    expect(h.classify).toHaveBeenCalledWith([expect.objectContaining({ messageTs: "duplicate" })], "hello");
  });

  it("revalidates the selected generation after classification", async () => {
    let calls = 0;
    const h = harness({ records: [origin()], resolve: async (target, expected) => { calls++; return calls > 1 ? undefined : { ...target, sessionId: expected! }; } });
    expect(await resolveMessageRoute(message({ isDirect: false }), { ...configuration, directMessages: { rules: [] } }, h.storage, h.services)).toEqual({ reason: "normal" });
  });
});
