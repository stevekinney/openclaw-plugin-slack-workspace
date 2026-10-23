import { describe, expect, it } from "vitest";
import { resolveRoutingConfiguration } from "./routing-configuration.js";

const target = { agentId: "support", sessionKey: "agent:support:slack" };

describe("resolveRoutingConfiguration", () => {
  it("treats an omitted or false opt-in as disabled", () => {
    expect(resolveRoutingConfiguration(undefined)).toBeUndefined();
    expect(resolveRoutingConfiguration({})).toBeUndefined();
  });
  it("returns undefined when routing is disabled", () => {
    expect(resolveRoutingConfiguration({ enabled: false })).toBeUndefined();
  });

  it("fills bounded defaults for enabled routing", () => {
    expect(resolveRoutingConfiguration({ enabled: true })).toEqual({
      enabled: true,
      accountId: "default",
      directMessages: { rules: [] },
      semanticReplies: { enabled: true, windowSeconds: 900, maximumCandidates: 5 },
      retention: { messageDays: 30, maximumMessages: 10_000, interactionHours: 24, maximumInteractions: 2_000 },
    });
  });

  it("rejects unknown fields, out-of-range values, duplicate matches, and mismatched ownership", () => {
    expect(() => resolveRoutingConfiguration({ enabled: true, typo: true })).toThrow(/Unknown/);
    expect(() => resolveRoutingConfiguration({ enabled: true, semanticReplies: { windowSeconds: 0 } })).toThrow(/between/);
    const rule = { accountId: "a", workspaceId: "w", userId: "u", target };
    expect(() => resolveRoutingConfiguration({ enabled: true, directMessages: { rules: [rule, rule] } })).toThrow(/Duplicate/);
    expect(() => resolveRoutingConfiguration({ enabled: true, directMessages: { defaultTarget: { agentId: "a", sessionKey: "agent:b:main" } } })).toThrow(/does not belong/);
    expect(() => resolveRoutingConfiguration({ enabled: true, semanticReplies: { maximumCandidates: 64 } })).toThrow(/between/);
  });

  it("permits disjoint channel-specific rules and preserves targets", () => {
    const resolved = resolveRoutingConfiguration({ enabled: true, accountId: "workspace-account", directMessages: { defaultTarget: target, rules: [
      { accountId: "a", workspaceId: "w", userId: "u", channelId: "D1", target },
      { accountId: "a", workspaceId: "w", userId: "u", channelId: "D2", target: { agentId: "billing", sessionKey: "global" } },
    ] } });
    expect(resolved?.directMessages.rules).toHaveLength(2);
    expect(resolved?.accountId).toBe("workspace-account");
    expect(resolved?.directMessages.defaultTarget).toEqual(target);
  });
});
