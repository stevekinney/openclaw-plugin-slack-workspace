import { Type } from "typebox";
import { callSlack, resolveToken, type SlackCallContext } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";

/**
 * The app holds only the public-channel scopes (`channels:manage`,
 * `channels:write.topic`, `channels:write.invites`); their private-channel twins
 * (`groups:write*`) are deliberately not granted. Every tool here names the missing
 * scope up front instead of letting Slack answer with a bare `missing_scope`.
 */
type PrivateScope = "groups:write" | "groups:write.topic" | "groups:write.invites";

const privateChannelError = (channel: string, scope: PrivateScope) =>
  new Error(
    `${channel} is a private channel. This plugin only manages public channels: acting on private channels needs the \`${scope}\` scope, which this Slack app is not granted.`,
  );

/** Slack's own rejection when the call reached a private channel anyway. */
const isPrivateScopeError = (error: unknown) =>
  error instanceof Error && /missing_scope \(needs scope: groups:/.test(error.message);

/**
 * Look the channel up with `conversations.info` and refuse private ones before the
 * mutating call. A private channel the bot can't read also surfaces as a `groups:*`
 * `missing_scope`, which gets the same explicit error.
 */
async function requirePublicChannel(
  channelId: string,
  token: string,
  scope: PrivateScope,
  context: SlackCallContext,
): Promise<void> {
  let channel: Record<string, unknown>;
  try {
    const data = await callSlack("conversations.info", token, { channel: channelId }, context, true);
    channel = (data.channel ?? {}) as Record<string, unknown>;
  } catch (error) {
    if (isPrivateScopeError(error)) throw privateChannelError(`Channel ${channelId}`, scope);
    throw error;
  }
  if (channel.is_private === true) throw privateChannelError(`Channel ${channelId}`, scope);
}

/** Run a mutating call, translating a `groups:*` `missing_scope` into the explicit error. */
async function publicOnly<T>(channelId: string, scope: PrivateScope, call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (isPrivateScopeError(error)) throw privateChannelError(`Channel ${channelId}`, scope);
    throw error;
  }
}

/** Refuse archive/rename unless the caller passed `confirm: true` explicitly. */
function requireConfirm(confirm: unknown, action: string): void {
  if (confirm !== true) {
    throw new Error(
      `Refusing to ${action} without \`confirm: true\`. Pass it explicitly once the change is intended.`,
    );
  }
}

/** Curated channel (see "Output shaping" in schemas.ts): Slack's carries ~30 fields. */
const slackChannel = Type.Object(
  { id: Type.String(), name: Type.String() },
  { additionalProperties: false },
);

const curateChannel = (raw: unknown, fallbackId = "") => {
  const channel = (raw ?? {}) as Record<string, unknown>;
  return { id: String(channel.id ?? fallbackId), name: String(channel.name ?? "") };
};

const publicChannelIdParam = () =>
  channelIdParam("Public channels only; private channels are refused.");

const channelNameParam = (description: string) =>
  Type.String({ minLength: 1, maxLength: 80, description });

const confirmParam = (action: string) =>
  Type.Literal(true, {
    description: `Must be exactly true to ${action}. There is no default: omitting it rejects the call before Slack is contacted.`,
  });

export const channelTools = (tool: ToolFactory) => [
  tool({
    name: "slack_channel_create",
    label: "Create Slack channel",
    description:
      "Create a public Slack channel. Private channels are not supported: they need the `groups:write` scope, which this app is not granted.",
    parameters: Type.Object({
      name: channelNameParam(
        "Channel name: lowercase letters, numbers, hyphens, and underscores; at most 80 characters.",
      ),
      isPrivate: Type.Optional(
        Type.Boolean({
          description: "Must be false or omitted; private channels need `groups:write`.",
        }),
      ),
    }),
    outputSchema: Type.Object({ channel: slackChannel }, { additionalProperties: false }),
    async execute({ name, isPrivate }, config, context) {
      context.signal?.throwIfAborted();
      if (isPrivate) throw privateChannelError(`Channel "${name}"`, "groups:write");
      const token = resolveToken(config);
      const data = await callSlack(
        "conversations.create",
        token,
        { name, is_private: false },
        context,
      );
      return { channel: curateChannel(data.channel) };
    },
  }),

  tool({
    name: "slack_channel_archive",
    label: "Archive Slack channel",
    description:
      "Archive a public Slack channel. Disruptive: members lose the channel from their sidebar. Requires `confirm: true` and a human's approval. Private channels are refused (they need `groups:write`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
      confirm: confirmParam("archive the channel"),
    }),
    outputSchema: Type.Object(
      { archived: Type.Literal(true), channelId: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, confirm }, config, context) {
      context.signal?.throwIfAborted();
      requireConfirm(confirm, `archive channel ${channelId}`);
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write", context);
      await publicOnly(channelId, "groups:write", () =>
        callSlack("conversations.archive", token, { channel: channelId }, context),
      );
      return { archived: true, channelId };
    },
  }),

  tool({
    name: "slack_channel_rename",
    label: "Rename Slack channel",
    description:
      "Rename a public Slack channel. Disruptive: links and habits built on the old name break. Requires `confirm: true` and a human's approval. Private channels are refused (they need `groups:write`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
      name: channelNameParam("New channel name, following Slack's naming rules; at most 80 characters."),
      confirm: confirmParam("rename the channel"),
    }),
    outputSchema: Type.Object({ channel: slackChannel }, { additionalProperties: false }),
    async execute({ channelId, name, confirm }, config, context) {
      context.signal?.throwIfAborted();
      requireConfirm(confirm, `rename channel ${channelId}`);
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write", context);
      const data = await publicOnly(channelId, "groups:write", () =>
        callSlack("conversations.rename", token, { channel: channelId, name }, context),
      );
      return { channel: curateChannel(data.channel, channelId) };
    },
  }),

  tool({
    name: "slack_channel_set_topic",
    label: "Set Slack channel topic",
    description:
      "Set a public Slack channel's topic. Private channels are refused (they need `groups:write.topic`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
      topic: Type.String({ maxLength: 250, description: "New topic; at most 250 characters." }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), topic: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, topic }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write.topic", context);
      await publicOnly(channelId, "groups:write.topic", () =>
        callSlack("conversations.setTopic", token, { channel: channelId, topic }, context),
      );
      return { channelId, topic };
    },
  }),

  tool({
    name: "slack_channel_set_purpose",
    label: "Set Slack channel purpose",
    description:
      "Set a public Slack channel's purpose (its description). Private channels are refused (they need `groups:write`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
      purpose: Type.String({ maxLength: 250, description: "New purpose; at most 250 characters." }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), purpose: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, purpose }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write", context);
      await publicOnly(channelId, "groups:write", () =>
        callSlack("conversations.setPurpose", token, { channel: channelId, purpose }, context),
      );
      return { channelId, purpose };
    },
  }),

  tool({
    name: "slack_channel_invite",
    label: "Invite to Slack channel",
    description:
      "Invite users to a public Slack channel. Private channels are refused (they need `groups:write.invites`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
      userIds: Type.Array(Type.String({ description: "User ID, e.g. U0123ABCD." }), {
        minItems: 1,
        maxItems: 100,
        description: "Users to invite; at most 100 per call.",
      }),
    }),
    outputSchema: Type.Object(
      { channel: slackChannel, invited: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    async execute({ channelId, userIds }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write.invites", context);
      const data = await publicOnly(channelId, "groups:write.invites", () =>
        callSlack(
          "conversations.invite",
          token,
          { channel: channelId, users: userIds.join(",") },
          context,
        ),
      );
      return { channel: curateChannel(data.channel, channelId), invited: userIds };
    },
  }),
];

/**
 * Archive hides a channel from every member's sidebar; rename breaks links and habits
 * built on the old name. Both wait for a human, on top of the schema's `confirm: true`.
 */
export const channelApprovals: ApprovalRule[] = [
  {
    toolName: "slack_channel_archive",
    check: ({ channelId }) => ({
      title: "Archive Slack channel",
      description: `Archive channel ${channelId}. Members lose it from their sidebar until someone unarchives it.`,
      target: `channel ${channelId}`,
    }),
  },
  {
    toolName: "slack_channel_rename",
    check: ({ channelId, name }) => ({
      title: "Rename Slack channel",
      description: `Rename channel ${channelId} to #${name}. Links and references to the old name stop matching.`,
      target: `channel ${channelId}`,
    }),
  },
];
