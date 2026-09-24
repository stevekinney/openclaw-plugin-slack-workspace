import { Type } from "typebox";
import { callSlack, resolveToken } from "../client.js";
import type { ApprovalRule } from "../approvals.js";
import type { ToolFactory } from "../schemas.js";

/**
 * Remote files register an external document (a Linear issue, a generated report) as a
 * native Slack file object with a preview card. Slack's `files.remote.add` rejects user
 * tokens, so every remote-file tool uses the bot token. These are the `remote_files:*`
 * scopes, distinct from `files:read`/`files:write`, which cover uploaded bytes.
 */
const BOT_TOKEN_NOTE = "Uses the bot token: Slack rejects user tokens for remote files.";

const fileIdParam = () =>
  Type.Optional(Type.String({ description: "Slack file ID (F…) of the remote file." }));
const externalIdParam = () =>
  Type.Optional(
    Type.String({ description: "The external ID the remote file was added with." }),
  );
const TARGET_NOTE = "Identify the file with exactly one of fileId or externalId.";

/** Slack's `file`/`external_id` pair: exactly one must be set. */
function remoteFileTarget({ fileId, externalId }: { fileId?: string; externalId?: string }) {
  if (!fileId === !externalId) {
    throw new Error("Pass exactly one of fileId or externalId to identify the remote file.");
  }
  return fileId ? { file: fileId } : { external_id: externalId };
}

/** Curated remote file (see "Output shaping" in schemas.ts): Slack's file object carries ~30 fields. */
const slackRemoteFile = {
  fileId: Type.String({ description: "Slack file ID (F…)." }),
  externalId: Type.String(),
  externalUrl: Type.String(),
  title: Type.String(),
  permalink: Type.String({ description: "Slack permalink to the file's preview card." }),
};

type RawRemoteFile = Record<string, unknown>;

function curateRemoteFile(raw: RawRemoteFile) {
  return {
    fileId: String(raw.id ?? ""),
    externalId: String(raw.external_id ?? ""),
    externalUrl: String(raw.external_url ?? ""),
    title: String(raw.title ?? ""),
    permalink: String(raw.permalink ?? ""),
  };
}

export const remoteFileTools = (tool: ToolFactory) => [
  tool({
    name: "slack_remote_file_add",
    label: "Add Slack remote file",
    description:
      "Register an external document, like a Linear issue or a generated report link, as a " +
      "native Slack file object with a preview card, instead of posting a bare link. " +
      "Share it into channels with slack_remote_file_share. " +
      `${BOT_TOKEN_NOTE}`,
    parameters: Type.Object({
      externalId: Type.String({
        description: "Your own stable, unique ID for the document, e.g. linear-ENG-123.",
      }),
      externalUrl: Type.String({ description: "URL of the external document." }),
      title: Type.String({ description: "Title shown on the file's preview card." }),
      filetype: Type.Optional(
        Type.String({ description: "Slack file type, e.g. pdf or gdoc. Default: remote." }),
      ),
      indexableFileContents: Type.Optional(
        Type.String({ description: "Plain text Slack indexes so search can find the file." }),
      ),
    }),
    outputSchema: Type.Object(slackRemoteFile, { additionalProperties: false }),
    async execute(
      { externalId, externalUrl, title, filetype, indexableFileContents },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const body: Record<string, unknown> = {
        external_id: externalId,
        external_url: externalUrl,
        title,
      };
      if (filetype) body.filetype = filetype;
      if (indexableFileContents) body.indexable_file_contents = indexableFileContents;
      const data = await callSlack(
        "files.remote.add",
        resolveToken(config, "bot"),
        body,
        context,
        true,
      );
      return curateRemoteFile((data.file ?? {}) as RawRemoteFile);
    },
  }),

  tool({
    name: "slack_remote_file_update",
    label: "Update Slack remote file",
    description:
      "Change a remote file's title, URL, file type, or indexed text in place. " +
      `${TARGET_NOTE} ${BOT_TOKEN_NOTE}`,
    parameters: Type.Object({
      fileId: fileIdParam(),
      externalId: externalIdParam(),
      title: Type.Optional(Type.String()),
      externalUrl: Type.Optional(Type.String()),
      filetype: Type.Optional(Type.String()),
      indexableFileContents: Type.Optional(Type.String()),
    }),
    outputSchema: Type.Object(slackRemoteFile, { additionalProperties: false }),
    async execute(
      { fileId, externalId, title, externalUrl, filetype, indexableFileContents },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const body: Record<string, unknown> = remoteFileTarget({ fileId, externalId });
      if (title) body.title = title;
      if (externalUrl) body.external_url = externalUrl;
      if (filetype) body.filetype = filetype;
      if (indexableFileContents) body.indexable_file_contents = indexableFileContents;
      if (Object.keys(body).length === 1) {
        throw new Error(
          "Nothing to update: pass title, externalUrl, filetype, or indexableFileContents.",
        );
      }
      const data = await callSlack(
        "files.remote.update",
        resolveToken(config, "bot"),
        body,
        context,
        true,
      );
      return curateRemoteFile((data.file ?? {}) as RawRemoteFile);
    },
  }),

  tool({
    name: "slack_remote_file_remove",
    label: "Remove Slack remote file",
    description:
      "Remove a remote file from Slack, taking its preview card out of every channel it was " +
      "shared to. The external document itself is untouched. " +
      `${TARGET_NOTE} ${BOT_TOKEN_NOTE}`,
    parameters: Type.Object({
      fileId: fileIdParam(),
      externalId: externalIdParam(),
    }),
    outputSchema: Type.Object(
      {
        fileId: Type.Optional(Type.String()),
        externalId: Type.Optional(Type.String()),
        removed: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    async execute({ fileId, externalId }, config, context) {
      context.signal?.throwIfAborted();
      const target = remoteFileTarget({ fileId, externalId });
      await callSlack("files.remote.remove", resolveToken(config, "bot"), target, context, true);
      return { ...(fileId ? { fileId } : { externalId }), removed: true as const };
    },
  }),

  tool({
    name: "slack_remote_file_share",
    label: "Share Slack remote file",
    description:
      "Share a remote file into one or more channels, where it shows as a file with a preview " +
      "card. Add it first with slack_remote_file_add. " +
      `${TARGET_NOTE} ${BOT_TOKEN_NOTE}`,
    parameters: Type.Object({
      fileId: fileIdParam(),
      externalId: externalIdParam(),
      channelIds: Type.Array(Type.String(), {
        minItems: 1,
        description: "Channel IDs to share the file into.",
      }),
    }),
    outputSchema: Type.Object(
      { ...slackRemoteFile, channelIds: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    async execute({ fileId, externalId, channelIds }, config, context) {
      context.signal?.throwIfAborted();
      const body = { ...remoteFileTarget({ fileId, externalId }), channels: channelIds.join(",") };
      const data = await callSlack(
        "files.remote.share",
        resolveToken(config, "bot"),
        body,
        context,
        true,
      );
      return { ...curateRemoteFile((data.file ?? {}) as RawRemoteFile), channelIds };
    },
  }),
];

export const remoteFileApprovals: ApprovalRule[] = [
  {
    toolName: "slack_remote_file_remove",
    check: ({ fileId, externalId }) => {
      const label = fileId ? `file ${fileId}` : `external ID ${externalId}`;
      return {
        title: "Remove Slack remote file",
        description: `Remove remote file ${label} from Slack, including from every channel it was shared to. This cannot be undone.`,
        target: `remote file ${fileId ?? externalId}`,
      };
    },
  },
];
