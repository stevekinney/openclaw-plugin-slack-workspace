import { describe, expect, it } from "vitest";
import { createRoutingStorage, type MessageOrigin } from "./routing-storage.js";
import { resolveRoutingConfiguration } from "./routing-configuration.js";

type Entry<T> = { key: string; value: T; createdAt: number; expiresAt?: number };
function fakeState(clock: () => number = Date.now) {
  const namespaces = new Map<string, Map<string, { value: unknown; expiresAt: number; sequence: number }>>();
  let sequence = 0;
  const state = {
    openKeyedStore<T>({ namespace, maxEntries, defaultTtlMs }: { namespace: string; maxEntries: number; defaultTtlMs?: number }) {
      const rows = namespaces.get(namespace) ?? new Map();
      namespaces.set(namespace, rows);
      const sweep = () => { const now = clock(); for (const [key, row] of rows) if (row.expiresAt <= now) rows.delete(key); };
      const entries = async (): Promise<Entry<T>[]> => { sweep(); return [...rows].map(([key, row]) => ({ key, value: row.value as T, createdAt: row.sequence, expiresAt: row.expiresAt })); };
      return {
        async register(key: string, value: T, opts?: { ttlMs?: number }) { sweep(); rows.set(key, { value, expiresAt: clock() + (opts?.ttlMs ?? defaultTtlMs ?? 0), sequence: ++sequence }); while (rows.size > maxEntries) rows.delete(rows.keys().next().value!); },
        async registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }) { sweep(); if (rows.has(key)) return false; rows.set(key, { value, expiresAt: clock() + (opts?.ttlMs ?? defaultTtlMs ?? 0), sequence: ++sequence }); while (rows.size > maxEntries) rows.delete(rows.keys().next().value!); return true; },
        async lookup(key: string) { sweep(); return rows.get(key)?.value as T | undefined; },
        async delete(key: string) { sweep(); return rows.delete(key); },
        async entries() { return entries(); },
        async consume(key: string) { const value = await this.lookup(key); await this.delete(key); return value; },
        async clear() { rows.clear(); },
      };
    },
  } as any;
  return state;
}
const configuration = resolveRoutingConfiguration({ enabled: true, retention: { messageDays: 1, maximumMessages: 2, interactionHours: 1, maximumInteractions: 2 } })!;
const origin = (overrides: Partial<MessageOrigin> = {}): MessageOrigin => ({ accountId: "a", workspaceId: "w", channelId: "D1", agentId: "agent", sessionKey: "agent:agent:main", sessionId: "session-1", messageTs: "1", createdAt: 1000, expiresAt: 86_400_000, excerpt: "hello", ...overrides });

describe("routing storage", () => {
  it("keeps the first owner when a message is edited", async () => {
    let clock = 1000;
    const storage = createRoutingStorage(fakeState(() => clock), configuration, () => clock);
    await storage.recordMessage(origin());
    const updated = await storage.recordMessage(origin({ agentId: "other", sessionKey: "agent:other:main", sessionId: "session-2", excerpt: "edited" }));
    expect(updated.sessionId).toBe("session-1");
    expect(updated.excerpt).toBe("edited");
    clock++;
  });

  it("isolates addresses, expires records, and atomically claims replay IDs", async () => {
    let clock = 1000;
    const storage = createRoutingStorage(fakeState(() => clock), configuration, () => clock);
    await storage.recordMessage(origin());
    expect(await storage.findMessage({ accountId: "a", workspaceId: "w", channelId: "D2" }, "1")).toBeUndefined();
    expect(await storage.recentMessages({ accountId: "a", workspaceId: "w", channelId: "D1" })).toHaveLength(1);
    expect(await Promise.all([storage.claimInteraction({ accountId: "a", workspaceId: "w", channelId: "D1" }, "i"), storage.claimInteraction({ accountId: "a", workspaceId: "w", channelId: "D1" }, "i")])).toEqual([true, false]);
    clock = 86_400_001;
    expect(await storage.findMessage({ accountId: "a", workspaceId: "w", channelId: "D1" }, "1")).toBeUndefined();
  });

  it("evicts oldest entries and retires a session", async () => {
    const storage = createRoutingStorage(fakeState(() => 1000), configuration, () => 1000);
    await storage.recordMessage(origin({ messageTs: "1", createdAt: 1 }));
    await storage.recordMessage(origin({ messageTs: "2", createdAt: 2 }));
    await storage.recordMessage(origin({ messageTs: "3", createdAt: 3, sessionId: "session-2" }));
    expect(await storage.findMessage({ accountId: "a", workspaceId: "w", channelId: "D1" }, "1")).toBeUndefined();
    expect(await storage.retireSession("session-2")).toBe(1);
  });
});
