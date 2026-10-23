import { describe, expect, it, vi } from "vitest";
import { createInteractionManager, type InteractionOrigin } from "./interactions.js";
import { resolveRoutingConfiguration } from "./routing-configuration.js";

const configuration = resolveRoutingConfiguration({ enabled: true, retention: { interactionHours: 1, maximumInteractions: 10 } })!;
const origin: InteractionOrigin = { agentId: "agent", sessionKey: "global", sessionId: "session-1" };
const address = { accountId: "default", workspaceId: "workspace", channelId: "D1" };

function state(clock: () => number) {
  const namespaces = new Map<string, Map<string, { value: unknown; expiresAt: number }>>();
  return { runtime: { state: { openKeyedStore<T>({ namespace, defaultTtlMs }: { namespace: string; defaultTtlMs?: number }) {
    const rows = namespaces.get(namespace) ?? new Map(); namespaces.set(namespace, rows);
    const sweep = () => { for (const [key, row] of rows) if (row.expiresAt <= clock()) rows.delete(key); };
    return {
      register: async (key: string, value: T, options?: { ttlMs?: number }) => { sweep(); rows.set(key, { value, expiresAt: clock() + (options?.ttlMs ?? defaultTtlMs ?? 0) }); },
      registerIfAbsent: async (key: string, value: T, options?: { ttlMs?: number }) => { sweep(); if (rows.has(key)) return false; rows.set(key, { value, expiresAt: clock() + (options?.ttlMs ?? defaultTtlMs ?? 0) }); return true; },
      lookup: async (key: string) => { sweep(); return rows.get(key)?.value as T | undefined; },
      delete: async (key: string) => rows.delete(key),
    };
  } } } } as any; // The manager only needs the keyed-store write/read primitives above.
}

function manager(clock: () => number, sharedState = state(clock)) {
  return createInteractionManager(sharedState as any, configuration, async (target, expected) => ({ ...target, sessionId: expected ?? origin.sessionId }));
}
const auth = { isAuthorizedSender: async (senderId: string) => senderId === "U1" };

describe("interaction manager", () => {
  it("uses the registered plugin namespace as the first callback segment", async () => {
    const current = manager(() => 1_000);
    for (const input of [
      { kind: "modal" as const, view: { type: "modal", title: { type: "plain_text", text: "Verify" }, blocks: [] } },
      { kind: "options" as const, options: [{ text: { type: "plain_text" as const, text: "Amber" }, value: "amber" }] },
    ]) {
      const prepared = await current.prepare(input, origin, address, "U1");
      // OpenClaw matches callbacks by the segment before the first colon.
      expect(prepared.actionId.split(":", 1)).toEqual(["slack-workspace"]);
    }
  });

  it("persists a modal across manager restart and opens it once", async () => {
    let now = 1_000;
    const shared = state(() => now);
    const first = manager(() => now, shared);
    const prepared = await first.prepare({ kind: "modal", channelType: "im", view: { type: "modal", title: { type: "plain_text", text: "Approve" }, blocks: [] } }, origin, address, "U1");
    const second = manager(() => now, shared);
    const openModal = vi.fn(async () => undefined);
    const context = { accountId: "default", conversationId: "D1", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond: { openModal }, workspaceId: "workspace" };
    expect(await second.handle(context)).toEqual({ handled: true });
    expect(await second.handle(context)).toEqual({ handled: true });
    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it("filters bounded external-select options without inference", async () => {
    let now = 1_000;
    const current = manager(() => now);
    const prepared = await current.prepare({ kind: "options", options: [{ text: { type: "plain_text", text: "Alpha" }, value: "a" }, { text: { type: "plain_text", text: "Beta" }, value: "b" }] }, origin, address, "U1");
    const options = vi.fn(async () => undefined);
    await current.handle({ accountId: "default", conversationId: "D1", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "options", actionId: prepared.actionId, payload: "", query: "alp" }, respond: { options }, workspaceId: "workspace" });
    expect(options).toHaveBeenCalledWith([{ text: { type: "plain_text", text: "Alpha" }, value: "a" }]);
    expect(await current.handle({ accountId: "default", conversationId: "D1", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "select", actionId: prepared.actionId, payload: "selected-value" }, workspaceId: "workspace" })).toEqual({ handled: false, systemEvent: { reference: prepared.reference, data: { reference: prepared.reference } } });
  });

  it("rejects actor or address mismatches and expired controls", async () => {
    let now = 1_000;
    const current = manager(() => now);
    const prepared = await current.prepare({ kind: "modal", view: { type: "modal", title: { type: "plain_text", text: "A" }, blocks: [] } }, origin, address, "U1");
    const respond = { openModal: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) };
    expect(await current.handle({ accountId: "default", conversationId: "D1", senderId: "U2", auth: { isAuthorizedSender: false }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond, workspaceId: "workspace" })).toEqual({ handled: true, expired: true });
    expect(await current.handle({ accountId: "default", conversationId: "D2", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond, workspaceId: "workspace" })).toEqual({ handled: true, expired: true });
    now += 3_600_001;
    expect(await current.handle({ accountId: "default", conversationId: "D1", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond, workspaceId: "workspace" })).toEqual({ handled: true, expired: true });
  });

  it("rejects owned metadata supplied by the caller and oversized state", async () => {
    const current = manager(() => 1_000);
    await expect(current.prepare({ kind: "modal", view: { type: "modal", title: { type: "plain_text", text: "A" }, blocks: [], private_metadata: "forged" } }, origin, address, "U1")).rejects.toThrow(/owned/);
    await expect(current.prepare({ kind: "modal", view: { type: "modal", title: { type: "plain_text", text: "A" }, blocks: [{ type: "section", text: { type: "plain_text", text: "x".repeat(40_000) } }] } }, origin, address, "U1")).rejects.toThrow(/32KiB/);
  });

  it("acknowledges expired external-select options with an empty list", async () => {
    const current = manager(() => 1_000);
    const options = vi.fn(async () => undefined);
    expect(await current.handle({ accountId: "default", conversationId: "D1", senderId: "U1", auth: { isAuthorizedSender: true }, interaction: { kind: "options", actionId: "slack-workspace:options:expired", payload: "", query: "alp" }, respond: { options }, workspaceId: "workspace" })).toEqual({ handled: true, expired: true });
    expect(options).toHaveBeenCalledExactlyOnceWith([]);
  });

});
