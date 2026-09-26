import { Type } from "typebox";
import {
  callSlack,
  joinPublicChannel,
  resolveToken,
  SlackApiError,
} from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import { cursorParams, toPage, walkPages, type PageRequest } from "../pagination.js";
import { channelIdParam, type ToolFactory } from "../schemas.js";
import { addBookmark, slackBookmark } from "./bookmarks.js";
import { createCanvas, createdCanvasSchema } from "./canvases.js";

/**
 * Private channels need the `groups:write*` twins of the public-channel scopes
 * (`channels:manage`, `channels:write.topic`, `channels:write.invites`). The app holds
 * both sets, so these tools act on any channel the bot is a member of. On an install
 * that lacks a `groups:*` scope, Slack answers a private-channel call with a bare
 * `missing_scope`; the tools translate it into an error naming the scope.
 */
const privateChannelError = (channel: string, scope: string, options?: ErrorOptions) =>
  new Error(
    `${channel} is a private channel, and acting on private channels needs the \`${scope}\` scope, which this Slack app's bot token lacks. Add it to the Slack app, reinstall, and run \`openclaw slack-workspace doctor\` to confirm.`,
    options,
  );

/** The `groups:*` scope Slack names when a private-channel call lacks it. */
const missingPrivateScope = (error: unknown) =>
  error instanceof SlackApiError && error.code === "missing_scope"
    ? /needs scope: (groups:[\w.]+)/.exec(error.message)?.[1]
    : undefined;

/** Run a channel call, translating a `groups:*` `missing_scope` into the explicit error. */
async function withPrivateFallback<T>(channel: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const missing = missingPrivateScope(error);
    if (missing) throw privateChannelError(channel, missing, { cause: error });
    if (error instanceof SlackApiError && error.code === "channel_not_found") {
      throw new Error(
        `${error.message}. Check the channel ID; if it is a private channel, the bot can only act on it as a member: invite it with \`/invite @OpenClaw\`.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Refuse archive/unarchive/rename unless the caller passed `confirm: true` explicitly. */
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

const memberChannelIdParam = () =>
  channelIdParam("A public channel, or a private channel the bot is a member of.");

const channelNameParam = (description: string) =>
  Type.String({ minLength: 1, maxLength: 80, description });

const confirmParam = (action: string) =>
  Type.Literal(true, {
    description: `Must be exactly true to ${action}. There is no default: omitting it rejects the call before Slack is contacted.`,
  });

const isPrivateParam = () =>
  Type.Optional(
    Type.Boolean({
      description:
        "Create a private channel instead of a public one (needs `groups:write`). Default false.",
    }),
  );

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

/** A channel as `slack_channel_list` reports it: enough to pick one and decide whether to join. */
const listedChannel = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    isPrivate: Type.Boolean(),
    isArchived: Type.Boolean(),
    isMember: Type.Boolean({ description: "True if the bot is already in the channel." }),
    topic: Type.Optional(Type.String()),
    purpose: Type.Optional(Type.String()),
    memberCount: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

type RawChannel = Record<string, unknown> & {
  topic?: { value?: unknown };
  purpose?: { value?: unknown };
};

function curateListedChannel(raw: RawChannel) {
  const topic = typeof raw.topic?.value === "string" ? raw.topic.value : "";
  const purpose = typeof raw.purpose?.value === "string" ? raw.purpose.value : "";
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    isPrivate: raw.is_private === true,
    isArchived: raw.is_archived === true,
    isMember: raw.is_member === true,
    // Slack sends "" for an unset topic or purpose; drop it rather than echo noise.
    ...(topic ? { topic } : {}),
    ...(purpose ? { purpose } : {}),
    ...(typeof raw.num_members === "number" ? { memberCount: raw.num_members } : {}),
  };
}

const matchesQuery = (channel: ReturnType<typeof curateListedChannel>, query: string) => {
  const needle = query.toLowerCase();
  return [channel.name, channel.topic, channel.purpose].some((field) =>
    field?.toLowerCase().includes(needle),
  );
};

/** Without `groups:read`, asking for private channels fails outright instead of omitting them. */
const isGroupsReadMissing = (error: unknown) =>
  error instanceof SlackApiError &&
  error.code === "missing_scope" &&
  /needs scope: groups:read/.test(error.message);

const pagingParams = (itemName: string) => ({
  cursor: Type.Optional(
    Type.String({ description: "Resume from the `cursor` a previous call returned." }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: `${itemName} per Slack page.` }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Stop after this many Slack pages. Default 10.",
    }),
  ),
});

const pagingOutput = {
  cursor: Type.Optional(Type.String({ description: "Pass back as `cursor` to continue." })),
  hasMore: Type.Boolean(),
};

export const channelTools = (tool: ToolFactory) => [
  tool({
    name: "slack_channel_list",
    label: "List Slack channels",
    description:
      "Find channels: every public channel in the workspace, plus private channels the bot is in. Filter with `query`, a case-insensitive substring of the name, topic, or purpose. Each result carries `isMember`, so you can decide what to join with slack_channel_join. Archived channels are left out unless `excludeArchived` is false. Follows Slack's pages up to `maxPages`; if `hasMore` is still true, call again with the returned `cursor` for the rest. Read-only.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 250,
          description: "Keep channels whose name, topic, or purpose contains this text (case-insensitive).",
        }),
      ),
      excludeArchived: Type.Optional(
        Type.Boolean({ description: "Leave archived channels out. Default true." }),
      ),
      ...pagingParams("Channels"),
    }),
    outputSchema: Type.Object(
      {
        channels: Type.Array(listedChannel),
        privateIncluded: Type.Boolean({
          description:
            "False when the bot token lacks `groups:read`, so only public channels were listed.",
        }),
        ...pagingOutput,
      },
      { additionalProperties: false },
    ),
    async execute({ query, excludeArchived = true, cursor, limit, maxPages }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const walk = (types: string) =>
        walkPages(
          async (request: PageRequest) => {
            const data = await callSlack(
              "conversations.list",
              token,
              { types, exclude_archived: excludeArchived, ...cursorParams(request) },
              context,
            );
            return toPage<RawChannel>(data, "channels");
          },
          { cursor, limit, maxPages, signal: context.signal },
        );
      let privateIncluded = true;
      let page;
      try {
        page = await walk("public_channel,private_channel");
      } catch (error) {
        if (!isGroupsReadMissing(error)) throw error;
        privateIncluded = false;
        page = await walk("public_channel");
      }
      const channels = page.items.map(curateListedChannel);
      return {
        channels: query ? channels.filter((channel) => matchesQuery(channel, query)) : channels,
        privateIncluded,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        hasMore: page.hasMore,
      };
    },
  }),

  tool({
    name: "slack_channel_members",
    label: "List Slack channel members",
    description:
      "List the user IDs of a channel's members. Follows Slack's pages up to `maxPages`; if `hasMore` is still true, call again with the returned `cursor` for the rest. Read-only.",
    parameters: Type.Object({
      channelId: channelIdParam(),
      ...pagingParams("Members"),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), userIds: Type.Array(Type.String()), ...pagingOutput },
      { additionalProperties: false },
    ),
    async execute({ channelId, cursor, limit, maxPages }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const page = await walkPages(
        async (request) => {
          const data = await callSlack(
            "conversations.members",
            token,
            { channel: channelId, ...cursorParams(request) },
            context,
          );
          return toPage<unknown>(data, "members");
        },
        { cursor, limit, maxPages, signal: context.signal },
      );
      return {
        channelId,
        userIds: page.items.map(String),
        ...(page.cursor ? { cursor: page.cursor } : {}),
        hasMore: page.hasMore,
      };
    },
  }),

  tool({
    name: "slack_channel_create",
    label: "Create Slack channel",
    description:
      "Create a Slack channel: public by default, or private with `isPrivate: true`. The bot is a member of the new channel either way.",
    parameters: Type.Object({
      name: channelNameParam(
        "Channel name: lowercase letters, numbers, hyphens, and underscores; at most 80 characters.",
      ),
      isPrivate: isPrivateParam(),
    }),
    outputSchema: Type.Object({ channel: slackChannel }, { additionalProperties: false }),
    async execute({ name, isPrivate = false }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const data = await withPrivateFallback(`Channel "${name}"`, () =>
        callSlack("conversations.create", token, { name, is_private: isPrivate }, context),
      );
      return { channel: curateChannel(data.channel) };
    },
  }),

  tool({
    name: "slack_channel_archive",
    label: "Archive Slack channel",
    description:
      "Archive a Slack channel: public, or private if the bot is a member. Disruptive: members lose the channel from their sidebar. Requires `confirm: true` and a human's approval.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
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
      await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.archive", token, { channel: channelId }, context),
      );
      return { archived: true, channelId };
    },
  }),

  tool({
    name: "slack_channel_unarchive",
    label: "Unarchive Slack channel",
    description:
      "Unarchive a Slack channel (public, or private if the bot is a member): the recovery path for slack_channel_archive. Visible to everyone who can see the channel: it returns to search and the channel browser. Requires `confirm: true` and a human's approval.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
      confirm: confirmParam("unarchive the channel"),
    }),
    outputSchema: Type.Object(
      { unarchived: Type.Literal(true), channelId: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, confirm }, config, context) {
      context.signal?.throwIfAborted();
      requireConfirm(confirm, `unarchive channel ${channelId}`);
      const token = resolveToken(config);
      await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.unarchive", token, { channel: channelId }, context),
      );
      return { unarchived: true, channelId };
    },
  }),

  tool({
    name: "slack_channel_rename",
    label: "Rename Slack channel",
    description:
      "Rename a Slack channel: public, or private if the bot is a member. Disruptive: links and habits built on the old name break. Requires `confirm: true` and a human's approval.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
      name: channelNameParam("New channel name, following Slack's naming rules; at most 80 characters."),
      confirm: confirmParam("rename the channel"),
    }),
    outputSchema: Type.Object({ channel: slackChannel }, { additionalProperties: false }),
    async execute({ channelId, name, confirm }, config, context) {
      context.signal?.throwIfAborted();
      requireConfirm(confirm, `rename channel ${channelId}`);
      const token = resolveToken(config);
      const data = await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.rename", token, { channel: channelId, name }, context),
      );
      return { channel: curateChannel(data.channel, channelId) };
    },
  }),

  tool({
    name: "slack_channel_set_topic",
    label: "Set Slack channel topic",
    description:
      "Set a Slack channel's topic: public, or private if the bot is a member.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
      topic: Type.String({ maxLength: 250, description: "New topic; at most 250 characters." }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), topic: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, topic }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.setTopic", token, { channel: channelId, topic }, context),
      );
      return { channelId, topic };
    },
  }),

  tool({
    name: "slack_channel_set_purpose",
    label: "Set Slack channel purpose",
    description:
      "Set a Slack channel's purpose (its description): public, or private if the bot is a member.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
      purpose: Type.String({ maxLength: 250, description: "New purpose; at most 250 characters." }),
    }),
    outputSchema: Type.Object(
      { channelId: Type.String(), purpose: Type.String() },
      { additionalProperties: false },
    ),
    async execute({ channelId, purpose }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.setPurpose", token, { channel: channelId, purpose }, context),
      );
      return { channelId, purpose };
    },
  }),

  tool({
    name: "slack_channel_invite",
    label: "Invite to Slack channel",
    description:
      "Invite users to a Slack channel: public, or private if the bot is a member.",
    parameters: Type.Object({
      channelId: memberChannelIdParam(),
      userIds: userIdsParam("Users to invite; at most 100 per call."),
    }),
    outputSchema: Type.Object(
      { channel: slackChannel, invited: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    async execute({ channelId, userIds }, config, context) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      const data = await withPrivateFallback(`Channel ${channelId}`, () =>
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
      "Remove the bot from a public Slack channel. The agent stops answering @-mentions there. Private channels are refused: once out, the bot can't rejoin one without a member's invite.",
    parameters: Type.Object({
      channelId: channelIdParam("Public channels only; private channels are refused."),
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
      const info = await withPrivateFallback(`Channel ${channelId}`, () =>
        callSlack("conversations.info", token, { channel: channelId }, context, true),
      );
      if ((info.channel as { is_private?: unknown } | undefined)?.is_private === true) {
        throw new Error(
          `Channel ${channelId} is a private channel. slack_channel_leave only leaves public channels: once out of a private channel, the bot can't rejoin it without a member's invite.`,
        );
      }
      const data = await callSlack("conversations.leave", token, { channel: channelId }, context);
      return { channelId, left: data.not_in_channel !== true };
    },
  }),

  tool({
    name: "slack_channel_kickoff",
    label: "Kick off Slack channel",
    description:
      "Stand up a project room in one call: create a channel (public, or private with `isPrivate: true`), then optionally set its topic and purpose, invite users, create a canvas shared to it, and add a link bookmark. Treat this as requiring confirmation before use: it always waits for a human's approval. Steps after create run even if an earlier one fails; each is reported in `steps` with its error, and `complete` is false if any failed. If create itself fails, the call throws and nothing else runs.",
    parameters: Type.Object({
      name: channelNameParam(
        "Channel name: lowercase letters, numbers, hyphens, and underscores; at most 80 characters.",
      ),
      isPrivate: isPrivateParam(),
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
    async execute(
      { name, isPrivate = false, topic, purpose, invite, canvas, bookmark },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const token = resolveToken(config);
      // Nothing exists yet, so a failed create is an ordinary throw.
      const created = await withPrivateFallback(`Channel "${name}"`, () =>
        callSlack("conversations.create", token, { name, is_private: isPrivate }, context),
      );
      const channel = curateChannel(created.channel);
      const steps: KickoffStep[] = [{ step: "create", ok: true }];

      /** Run one step, recording a failure instead of throwing so later steps still run. */
      const run = async (step: KickoffStepName, action: () => Promise<string | void>) => {
        context.signal?.throwIfAborted();
        try {
          const error = await withPrivateFallback(`Channel ${channel.id}`, action);
          steps.push(error === undefined ? { step, ok: true } : { step, ok: false, error });
          return error === undefined;
        } catch (error) {
          // Cancellation isn't a step failure: honor it rather than returning a result.
          context.signal?.throwIfAborted();
          steps.push({ step, ok: false, error: errorMessage(error) });
          return false;
        }
      };

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
 * Archive hides a channel from every member's sidebar; unarchive brings it back for the
 * whole workspace; rename breaks links and habits built on the old name. All three wait
 * for a human, on top of the schema's `confirm: true`.
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
    toolName: "slack_channel_unarchive",
    check: ({ channelId }) => ({
      title: "Unarchive Slack channel",
      description: `Unarchive channel ${channelId}. It becomes visible again across the workspace, in search and the channel browser.`,
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
    // The hook sees only params, so only kickoff (via `isPrivate`) can say "private".
    check: ({ name, isPrivate, topic, purpose, invite, canvas, bookmark }) => {
      const kind = isPrivate === true ? "private" : "public";
      const plan = [`Create ${kind} channel #${name}`];
      if (topic !== undefined) plan.push(`set its topic to "${topic}"`);
      if (purpose !== undefined) plan.push(`set its purpose to "${purpose}"`);
      if (Array.isArray(invite) && invite.length) plan.push(`invite ${invite.join(", ")}`);
      if (canvas) plan.push(`create and share canvas "${(canvas as { title?: unknown }).title}"`);
      if (bookmark) plan.push(`bookmark "${(bookmark as { title?: unknown }).title}"`);
      return {
        title: "Kick off Slack channel",
        description: `${plan.join(", ")}.`,
        target: `new ${isPrivate === true ? "private " : ""}channel #${name}`,
      };
    },
  },
];
