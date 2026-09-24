import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import type { ToolFactory } from "../schemas.js";

/**
 * Read-only by design: the app is granted `usergroups:read` but not `usergroups:write`,
 * so creating, editing, or changing the members of a user group is out of reach.
 */
const READ_ONLY_NOTE = "Read-only: usergroups:write is not granted, so groups cannot be changed.";

const includeDisabledParam = () =>
  Type.Optional(Type.Boolean({ description: "Include disabled user groups. Default: false." }));

/** Curated user group (see "Output shaping" in schemas.ts): Slack's own user group object carries ~20 audit fields. */
const slackUsergroup = Type.Object(
  {
    id: Type.String({ description: "User group ID (S…), for slack_usergroup_members." }),
    handle: Type.String({ description: "Mention handle, without the @." }),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    defaultChannelIds: Type.Array(Type.String(), {
      description: "Channels members are added to by default when they join the group.",
    }),
    userCount: Type.Optional(Type.Integer()),
    disabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

type RawUsergroup = Record<string, unknown> & { prefs?: { channels?: unknown } };

function curateUsergroup(raw: RawUsergroup) {
  const channels = raw.prefs?.channels;
  return {
    id: String(raw.id ?? ""),
    handle: String(raw.handle ?? ""),
    name: String(raw.name ?? ""),
    // Slack sends description:"" for groups without one; drop it rather than echo noise.
    ...(typeof raw.description === "string" && raw.description
      ? { description: raw.description }
      : {}),
    defaultChannelIds: Array.isArray(channels) ? channels.map(String) : [],
    ...(typeof raw.user_count === "number" ? { userCount: raw.user_count } : {}),
    // Slack disables a group by stamping date_delete; 0 means it is live.
    disabled: typeof raw.date_delete === "number" && raw.date_delete > 0,
  };
}

export const usergroupTools = (tool: ToolFactory) => [
  tool({
    name: "slack_usergroup_list",
    label: "List Slack user groups",
    description:
      "List the workspace's user groups (the @handles like @oncall) with their ID, handle, name, " +
      `default channels, and member count. ${READ_ONLY_NOTE}`,
    parameters: Type.Object({
      includeDisabled: includeDisabledParam(),
    }),
    outputSchema: Type.Object(
      { usergroups: Type.Array(slackUsergroup) },
      { additionalProperties: false },
    ),
    async execute({ includeDisabled }, config, context) {
      context.signal?.throwIfAborted();
      const data = await callSlack(
        "usergroups.list",
        resolveToken(config),
        { include_count: true, include_disabled: includeDisabled ?? false },
        context,
        true,
      );
      return {
        usergroups: ((data.usergroups ?? []) as RawUsergroup[]).map(curateUsergroup),
      };
    },
  }),

  tool({
    name: "slack_usergroup_members",
    label: "List Slack user group members",
    description:
      "List the user IDs of a user group's members, e.g. to answer who is on @oncall. " +
      `Find the group ID with slack_usergroup_list. ${READ_ONLY_NOTE}`,
    parameters: Type.Object({
      usergroupId: Type.String({ description: "User group ID (S…) from slack_usergroup_list." }),
      includeDisabled: includeDisabledParam(),
    }),
    outputSchema: Type.Object(
      { usergroupId: Type.String(), userIds: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    async execute({ usergroupId, includeDisabled }, config, context) {
      context.signal?.throwIfAborted();
      const data = await callSlack(
        "usergroups.users.list",
        resolveToken(config),
        { usergroup: usergroupId, include_disabled: includeDisabled ?? false },
        context,
        true,
      );
      return { usergroupId, userIds: ((data.users ?? []) as unknown[]).map(String) };
    },
  }),
];
