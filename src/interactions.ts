import { createHash, randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedRoutingConfiguration, SessionTarget } from "./routing-configuration.js";
import type { RoutingTarget } from "./routing-resolver.js";
import type { SlackAddress } from "./routing-storage.js";

export type InteractionOrigin = RoutingTarget;
export type InteractionAddress = SlackAddress;
export type InteractionPreparation = {
  kind: "modal" | "options";
  channelId?: string;
  userId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  view?: Record<string, unknown>;
  options?: Array<{ text: { type: "plain_text"; text: string }; value: string }>;
};
export type PreparedInteraction = { actionId: string; reference: string; expiresAt: number };
type StoredInteraction = {
  kind: InteractionPreparation["kind"];
  origin: InteractionOrigin;
  address: InteractionAddress;
  userId: string;
  view?: Record<string, unknown>;
  options?: Array<{ text: { type: "plain_text"; text: string }; value: string }>;
  expiresAt: number;
  channelType: "im" | "mpim" | "channel" | "group";
};
type InteractiveContext = {
  accountId: string;
  conversationId: string;
  senderId?: string;
  workspaceId?: string;
  teamId?: string;
  auth: { isAuthorizedSender: boolean };
  interaction: {
    kind: "button" | "select" | "options" | "view_submission" | "view_closed";
    payload: string;
    actionId?: string;
    callbackId?: string;
    query?: string;
    value?: string;
    triggerId?: string;
    data?: string;
  };
  respond?: {
    openModal?: (view: Record<string, unknown>) => Promise<unknown>;
    options?: (options: Array<{ text: { type: "plain_text"; text: string }; value: string }>) => Promise<void>;
    acknowledge?: (payload?: unknown) => Promise<void>;
    reply?: (params: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<void>;
  };
};
type InteractionStore = {
  register(key: string, value: StoredInteraction, options?: { ttlMs?: number }): Promise<void>;
  registerIfAbsent(key: string, value: StoredInteraction, options?: { ttlMs?: number }): Promise<boolean>;
  lookup(key: string): Promise<StoredInteraction | undefined>;
  delete(key: string): Promise<boolean>;
};

const MAX_VALUE_BYTES = 32 * 1024;
const MAX_OPTION_LABEL_LENGTH = 75;
const MAX_OPTION_VALUE_LENGTH = 150;
const MAX_QUERY_LENGTH = 256;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const boundedId = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`${name} must be a non-empty string of at most 256 characters`);
  return value;
};
const sameAddress = (a: SlackAddress, b: SlackAddress) => a.accountId === b.accountId && a.workspaceId === b.workspaceId && a.channelId === b.channelId;
const replayKey = (key: string) => `replay:${createHash("sha256").update(key).digest("hex")}`;

function extractReference(context: InteractiveContext): string | undefined {
  const interaction = context.interaction;
  const direct = interaction.actionId ?? interaction.callbackId;
  if (typeof direct === "string" && direct.startsWith("slack-workspace:")) return direct;
  if (interaction.payload.startsWith("slack-workspace:")) return interaction.payload;
  if (/^(?:modal|options):[0-9a-f-]{36}$/i.test(interaction.payload)) return `slack-workspace:${interaction.payload}`;
  try {
    const payload = JSON.parse(interaction.payload) as Record<string, unknown>;
    const metadata = payload.private_metadata;
    if (typeof metadata === "string") {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      const data = parsed.pluginInteractiveData;
      return typeof data === "string" && data.startsWith("slack-workspace:") ? data : undefined;
    }
  } catch { /* malformed provider payloads are handled as unsupported callbacks */ }
  return undefined;
}

function addressFromContext(context: InteractiveContext): SlackAddress | undefined {
  const workspaceId = context.workspaceId ?? context.teamId;
  return context.accountId && workspaceId && context.conversationId ? { accountId: context.accountId, workspaceId, channelId: context.conversationId } : undefined;
}
function inferredChannelType(channelId: string): StoredInteraction["channelType"] {
  return channelId.startsWith("D") ? "im" : channelId.startsWith("G") ? "group" : "channel";
}

function isInteractiveContext(value: unknown): value is InteractiveContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const interaction = candidate.interaction;
  if (!candidate.accountId || typeof candidate.accountId !== "string" || !candidate.conversationId || typeof candidate.conversationId !== "string" || !candidate.auth || typeof candidate.auth !== "object" || typeof (candidate.auth as Record<string, unknown>).isAuthorizedSender !== "boolean" || !interaction || typeof interaction !== "object") return false;
  const action = interaction as Record<string, unknown>;
  return ["button", "select", "options", "view_submission", "view_closed"].includes(String(action.kind)) && typeof action.payload === "string";
}

export function createInteractionManager(
  api: Pick<OpenClawPluginApi, "runtime">,
  configuration: ResolvedRoutingConfiguration,
  resolveTarget: (target: SessionTarget, expectedSessionId?: string) => Promise<RoutingTarget | undefined>,
) {
  const store = api.runtime.state.openKeyedStore<StoredInteraction>({
    namespace: "slack-routing-interactions",
    maxEntries: configuration.retention.maximumInteractions,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: configuration.retention.interactionHours * 3_600_000,
  }) as InteractionStore;
  const lifetime = configuration.retention.interactionHours * 3_600_000;
  const replay = api.runtime.state.openKeyedStore<{ claimedAt: number }>({
    namespace: "slack-routing-interaction-replay",
    maxEntries: configuration.retention.maximumInteractions * 2,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: lifetime,
  });
  const now = () => Date.now();

  async function prepare(params: InteractionPreparation, origin: InteractionOrigin, address: InteractionAddress, requesterId: string): Promise<PreparedInteraction> {
    if (!configuration.enabled) throw new Error("Slack routing is disabled");
    const userId = boundedId(params.userId ?? requesterId, "userId");
    if (userId !== requesterId) throw new Error("userId must match the trusted requester");
    const channelId = params.channelId ?? address.channelId;
    if (channelId !== address.channelId) throw new Error("channelId must match the trusted conversation");
    const reference = `slack-workspace:${params.kind}:${randomUUID()}`;
    const stored: StoredInteraction = { kind: params.kind, origin, address: { ...address, channelId }, userId, channelType: params.channelType ?? inferredChannelType(channelId), expiresAt: now() + lifetime };
    if (params.kind === "modal") {
      if (params.options !== undefined) throw new Error("options are only valid for an options interaction");
      if (!params.view || typeof params.view !== "object" || Array.isArray(params.view)) throw new Error("modal view is required");
      if (Object.hasOwn(params.view, "private_metadata") || Object.hasOwn(params.view, "callback_id")) throw new Error("private_metadata and callback_id are owned by the interaction manager");
      const view = structuredClone(params.view);
      const title = view.title as Record<string, unknown> | undefined;
      if (title?.type !== "plain_text" || typeof title.text !== "string" || title.text.length > 24) throw new Error("modal title is required and must be plain_text of at most 24 characters");
      for (const name of ["submit", "close"] as const) {
        const label = view[name] as Record<string, unknown> | undefined;
        if (label !== undefined && (label.type !== "plain_text" || typeof label.text !== "string" || label.text.length > 24)) throw new Error(`modal ${name} must be plain_text of at most 24 characters`);
      }
      if (!Array.isArray(view.blocks) || view.blocks.length > 100) throw new Error("modal blocks must be an array of at most 100 items");
      if (bytes(view) > MAX_VALUE_BYTES) throw new Error("modal view exceeds 32KiB");
      view.private_metadata = JSON.stringify({ pluginInteractiveData: reference, userId, channelId, channelType: stored.channelType });
      view.callback_id = reference;
      stored.view = view;
    } else {
      if (params.view !== undefined) throw new Error("view is only valid for a modal interaction");
      if (!params.options || params.options.length === 0 || params.options.length > 100) throw new Error("options must contain between 1 and 100 items");
      stored.options = params.options.map((option) => {
        if (option.text?.type !== "plain_text" || typeof option.text.text !== "string" || option.text.text.length > MAX_OPTION_LABEL_LENGTH || typeof option.value !== "string" || option.value.length === 0 || option.value.length > MAX_OPTION_VALUE_LENGTH) throw new Error("invalid interaction option");
        return { text: { type: "plain_text", text: option.text.text }, value: option.value };
      });
    }
    if (bytes(stored) > MAX_VALUE_BYTES) throw new Error("interaction state exceeds 32KiB");
    await store.register(reference, stored, { ttlMs: lifetime });
    return { actionId: reference, reference, expiresAt: stored.expiresAt };
  }

  async function resolveOrigin(reference: string, address: InteractionAddress, senderId: string): Promise<InteractionOrigin | undefined> {
    const record = await store.lookup(reference);
    if (!record || record.expiresAt <= now() || record.userId !== senderId || !sameAddress(record.address, address)) return undefined;
    const target = await resolveTarget(record.origin, record.origin.sessionId);
    return target?.sessionId === record.origin.sessionId ? target : undefined;
  }

  async function handle(rawContext: unknown): Promise<Record<string, unknown>> {
    if (!isInteractiveContext(rawContext)) return { handled: false };
    const context = rawContext;
    const reference = extractReference(context);
    if (!reference) return { handled: false };
    const senderId = context.senderId;
    const expired = async () => {
      if (context.interaction.kind === "options") await context.respond?.options?.([]);
      await context.respond?.reply?.({ text: "This Slack interaction has expired or is no longer authorized.", responseType: "ephemeral" });
      return { handled: true, expired: true };
    };
    if (!senderId || !context.auth.isAuthorizedSender) return expired();
    const record = await store.lookup(reference);
    const address = addressFromContext(context);
    if (!record || !address || record.expiresAt <= now() || record.userId !== senderId || !sameAddress(record.address, address)) return expired();
    const target = await resolveTarget(record.origin, record.origin.sessionId);
    if (!target || target.sessionId !== record.origin.sessionId) return expired();
    const respond = context.respond;
    if (context.interaction.kind === "button" && record.kind === "modal" && respond?.openModal && record.view) {
      const claimed = await replay.registerIfAbsent(replayKey(`${reference}:open`), { claimedAt: now() }, { ttlMs: lifetime });
      if (!claimed) return { handled: true };
      try { await respond.openModal(record.view); } catch (error) { await replay.delete(replayKey(`${reference}:open`)); throw error; }
      return { handled: true };
    }
    if (context.interaction.kind === "select") return { handled: false, systemEvent: { reference, data: { reference } } };
    if (context.interaction.kind === "view_submission" || context.interaction.kind === "view_closed") {
      if (context.interaction.kind === "view_closed") return { handled: true };
      if (context.interaction.kind === "view_submission") {
        const claimed = await replay.registerIfAbsent(replayKey(`${reference}:submit`), { claimedAt: now() }, { ttlMs: lifetime });
        if (!claimed) return { handled: true };
        try { await respond?.acknowledge?.(); } catch (error) { await replay.delete(replayKey(`${reference}:submit`)); throw error; }
        return { handled: false, systemEvent: { reference, data: { reference } } };
      }
    }
    if (context.interaction.kind === "button" && record.kind === "options") {
      throw new Error("Options interactions require an options callback");
    }
    if (context.interaction.kind === "options" && record.kind === "options" && respond?.options && record.options) {
      const query = (context.interaction.query ?? "").slice(0, MAX_QUERY_LENGTH).toLowerCase();
      await respond.options(record.options.filter((option) => option.text.text.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)).slice(0, 100));
      return { handled: true };
    }
    throw new Error("Unsupported Slack interaction callback");
  }

  return { prepare, handle, resolveOrigin };
}
