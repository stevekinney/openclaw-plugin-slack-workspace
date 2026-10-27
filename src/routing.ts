import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveToken, workspaceFor } from "./client.js";
import { createInteractionManager } from "./interactions.js";
import { resolveRoutingConfiguration, type SessionTarget } from "./routing-configuration.js";
import { classifyRecentReply } from "./routing-model.js";
import { createOutboundRouting, toolOrigin } from "./routing-outbound.js";
import { resolveMessageRoute, type RoutingTarget } from "./routing-resolver.js";
import { createRoutingStorage, type SlackAddress } from "./routing-storage.js";
import { resolveToolConfig, type ToolIntegrations } from "./tool.js";

/** Version-one host seam implemented by the companion OpenClaw change. */
export type InboundRouteEvent = {
  channel: string;
  accountId: string;
  workspaceId: string;
  conversationId: string;
  senderId: string;
  messageId: string;
  content: string;
  isDirect: boolean;
  replyToId?: string;
  threadId?: string;
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
  interaction?: { kind: string; messageTs?: string; actionId?: string; viewId?: string; callbackId?: string; reference?: string; privateMetadata?: string };
};
type RouteResult = { agentId: string; sessionKey: string; expectedSessionId: string; reason?: string } | { drop: { reason: string } };
type InboundRouteHost = {
  on(name: "resolve_inbound_route", handler: (event: InboundRouteEvent) => Promise<RouteResult | undefined>): void;
  runtime: {
    channel: { routing: { inboundRouteContractVersion: 1 } };
    modelConfig: { resolveUtilityModelRefForAgent(params: { cfg: OpenClawPluginApi["config"]; agentId: string }): string | undefined };
  };
};

function requireRouteHost(api: OpenClawPluginApi): asserts api is OpenClawPluginApi & InboundRouteHost {
  // The published 2026.10.6 SDK predates this explicitly versioned extension.
  const routing = api.runtime.channel.routing as object;
  const models = api.runtime.modelConfig as object;
  if (!("inboundRouteContractVersion" in routing) || routing.inboundRouteContractVersion !== 1 ||
      !("resolveUtilityModelRefForAgent" in models) || typeof models.resolveUtilityModelRefForAgent !== "function") {
    throw new Error("Slack routing requires the OpenClaw inbound route contract version 1. Install the companion OpenClaw routing change before enabling routing; a released 2026.10.6 host does not include it.");
  }
}

const targetKey = (target: SessionTarget) => createHash("sha256").update(JSON.stringify([target.agentId, target.sessionKey])).digest("hex");

/** Register policy against the host's native pre-admission and interaction pipeline. */
export function registerRouting(api: OpenClawPluginApi): ToolIntegrations | undefined {
  const configuration = resolveRoutingConfiguration(api.pluginConfig?.routing);
  if (!configuration) return undefined;
  requireRouteHost(api);
  const storage = createRoutingStorage(api.runtime.state, configuration);
  const outbound = createOutboundRouting(api, configuration, storage);
  const targets = [configuration.directMessages.defaultTarget, ...configuration.directMessages.rules.map((rule) => rule.target)]
    .filter((target): target is SessionTarget => target !== undefined);
  const currentKeys = new Set(targets.map(targetKey));
  const pins = api.runtime.state.openKeyedStore<string>({ namespace: "slack-routing-targets", maxEntries: 101, overflowPolicy: "reject-new" });
  const prunePins = async () => {
    for (const entry of await pins.entries()) if (!currentKeys.has(entry.key)) await pins.delete(entry.key);
  };
  let initializedPins: Promise<void> | undefined;

  async function resolveTarget(target: SessionTarget, expectedSessionId?: string): Promise<RoutingTarget | undefined> {
    if (target.sessionKey.startsWith("agent:") && target.sessionKey.split(":")[1] !== target.agentId) return undefined;
    const session = await getSessionEntryAsync({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: resolveStorePath(api.config.session?.store, { agentId: target.agentId }),
      readConsistency: "latest",
      hydrateSkillPromptRefs: false,
    });
    if (!session || typeof session.sessionId !== "string" || session.archivedAt !== undefined && session.archivedAt !== null) return undefined;
    if (expectedSessionId !== undefined && session.sessionId !== expectedSessionId) return undefined;
    if (expectedSessionId === undefined) {
      initializedPins ??= prunePins();
      await initializedPins;
      const key = targetKey(target);
      await pins.registerIfAbsent(key, session.sessionId);
      if (await pins.lookup(key) !== session.sessionId) return undefined;
    }
    return { ...target, sessionId: session.sessionId };
  }

  const interactions = createInteractionManager(api, configuration, resolveTarget);
  api.registerInteractiveHandler({ channel: "slack", namespace: "slack-workspace", handler: interactions.handle });
  api.on("resolve_inbound_route", async (event: InboundRouteEvent) => {
    if (event.channel !== "slack") return undefined;
    const address: SlackAddress = { accountId: event.accountId, workspaceId: event.workspaceId, channelId: event.conversationId };
    const interactionReference = [event.interaction?.actionId, event.interaction?.callbackId, event.interaction?.reference]
      .find((reference) => reference?.startsWith("slack-workspace:"));
    if (interactionReference) {
      const target = await interactions.resolveOrigin(interactionReference, address, event.senderId);
      return target ? { ...target, expectedSessionId: target.sessionId, reason: "interaction" } : { drop: { reason: "The Slack interaction expired or its originating session is no longer active." } };
    }
    const replyToTs = event.interaction?.messageTs ?? event.replyToId;
    const tokenConfig = await resolveToolConfig((api.pluginConfig ?? {}) as Parameters<typeof resolveToolConfig>[0], api.config);
    if (!replyToTs || !await storage.findMessage(address, replyToTs)) {
      await outbound.recover(address, tokenConfig, replyToTs ?? event.threadId, event.signal);
    }
    if (event.interaction?.messageTs) {
      const origin = await storage.findMessage(address, event.interaction.messageTs);
      const target = origin && await resolveTarget(origin, origin.sessionId);
      return target ? { ...target, expectedSessionId: target.sessionId, reason: "interaction" } :
        { drop: { reason: "The Slack control expired or its originating session is no longer active." } };
    }
    const result = await resolveMessageRoute({
      ...address, userId: event.senderId, messageId: event.messageId, text: event.content,
      isDirect: event.isDirect, replyToTs, threadTs: event.threadId,
    }, event.interaction ? { ...configuration, semanticReplies: { ...configuration.semanticReplies, enabled: false } } : configuration, storage, {
      resolveTarget,
      resolveDefaultWorkspaceId: async () => (await workspaceFor(resolveToken(tokenConfig), { signal: event.signal }))?.teamId,
      classify: async (candidates, message) => {
        const signal = event.signal ?? new AbortController().signal;
        const utilityModel = api.runtime.modelConfig.resolveUtilityModelRefForAgent({ cfg: api.config, agentId: event.agentId });
        try {
          return await classifyRecentReply({ agentId: event.agentId, message, candidates, signal }, {
            decision: api.runtime.decisions,
            ...(utilityModel ? { utility: async (prompt: string, cancellation: AbortSignal) => (await api.runtime.llm.complete({ agentId: event.agentId, model: utilityModel, messages: [{ role: "user", content: prompt }], maxTokens: 128, responseFormat: { type: "json_object" }, signal: cancellation, purpose: "slack.reply-routing" })).text } : {}),
            onUnavailable: (source) => api.logger.debug?.(`slack-workspace: reply classifier unavailable source=${source}`),
          });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
            api.logger.debug?.("slack-workspace: reply classifier reached its deadline; retaining normal routing");
            return undefined;
          }
          throw error;
        }
      },
    });
    api.logger.info(`slack-workspace: route reason=${result.reason}`);
    if (event.interaction && !result.target && result.reason === "inactive-origin") return { drop: { reason: "The originating session is no longer active." } };
    return result.target ? { ...result.target, expectedSessionId: result.target.sessionId, reason: result.reason } : undefined;
  });

  api.on("session_end", async (event) => {
    if (["deleted", "reset", "new"].includes(event.reason ?? "")) await storage.retireSession(event.sessionId);
  });

  api.on("message_sent", async (event, context) => {
    if (!event.success || context.channelId !== "slack") return;
    const facts = event as typeof event & { sessionId?: string; workspaceId?: string; conversationId?: string; agentId?: string; threadId?: string };
    const nativeContext = context as typeof context & { sessionId?: string; workspaceId?: string; threadId?: string };
    const sessionKey = facts.sessionKey ?? context.sessionKey;
    const agentId = facts.agentId ?? (sessionKey?.startsWith("agent:") ? sessionKey.split(":")[1] : undefined);
    const sessionId = facts.sessionId ?? nativeContext.sessionId;
    const workspaceId = facts.workspaceId ?? nativeContext.workspaceId;
    const destination = facts.conversationId ?? context.conversationId;
    const channelId = destination?.replace(/^slack:/, "").replace(/^channel:/, "");
    if (!sessionKey || !sessionId || !workspaceId || !channelId || !/^[CDG]/.test(channelId) || !agentId || !facts.messageId) {
      api.logger.debug?.("slack-workspace: native send has no complete trusted origin");
      return;
    }
    const createdAt = Date.now();
    await storage.recordMessage({
      agentId, sessionKey, sessionId,
      accountId: context.accountId ?? "default", workspaceId, channelId,
      messageTs: facts.messageId, threadTs: facts.threadId ?? nativeContext.threadId, excerpt: facts.content,
      createdAt, expiresAt: createdAt + configuration.retention.messageDays * 86_400_000,
    });
  });

  return {
    observeResponse: outbound.observe,
    prepareRequest: outbound.prepare,
    prepareInteraction: async (context, input, config) => {
      const origin = toolOrigin(context);
      const channelId = context.messageChannel === "slack" ? context.nativeChannelId : undefined;
      const userId = context.messageChannel === "slack" ? context.requesterSenderId : undefined;
      if (!origin || !channelId || !userId) throw new Error("Preparing an interaction requires an originating session and a trusted Slack sender and conversation.");
      const workspace = await workspaceFor(resolveToken(config));
      if (!workspace) throw new Error("Could not establish the Slack workspace for the interaction.");
      return interactions.prepare(input, origin, { accountId: configuration.accountId, workspaceId: workspace.teamId, channelId }, userId);
    },
  };
}
