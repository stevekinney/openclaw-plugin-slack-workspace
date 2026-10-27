import type { ResolvedRoutingConfiguration, RoutingRule, SessionTarget } from "./routing-configuration.js";
import type { MessageOrigin, SlackAddress } from "./routing-storage.js";

export type InboundRoutingMessage = SlackAddress & {
  userId: string;
  messageId: string;
  text: string;
  isDirect: boolean;
  replyToTs?: string;
  threadTs?: string;
};

export type RoutingTarget = SessionTarget & { sessionId: string };

export type RoutingResolution = {
  target?: RoutingTarget;
  reason: "reply" | "thread" | "semantic" | "direct-message-rule" | "direct-message-default" | "normal" | "inactive-origin";
};

type RoutingStorage = {
  findMessage(address: SlackAddress, messageTs: string): Promise<MessageOrigin | undefined>;
  recentMessages(address: SlackAddress): Promise<MessageOrigin[]>;
};

type RoutingServices = {
  resolveTarget(target: SessionTarget, expectedSessionId?: string): Promise<RoutingTarget | undefined>;
  resolveDefaultWorkspaceId(): Promise<string | undefined>;
  classify(candidates: MessageOrigin[], message: string): Promise<MessageOrigin | undefined>;
  now?: () => number;
};

function addressOf(message: InboundRoutingMessage): SlackAddress {
  return { accountId: message.accountId, workspaceId: message.workspaceId, channelId: message.channelId };
}

function matchesRule(rule: RoutingRule, message: InboundRoutingMessage, channelSpecific: boolean): boolean {
  return rule.accountId === message.accountId && rule.workspaceId === message.workspaceId && rule.userId === message.userId && (channelSpecific ? rule.channelId === message.channelId : rule.channelId === undefined);
}

async function resolveConfigured(
  target: SessionTarget | undefined,
  services: RoutingServices,
): Promise<RoutingTarget | undefined> {
  return target ? services.resolveTarget(target) : undefined;
}

async function resolveOrigin(
  origin: MessageOrigin | undefined,
  services: RoutingServices,
): Promise<RoutingTarget | undefined> {
  if (!origin) return undefined;
  const target = await services.resolveTarget(origin, origin.sessionId);
  return target?.sessionId === origin.sessionId ? target : undefined;
}

export async function resolveMessageRoute(
  message: InboundRoutingMessage,
  configuration: ResolvedRoutingConfiguration,
  storage: RoutingStorage,
  services: RoutingServices,
): Promise<RoutingResolution> {
  const address = addressOf(message);
  const now = services.now ?? Date.now;
  const hasExplicitOrigin = message.replyToTs !== undefined || message.threadTs !== undefined;
  let inactiveOrigin = false;

  if (message.replyToTs !== undefined) {
    const target = await resolveOrigin(await storage.findMessage(address, message.replyToTs), services);
    if (target) return { target, reason: "reply" };
    inactiveOrigin = true;
  }
  if (message.threadTs !== undefined) {
    const target = await resolveOrigin(await storage.findMessage(address, message.threadTs), services);
    if (target) return { target, reason: "thread" };
    inactiveOrigin = true;
  }

  if (!hasExplicitOrigin && configuration.semanticReplies.enabled) {
    const windowMs = configuration.semanticReplies.windowSeconds * 1000;
    const current = now();
    const candidates = (await storage.recentMessages(address))
      .filter((origin) => origin.accountId === address.accountId && origin.workspaceId === address.workspaceId && origin.channelId === address.channelId)
      .filter((origin) => origin.createdAt <= current && current - origin.createdAt <= windowMs && origin.expiresAt > current)
      .filter((origin, index, all) => all.findIndex((candidate) => candidate.sessionId === origin.sessionId) === index);
    const authorized: MessageOrigin[] = [];
    for (const candidate of candidates) {
      if (await resolveOrigin(candidate, services)) authorized.push(candidate);
    }
    if (authorized.length > 0) {
      const selected = await services.classify(authorized, message.text);
      const chosen = selected && authorized.find((candidate) => candidate.sessionId === selected.sessionId && candidate.messageTs === selected.messageTs && candidate.accountId === selected.accountId && candidate.workspaceId === selected.workspaceId && candidate.channelId === selected.channelId);
      if (chosen) {
        const target = await resolveOrigin(chosen, services);
        if (target) return { target, reason: "semantic" };
      }
    }
  }

  if (message.isDirect) {
    const rules = configuration.directMessages.rules;
    const channelRule = rules.find((rule) => matchesRule(rule, message, true));
    if (channelRule) {
      const target = await resolveConfigured(channelRule.target, services);
      if (target) return { target, reason: "direct-message-rule" };
    }
    const userRule = rules.find((rule) => matchesRule(rule, message, false));
    if (userRule) {
      const target = await resolveConfigured(userRule.target, services);
      if (target) return { target, reason: "direct-message-rule" };
    }
    if (configuration.directMessages.defaultTarget && message.accountId === configuration.accountId &&
        message.workspaceId === await services.resolveDefaultWorkspaceId()) {
      const target = await resolveConfigured(configuration.directMessages.defaultTarget, services);
      if (target) return { target, reason: "direct-message-default" };
    }
  }

  return { reason: inactiveOrigin ? "inactive-origin" : "normal" };
}
