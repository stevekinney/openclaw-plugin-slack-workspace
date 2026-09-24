import { Type } from "typebox";
import { callSlack, joinPublicChannel, resolveToken, type SlackCallContext } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";
import { addBookmark, slackBookmark } from "./bookmarks.js";
import { createCanvas, createdCanvasSchema } from "./canvases.js";

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

/** Curated channel (see "Output shaping" in schemas.ts): Slack's channel object carries ~30 fields. */
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

const userIdsParam = (description: string) =>
  Type.Array(Type.String({ description: "User ID, e.g. U0123ABCD." }), {
    minItems: 1,
    maxItems: 100,
    description,
  });

type KickoffStepName = "create" | "topic" | "purpose" | "invite" | "canvas" | "bookmark";
type KickoffStep = { step: KickoffStepName; ok: boolean; error?: string };

/**
 * With the host's `groupPolicy: "open"`, every channel the bot is in counts as allowed:
 * the agent answers @-mentions there, and the channel plugin posts one join
 * introduction unless `channels.slack.joinIntro` is false.
 */
const MEMBERSHIP_NOTE =
  "Membership has side effects: the agent will answer @-mentions in every channel it belongs to, and the Slack channel plugin posts a one-time introduction when the bot joins (unless `channels.slack.joinIntro` is false).";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
      userIds: userIdsParam("Users to invite; at most 100 per call."),
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
  tool({
    name: "slack_channel_join",
    label: "Join Slack channel",
    description: `Join a public Slack channel as the bot. Private channels, DMs, and group DMs are refused: the bot must be invited (\`/invite @OpenClaw\`). Archived channels are refused. Other tools already join a public channel on their own when Slack answers \`not_in_channel\` (their result then carries \`autoJoined: true\`), so call this only to join ahead of time. ${MEMBERSHIP_NOTE}`,
    parameters: Type.Object({
      channelId: channelIdParam("Public channels only; private channels need an invite."),
    }),
    outputSchema: Type.Object(
      {
        channel: slackChannel,
        alreadyMember: Type.Boolean({ description: "True if the bot was already in the channel." }),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const { channel, alreadyMember } = await joinPublicChannel(channelId, token, context);
      return { channel: curateChannel(channel, channelId), alreadyMember };
    },
  }),

  tool({
    name: "slack_channel_leave",
    label: "Leave Slack channel",
    description:
      "Remove the bot from a public Slack channel. The agent stops answering @-mentions there. Private channels are refused (they need `groups:write`).",
    parameters: Type.Object({
      channelId: publicChannelIdParam(),
    }),
    outputSchema: Type.Object(
      {
        channelId: Type.String(),
        left: Type.Boolean({ description: "False if the bot was not a member to begin with." }),
      },
      { additionalProperties: false },
    ),
    async execute({ channelId }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await requirePublicChannel(channelId, token, "groups:write", context);
      const data = await publicOnly(channelId, "groups:write", () =>
        callSlack("conversations.leave", token, { channel: channelId }, context),
      );
      return { channelId, left: data.not_in_channel !== true };
    },
  }),

  tool({
    name: "slack_channel_kickoff",
    label: "Kick off Slack channel",
    description:
      "Stand up a project room in one call: create a public channel, then optionally set its topic and purpose, invite users, create a canvas shared to it, and add a link bookmark. Treat this as requiring confirmation before use: it always waits for a human's approval. Steps after create run even if an earlier one fails; each is reported in `steps` with its error, and `complete` is false if any failed. If create itself fails, the call throws and nothing else runs.",
    parameters: Type.Object({
      name: channelNameParam(
        "Channel name: lowercase letters, numbers, hyphens, and underscores; at most 80 characters.",
      ),
      topic: Type.Optional(
        Type.String({ maxLength: 250, description: "Channel topic; at most 250 characters." }),
      ),
      purpose: Type.Optional(
        Type.String({ maxLength: 250, description: "Channel purpose; at most 250 characters." }),
      ),
      invite: Type.Optional(userIdsParam("Users to invite; at most 100.")),
      canvas: Type.Optional(
        Type.Object(
          {
            title: Type.String({ description: "Canvas title." }),
            markdown: Type.String({ description: "Canvas body as markdown." }),
            accessLevel: Type.Optional(
              Type.Union([Type.Literal("read"), Type.Literal("write")], {
                description: "The channel's access to the canvas. Default: write.",
              }),
            ),
          },
          { description: "Create a canvas and share it with the new channel." },
        ),
      ),
      bookmark: Type.Optional(
        Type.Object(
          {
            title: Type.String({ description: "Bookmark title." }),
            link: Type.String({ description: "Bookmark URL." }),
            emoji: Type.Optional(Type.String({ description: "Emoji shortcode, e.g. :books:." })),
          },
          { description: "Add a link bookmark to the new channel." },
        ),
      ),
    }),
    outputSchema: Type.Object(
      {
        channel: slackChannel,
        complete: Type.Boolean({ description: "True when every requested step succeeded." }),
        steps: Type.Array(
          Type.Object(
            {
              step: Type.Union([
                Type.Literal("create"),
                Type.Literal("topic"),
                Type.Literal("purpose"),
                Type.Literal("invite"),
                Type.Literal("canvas"),
                Type.Literal("bookmark"),
              ]),
              ok: Type.Boolean(),
              error: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
          { description: "Each requested step, in the order it ran." },
        ),
        invited: Type.Array(Type.String()),
        canvas: Type.Union([createdCanvasSchema, Type.Null()], {
          description: "Set whenever the canvas was created, even if sharing it failed.",
        }),
        bookmark: Type.Union([slackBookmark, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    async execute({ name, topic, purpose, invite, canvas, bookmark }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      // Nothing exists yet, so a failed create is an ordinary throw.
      const created = await callSlack(
        "conversations.create",
        token,
        { name, is_private: false },
        context,
      );
      const channel = curateChannel(created.channel);
      const steps: KickoffStep[] = [{ step: "create", ok: true }];

      /** Run one step, recording a failure instead of throwing so later steps still run. */
      const run = async (step: KickoffStepName, action: () => Promise<string | void>) => {
        context.signal?.throwIfAborted();
        try {
          const error = await action();
          steps.push(error === undefined ? { step, ok: true } : { step, ok: false, error });
          return error === undefined;
        } catch (error) {
          // Cancellation isn't a step failure: honor it rather than returning a result.
          context.signal?.throwIfAborted();
          steps.push({ step, ok: false, error: errorMessage(error) });
          return false;
        }
      };

      // The channel was just created public, so the private-channel checks are skipped.
      if (topic !== undefined) {
        await run("topic", async () => {
          await callSlack("conversations.setTopic", token, { channel: channel.id, topic }, context);
        });
      }
      if (purpose !== undefined) {
        await run("purpose", async () => {
          await callSlack(
            "conversations.setPurpose",
            token,
            { channel: channel.id, purpose },
            context,
          );
        });
      }
      let invited: string[] = [];
      if (invite?.length) {
        const ok = await run("invite", async () => {
          await callSlack(
            "conversations.invite",
            token,
            { channel: channel.id, users: invite.join(",") },
            context,
          );
        });
        if (ok) invited = invite;
      }
      let canvasResult: Awaited<ReturnType<typeof createCanvas>> | null = null;
      if (canvas) {
        await run("canvas", async () => {
          canvasResult = await createCanvas(token, { ...canvas, channelIds: [channel.id] }, context);
          return canvasResult.shareError;
        });
      }
      let bookmarkResult: Awaited<ReturnType<typeof addBookmark>> = null;
      if (bookmark) {
        await run("bookmark", async () => {
          bookmarkResult = await addBookmark(token, { ...bookmark, channelId: channel.id }, context);
        });
      }

      return {
        channel,
        complete: steps.every((step) => step.ok),
        steps,
        invited,
        canvas: canvasResult,
        bookmark: bookmarkResult,
      };
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
  {
    // Several visible, hard-to-undo writes in one call (a new channel, invitations that
    // notify people, a shared canvas), so every kickoff waits for a human.
    toolName: "slack_channel_kickoff",
    check: ({ name, topic, purpose, invite, canvas, bookmark }) => {
      const plan = [`Create public channel #${name}`];
      if (topic !== undefined) plan.push(`set its topic to "${topic}"`);
      if (purpose !== undefined) plan.push(`set its purpose to "${purpose}"`);
      if (Array.isArray(invite) && invite.length) plan.push(`invite ${invite.join(", ")}`);
      if (canvas) plan.push(`create and share canvas "${(canvas as { title?: unknown }).title}"`);
      if (bookmark) plan.push(`bookmark "${(bookmark as { title?: unknown }).title}"`);
      return {
        title: "Kick off Slack channel",
        description: `${plan.join(", ")}.`,
        target: `new channel #${name}`,
      };
    },
  },
];
