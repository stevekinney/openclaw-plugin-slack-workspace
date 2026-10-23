export type SessionTarget = { agentId: string; sessionKey: string };

export type RoutingRule = {
  accountId: string;
  workspaceId: string;
  userId: string;
  channelId?: string;
  target: SessionTarget;
};

export type RoutingConfigurationInput = {
  enabled?: boolean;
  accountId?: string;
  directMessages?: { defaultTarget?: SessionTarget; rules?: RoutingRule[] };
  semanticReplies?: {
    enabled?: boolean;
    windowSeconds?: number;
    maximumCandidates?: number;
  };
  retention?: {
    messageDays?: number;
    maximumMessages?: number;
    interactionHours?: number;
    maximumInteractions?: number;
  };
};

export type ResolvedRoutingConfiguration = {
  enabled: true;
  accountId: string;
  directMessages: { defaultTarget?: SessionTarget; rules: RoutingRule[] };
  semanticReplies: { enabled: boolean; windowSeconds: number; maximumCandidates: number };
  retention: {
    messageDays: number;
    maximumMessages: number;
    interactionHours: number;
    maximumInteractions: number;
  };
};

const LIMITS = {
  windowSeconds: [1, 86_400],
  maximumCandidates: [1, 63],
  messageDays: [1, 365],
  maximumMessages: [1, 10_000],
  interactionHours: [1, 168],
  maximumInteractions: [1, 2_000],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown routing configuration field: ${path}.${key}`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${path} must be a non-empty string of at most 256 characters`);
  }
  return value;
}

function targetValue(value: unknown, path: string): SessionTarget {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertKeys(value, ["agentId", "sessionKey"], path);
  const target = { agentId: stringValue(value.agentId, `${path}.agentId`), sessionKey: stringValue(value.sessionKey, `${path}.sessionKey`) };
  // Qualified keys carry their owner in the key. Bare keys such as "global" are
  // intentionally allowed because the host resolves their owner separately.
  const parts = target.sessionKey.split(":");
  if (parts[0] === "agent" && parts.length >= 2 && parts[1] !== target.agentId) {
    throw new Error(`${path}.sessionKey does not belong to ${path}.agentId`);
  }
  return target;
}

function boundedNumber(value: unknown, path: string, range: readonly [number, number]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < range[0] || value > range[1]) {
    throw new Error(`${path} must be an integer between ${range[0]} and ${range[1]}`);
  }
  return value;
}

export function resolveRoutingConfiguration(raw: unknown): ResolvedRoutingConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("routing must be an object");
  assertKeys(raw, ["enabled", "accountId", "directMessages", "semanticReplies", "retention"], "routing");
  if (raw.enabled !== undefined && raw.enabled !== true && raw.enabled !== false) throw new Error("routing.enabled must be a boolean");
  if (raw.enabled !== true) return undefined;
  const accountId = raw.accountId === undefined ? "default" : stringValue(raw.accountId, "routing.accountId");

  let directMessages: ResolvedRoutingConfiguration["directMessages"] = { rules: [] };
  if (raw.directMessages !== undefined) {
    if (!isRecord(raw.directMessages)) throw new Error("routing.directMessages must be an object");
    assertKeys(raw.directMessages, ["defaultTarget", "rules"], "routing.directMessages");
    const defaultTarget = raw.directMessages.defaultTarget === undefined ? undefined : targetValue(raw.directMessages.defaultTarget, "routing.directMessages.defaultTarget");
    const inputRules = raw.directMessages.rules === undefined ? [] : raw.directMessages.rules;
    if (!Array.isArray(inputRules) || inputRules.length > 100) throw new Error("routing.directMessages.rules must contain at most 100 rules");
    const rules = inputRules.map((entry, index) => {
      const path = `routing.directMessages.rules[${index}]`;
      if (!isRecord(entry)) throw new Error(`${path} must be an object`);
      assertKeys(entry, ["accountId", "workspaceId", "userId", "channelId", "target"], path);
      const rule: RoutingRule = {
        accountId: stringValue(entry.accountId, `${path}.accountId`),
        workspaceId: stringValue(entry.workspaceId, `${path}.workspaceId`),
        userId: stringValue(entry.userId, `${path}.userId`),
        target: targetValue(entry.target, `${path}.target`),
      };
      if (entry.channelId !== undefined) rule.channelId = stringValue(entry.channelId, `${path}.channelId`);
      return rule;
    });
    const seen = new Set<string>();
    for (const rule of rules) {
      const key = JSON.stringify([rule.accountId, rule.workspaceId, rule.userId, rule.channelId ?? null]);
      if (seen.has(key)) throw new Error("Duplicate equally specific routing rule");
      seen.add(key);
    }
    directMessages = { defaultTarget, rules };
  }

  const semanticInput = isRecord(raw.semanticReplies) ? raw.semanticReplies : raw.semanticReplies === undefined ? {} : undefined;
  if (!semanticInput) throw new Error("routing.semanticReplies must be an object");
  assertKeys(semanticInput, ["enabled", "windowSeconds", "maximumCandidates"], "routing.semanticReplies");
  if (semanticInput.enabled !== undefined && typeof semanticInput.enabled !== "boolean") throw new Error("routing.semanticReplies.enabled must be a boolean");
  const retentionInput = isRecord(raw.retention) ? raw.retention : raw.retention === undefined ? {} : undefined;
  if (!retentionInput) throw new Error("routing.retention must be an object");
  assertKeys(retentionInput, ["messageDays", "maximumMessages", "interactionHours", "maximumInteractions"], "routing.retention");
  return {
    enabled: true,
    accountId,
    directMessages,
    semanticReplies: {
      enabled: semanticInput.enabled === undefined ? true : semanticInput.enabled,
      windowSeconds: semanticInput.windowSeconds === undefined ? 900 : boundedNumber(semanticInput.windowSeconds, "routing.semanticReplies.windowSeconds", LIMITS.windowSeconds),
      maximumCandidates: semanticInput.maximumCandidates === undefined ? 5 : boundedNumber(semanticInput.maximumCandidates, "routing.semanticReplies.maximumCandidates", LIMITS.maximumCandidates),
    },
    retention: {
      messageDays: retentionInput.messageDays === undefined ? 30 : boundedNumber(retentionInput.messageDays, "routing.retention.messageDays", LIMITS.messageDays),
      maximumMessages: retentionInput.maximumMessages === undefined ? 10_000 : boundedNumber(retentionInput.maximumMessages, "routing.retention.maximumMessages", LIMITS.maximumMessages),
      interactionHours: retentionInput.interactionHours === undefined ? 24 : boundedNumber(retentionInput.interactionHours, "routing.retention.interactionHours", LIMITS.interactionHours),
      maximumInteractions: retentionInput.maximumInteractions === undefined ? 2_000 : boundedNumber(retentionInput.maximumInteractions, "routing.retention.maximumInteractions", LIMITS.maximumInteractions),
    },
  };
}
