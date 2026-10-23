import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createHash } from "node:crypto";
import type { ResolvedRoutingConfiguration } from "./routing-configuration.js";

export type SlackAddress = { accountId: string; workspaceId: string; channelId: string };
export type MessageOrigin = SlackAddress & {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  messageTs: string;
  threadTs?: string;
  createdAt: number;
  expiresAt: number;
  excerpt: string;
};

type MessageStoreValue = MessageOrigin;
type ReplayStoreValue = { claimedAt: number };
type RuntimeState = OpenClawPluginApi["runtime"]["state"];

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EXCERPT_LENGTH = 1000;

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) throw new Error(`${name} must be a non-empty string of at most 256 characters`);
  return value;
}
function timestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}
function excerptValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("excerpt must be a string");
  return value.slice(0, MAX_EXCERPT_LENGTH);
}
function addressValue(value: SlackAddress): SlackAddress {
  return { accountId: identifier(value.accountId, "accountId"), workspaceId: identifier(value.workspaceId, "workspaceId"), channelId: identifier(value.channelId, "channelId") };
}
function addressKey(address: SlackAddress): string {
  const value = addressValue(address);
  return createHash("sha256").update(JSON.stringify([value.accountId, value.workspaceId, value.channelId])).digest("hex");
}
function messageKey(address: SlackAddress, messageTs: string): string {
  return `${addressKey(address)}:${identifier(messageTs, "messageTs")}`;
}
function sameAddress(a: SlackAddress, b: SlackAddress): boolean {
  return a.accountId === b.accountId && a.workspaceId === b.workspaceId && a.channelId === b.channelId;
}

export function createRoutingStorage(
  state: RuntimeState,
  configuration: ResolvedRoutingConfiguration,
  now: () => number = Date.now,
) {
  const messages = state.openKeyedStore<MessageStoreValue>({
    namespace: "slack-routing-messages",
    maxEntries: configuration.retention.maximumMessages,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: configuration.retention.messageDays * 86_400_000,
  });
  const replay = state.openKeyedStore<ReplayStoreValue>({
    namespace: "slack-routing-replay",
    maxEntries: configuration.retention.maximumInteractions,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: configuration.retention.interactionHours * 3_600_000,
  });
  const messageLifetime = configuration.retention.messageDays * 86_400_000;
  const replayLifetime = configuration.retention.interactionHours * 3_600_000;

  async function recordMessage(input: MessageOrigin): Promise<MessageOrigin> {
    const address = addressValue(input);
    const messageTs = identifier(input.messageTs, "messageTs");
    const origin = {
      ...address,
      agentId: identifier(input.agentId, "agentId"),
      sessionKey: identifier(input.sessionKey, "sessionKey"),
      sessionId: identifier(input.sessionId, "sessionId"),
      messageTs,
      ...(input.threadTs === undefined ? {} : { threadTs: identifier(input.threadTs, "threadTs") }),
      createdAt: timestamp(input.createdAt, "createdAt"),
      expiresAt: timestamp(input.expiresAt, "expiresAt"),
      excerpt: excerptValue(input.excerpt),
    } satisfies MessageOrigin;
    const key = messageKey(address, messageTs);
    const existing = await messages.lookup(key);
    if (existing && existing.expiresAt > now()) {
      origin.agentId = existing.agentId;
      origin.sessionKey = existing.sessionKey;
      origin.sessionId = existing.sessionId;
      origin.createdAt = existing.createdAt;
      origin.expiresAt = existing.expiresAt;
    } else {
      origin.expiresAt = Math.min(origin.expiresAt, now() + messageLifetime);
    }
    const ttlMs = Math.max(1, origin.expiresAt - now());
    if (!existing || existing.expiresAt <= now()) {
      const inserted = await messages.registerIfAbsent(key, origin, { ttlMs });
      if (inserted) return origin;
      const raced = await messages.lookup(key);
      if (raced && raced.expiresAt > now()) {
        origin.agentId = raced.agentId;
        origin.sessionKey = raced.sessionKey;
        origin.sessionId = raced.sessionId;
        origin.createdAt = raced.createdAt;
        origin.expiresAt = raced.expiresAt;
      }
    }
    await messages.register(key, origin, { ttlMs: Math.max(1, origin.expiresAt - now()) });
    return origin;
  }

  async function findMessage(address: SlackAddress, messageTs: string): Promise<MessageOrigin | undefined> {
    const value = await messages.lookup(messageKey(address, messageTs));
    return value && value.expiresAt > now() && sameAddress(value, addressValue(address)) ? value : undefined;
  }

  async function recentMessages(address: SlackAddress): Promise<MessageOrigin[]> {
    const values = (await messages.entries())
      .map((entry) => entry.value)
      .filter((value) => value.expiresAt > now() && sameAddress(value, addressValue(address)))
      .sort((a, b) => b.createdAt - a.createdAt);
    const unique = values.filter((value, index, all) => all.findIndex((candidate) => candidate.sessionId === value.sessionId) === index);
    return unique.slice(0, configuration.semanticReplies.maximumCandidates);
  }

  async function deleteMessage(address: SlackAddress, messageTs: string): Promise<boolean> {
    return messages.delete(messageKey(address, messageTs));
  }

  async function retireSession(sessionId: string): Promise<number> {
    const wanted = identifier(sessionId, "sessionId");
    let removed = 0;
    for (const entry of await messages.entries()) {
      if (entry.value.sessionId === wanted && (await messages.delete(entry.key))) removed++;
    }
    return removed;
  }

  async function claimInteraction(address: SlackAddress, interactionId: string): Promise<boolean> {
    const key = `${addressKey(address)}:${identifier(interactionId, "interactionId")}`;
    return replay.registerIfAbsent(key, { claimedAt: timestamp(now(), "now") }, { ttlMs: replayLifetime });
  }

  return { recordMessage, findMessage, recentMessages, deleteMessage, retireSession, claimInteraction };
}
