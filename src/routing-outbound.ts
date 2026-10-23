import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { callSlack, resolveToken, workspaceFor, type PluginConfig, type SlackResponse } from "./client.js";
import type { ResolvedRoutingConfiguration } from "./routing-configuration.js";
import type { MessageOrigin, SlackAddress, createRoutingStorage } from "./routing-storage.js";

type Storage = ReturnType<typeof createRoutingStorage>;
type Origin = Pick<MessageOrigin, "agentId" | "sessionKey" | "sessionId">;
type PendingOrigin = Origin & SlackAddress & {
  kind: "schedule" | "file";
  reference: string;
  scheduledMessageId?: string;
  dueAt: number;
  expiresAt: number;
  excerpt: string;
};
const MARKER = "openclaw-origin:";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
const sameAddress = (first: SlackAddress, second: SlackAddress) =>
  first.accountId === second.accountId && first.workspaceId === second.workspaceId && first.channelId === second.channelId;

/** Only host-supplied identities can establish ownership of an outgoing message. */
export function toolOrigin(context: OpenClawPluginToolContext): Origin | undefined {
  const { agentId, sessionKey, sessionId } = context;
  return agentId && sessionKey && sessionId ? { agentId, sessionKey, sessionId } : undefined;
}

/** Preserve the notification text while adding a durable, opaque scheduling marker. */
function scheduledBlocks(body: Record<string, unknown>, reference: string): unknown[] {
  const blocks = Array.isArray(body.blocks) ? structuredClone(body.blocks) : [];
  if (blocks.length === 0) {
    const text = string(body.text);
    if (!text) throw new Error("A routed scheduled message requires text or blocks.");
    // A section's mrkdwn field accepts 3,000 UTF-16 units. Keep surrogate pairs whole.
    let remaining = text;
    while (remaining) {
      let length = Math.min(3000, remaining.length);
      if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1])) length--;
      blocks.push({ type: "section", text: { type: "mrkdwn", text: remaining.slice(0, length) } });
      remaining = remaining.slice(length);
    }
  }
  if (blocks.length >= 50) throw new Error("Routed scheduled messages allow at most 49 content blocks; one block records their reply origin.");
  blocks.push({ type: "context", block_id: `${MARKER}${reference}`, elements: [{ type: "plain_text", text: "Scheduled by OpenClaw" }] });
  return blocks;
}

function scheduleReference(message: Record<string, unknown>): string | undefined {
  if (!Array.isArray(message.blocks)) return undefined;
  for (const block of message.blocks) {
    const identifier = string(record(block)?.block_id);
    if (identifier?.startsWith(MARKER)) return identifier.slice(MARKER.length);
  }
  return undefined;
}

/** Capture sends at the Slack mutation boundary and recover server-scheduled/file shares. */
export function createOutboundRouting(
  api: OpenClawPluginApi,
  configuration: ResolvedRoutingConfiguration,
  storage: Storage,
  now: () => number = Date.now,
) {
  const lifetime = configuration.retention.messageDays * 86_400_000;
  const pending = api.runtime.state.openKeyedStore<PendingOrigin>({
    namespace: "slack-routing-pending",
    maxEntries: configuration.retention.maximumMessages,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: lifetime,
  });

  async function address(channelId: string, config: PluginConfig): Promise<SlackAddress> {
    const workspace = await workspaceFor(resolveToken(config));
    if (!workspace) throw new Error("Could not establish the Slack workspace for reply routing.");
    return { accountId: configuration.accountId, workspaceId: workspace.teamId, channelId };
  }

  async function prepare(context: OpenClawPluginToolContext, method: string, body: Record<string, unknown>, config: PluginConfig) {
    if (method !== "chat.scheduleMessage") return body;
    const origin = toolOrigin(context);
    if (!origin) throw new Error("Reply-routed scheduling requires a trusted originating agent/session.");
    const channelId = string(body.channel);
    const dueAt = typeof body.post_at === "number" ? body.post_at * 1000 : Number.NaN;
    if (!channelId || !Number.isFinite(dueAt)) throw new Error("Scheduled message has no valid channel or delivery time.");
    const reference = randomUUID();
    const blocks = scheduledBlocks(body, reference);
    const expiresAt = dueAt + lifetime;
    const value: PendingOrigin = { ...origin, ...await address(channelId, config), kind: "schedule", reference, dueAt, expiresAt, excerpt: String(body.text ?? "").slice(0, 1000) };
    await pending.register(reference, value, { ttlMs: Math.max(1, expiresAt - now()) });
    return { ...body, blocks };
  }

  async function save(origin: Origin, location: SlackAddress, messageTs: string, excerpt: string, threadTs?: string, createdAt = now()) {
    await storage.recordMessage({ ...origin, ...location, messageTs, excerpt, threadTs, createdAt, expiresAt: createdAt + lifetime });
  }

  async function observe(context: OpenClawPluginToolContext, method: string, body: Record<string, unknown>, response: SlackResponse, config: PluginConfig) {
    if (!["chat.postMessage", "chat.update", "chat.postEphemeral", "chat.delete", "chat.scheduleMessage", "chat.deleteScheduledMessage", "files.completeUploadExternal", "files.remote.share"].includes(method)) return;
    const channelId = string(response.channel) ?? string(body.channel) ?? string(body.channel_id);
    if (!channelId) return;
    const location = await address(channelId, config);
    if (method === "chat.delete") {
      const timestamp = string(body.ts);
      if (timestamp) await storage.deleteMessage(location, timestamp);
      return;
    }
    if (method === "chat.deleteScheduledMessage") {
      for (const entry of await pending.entries()) {
        if (sameAddress(entry.value, location) && entry.value.scheduledMessageId === body.scheduled_message_id) await pending.delete(entry.key);
      }
      return;
    }
    if (method === "chat.scheduleMessage") {
      const reference = scheduleReference(body);
      if (!reference) throw new Error("Scheduled send has no routing marker.");
      const value = await pending.lookup(reference);
      if (!value) throw new Error("Scheduled send lost its origin record.");
      await pending.register(reference, { ...value, ...location, scheduledMessageId: string(response.scheduled_message_id) }, { ttlMs: Math.max(1, value.expiresAt - now()) });
      return;
    }
    const origin = toolOrigin(context);
    if (!origin) throw new Error("Sent message has no trusted originating session.");
    const timestamp = string(response.ts) ?? string(response.message_ts) ?? string(body.ts);
    if (timestamp) {
      await save(origin, location, timestamp, String(body.text ?? body.initial_comment ?? ""), string(body.thread_ts));
      return;
    }
    const files = Array.isArray(response.files) ? response.files : [response.file];
    for (const raw of files) {
      const file = record(raw);
      const reference = string(file?.id);
      if (!reference) continue;
      const value: PendingOrigin = { ...origin, ...location, kind: "file", reference, dueAt: now(), expiresAt: now() + lifetime, excerpt: String(body.initial_comment ?? file?.title ?? "File shared by OpenClaw").slice(0, 1000) };
      await pending.register(reference, value, { ttlMs: lifetime });
    }
  }

  async function recover(location: SlackAddress, config: PluginConfig, reference?: string, signal?: AbortSignal) {
    if (location.accountId !== configuration.accountId) return;
    const values = (await pending.entries()).map((entry) => entry.value)
      .filter((value) => sameAddress(value, location) && value.dueAt <= now() && value.expiresAt > now());
    if (values.length === 0) return;
    const actual = await address(location.channelId, config);
    if (!sameAddress(actual, location)) return;
    const workspace = await workspaceFor(resolveToken(config));
    if (!workspace?.userId) throw new Error("Scheduled-message recovery requires the token's authenticated Slack user identity.");
    const result = await callSlack(reference ? "conversations.replies" : "conversations.history", resolveToken(config), {
      channel: location.channelId,
      ...(reference ? { ts: reference, limit: 1 } : { oldest: (now() - configuration.semanticReplies.windowSeconds * 1000) / 1000, limit: 100 }),
    }, { signal });
    if (!Array.isArray(result.messages)) return;
    for (const raw of result.messages) {
      const message = record(raw);
      const timestamp = string(message?.ts);
      if (!message || !timestamp) continue;
      // A readable marker is correlation, not authority: another sender can copy blocks.
      if (message.user !== workspace.userId) continue;
      const marker = scheduleReference(message);
      const fileIds = Array.isArray(message.files) ? message.files.map((file) => string(record(file)?.id)) : [];
      const value = values.find((entry) => entry.kind === "schedule" ? marker === entry.reference : fileIds.includes(entry.reference));
      if (!value) continue;
      const createdAt = Number(timestamp) * 1000;
      if (!Number.isFinite(createdAt) || createdAt < value.dueAt - 1000) continue;
      await save(value, location, timestamp, String(message.text ?? value.excerpt).slice(0, 1000), string(message.thread_ts), createdAt);
      // Keep a file origin until expiry: one file may have more than one share message.
      if (value.kind === "schedule") await pending.delete(value.reference);
    }
  }

  return { prepare, observe, recover };
}
