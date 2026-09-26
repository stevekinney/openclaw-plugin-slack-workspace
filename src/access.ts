import { Type } from "typebox";

/**
 * Channel/user access targets shared by the canvas and List access tools
 * (`canvases.access.*`, `slackLists.access.*`), which take the same shape.
 */

/** Who an access change applies to. Slack takes channels or users per call, never both. */
export type AccessTarget = { channelIds: string[] } | { userIds: string[] };

export type AccessLevel = "read" | "write" | "owner";

export const accessLevelParam = Type.Union(
  [Type.Literal("read"), Type.Literal("write"), Type.Literal("owner")],
  { description: "Access to grant. owner is valid for userIds only." },
);

const idsParam = (kind: "Channel" | "User", example: string, note: string) =>
  Type.Optional(
    Type.Array(Type.String({ description: `${kind} ID, e.g. ${example}.` }), {
      minItems: 1,
      uniqueItems: true,
      description: `${note} Set channelIds or userIds, not both.`,
    }),
  );

export const accessTargetParams = (verb: string) => ({
  channelIds: idsParam("Channel", "C0C42LZQZGQ", `Channels to ${verb}.`),
  userIds: idsParam("User", "U0123ABCD", `Users to ${verb}.`),
});

export const accessTargetOutput = {
  channelIds: Type.Optional(Type.Array(Type.String())),
  userIds: Type.Optional(Type.Array(Type.String())),
};

/** Fail before calling Slack unless exactly one of channelIds/userIds is non-empty. */
export function accessTarget(channelIds?: string[], userIds?: string[]): AccessTarget {
  const hasChannels = Boolean(channelIds?.length);
  const hasUsers = Boolean(userIds?.length);
  if (hasChannels && hasUsers) throw new Error("Set either channelIds or userIds, not both.");
  if (hasChannels) return { channelIds: channelIds! };
  if (hasUsers) return { userIds: userIds! };
  throw new Error("Set channelIds or userIds.");
}

/** A channel can read or write but can't own; fail before calling Slack. */
export function assertAccessLevel(target: AccessTarget, accessLevel: AccessLevel) {
  if (accessLevel === "owner" && "channelIds" in target) {
    throw new Error("owner access can only be granted to users, not channels.");
  }
}

/** Slack's field names for a target: `channel_ids` or `user_ids`. */
export const slackAccessTarget = (target: AccessTarget) =>
  "channelIds" in target ? { channel_ids: target.channelIds } : { user_ids: target.userIds };

/** Names an access call's targets for an approval prompt, from raw, unvalidated params. */
export function describeAccessTargets({ channelIds, userIds }: Record<string, unknown>) {
  const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const channels = ids(channelIds);
  return channels.length ? `channels ${channels.join(", ")}` : `users ${ids(userIds).join(", ")}`;
}

/**
 * A grant that reaches beyond individual readers and writers: any channel share (every
 * member sees it) or `owner` (the grantee can share it further). Revoking either doesn't
 * un-show what people already saw, so both need approval; user read/write grants don't.
 */
export function isWideReachShare({ channelIds, accessLevel }: Record<string, unknown>) {
  return accessLevel === "owner" || (Array.isArray(channelIds) && channelIds.length > 0);
}
