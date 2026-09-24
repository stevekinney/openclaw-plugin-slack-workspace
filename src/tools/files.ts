import { Type } from "typebox";
import { callSlack, resolveToken, type SlackCallContext } from "../client.js";
import { channelIdParam, threadTsParam, type ToolFactory } from "../schemas.js";

type RawFile = Record<string, unknown>;
type RawShare = { ts?: unknown };

/** The `ts` of the file's share message in `channelId`, from `shares.public`/`shares.private`. */
function shareTs(file: RawFile, channelId: string): string | null {
  const shares = (file.shares ?? {}) as Record<string, Record<string, RawShare[]> | undefined>;
  for (const visibility of ["public", "private"]) {
    const ts = shares[visibility]?.[channelId]?.[0]?.ts;
    if (typeof ts === "string" && ts) return ts;
  }
  return null;
}

/**
 * Slack's external upload flow (`files.upload` is retired): reserve an upload URL,
 * POST the raw bytes to it, then complete the upload, which is what shares it.
 * The upload URL is pre-signed, so the bytes go without the token.
 */
export async function uploadFile(
  token: string,
  {
    title,
    filename,
    bytes,
    channelId,
    threadTs,
    initialComment,
  }: {
    title: string;
    filename: string;
    bytes: Uint8Array<ArrayBuffer>;
    channelId?: string;
    threadTs?: string;
    initialComment?: string;
  },
  context: SlackCallContext,
) {
  const reserved = await callSlack(
    "files.getUploadURLExternal",
    token,
    { filename, length: bytes.byteLength },
    context,
    true,
  );
  const uploadUrl = String(reserved.upload_url ?? "");
  const fileId = String(reserved.file_id ?? "");
  if (!uploadUrl || !fileId) {
    throw new Error("Slack files.getUploadURLExternal returned no upload_url or file_id.");
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
    signal: context.signal,
  });
  if (!response.ok) {
    context.api?.logger?.warn(`slack-workspace: file upload error=http_${response.status}`);
    throw new Error(`Slack file upload failed: http_${response.status}`);
  }

  const body: Record<string, unknown> = { files: JSON.stringify([{ id: fileId, title }]) };
  if (channelId) body.channel_id = channelId;
  if (channelId && threadTs) body.thread_ts = threadTs;
  if (channelId && initialComment) body.initial_comment = initialComment;
  const data = await callSlack("files.completeUploadExternal", token, body, context, true);
  const file = (((data.files ?? []) as RawFile[]).find((entry) => entry.id === fileId) ??
    {}) as RawFile;
  return {
    fileId,
    permalink: String(file.permalink ?? ""),
    channelId: channelId ?? null,
    ts: channelId ? shareTs(file, channelId) : null,
  };
}

export const fileTools = (tool: ToolFactory) => [
  tool({
    name: "slack_file_upload",
    label: "Upload Slack file",
    description:
      "Upload a generated file (report, CSV, chart image) to Slack and share it to a channel or thread. " +
      "If channelId is omitted, the file stays private to the bot: it is uploaded but not shared anywhere, " +
      "and only the returned permalink points at it. Pass binary files (e.g. PNG) as base64 with contentEncoding: \"base64\".",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: "File title shown in Slack." }),
      content: Type.String({
        description: "File contents: UTF-8 text, or base64 when contentEncoding is \"base64\".",
      }),
      filename: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "File name with extension, e.g. report.csv; Slack infers the file type from it. Defaults to the title.",
        }),
      ),
      contentEncoding: Type.Optional(
        Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
          description: "How content is encoded. Default utf8.",
        }),
      ),
      channelId: Type.Optional(
        channelIdParam("Share the file here. Omit to keep the file private to the bot."),
      ),
      threadTs: threadTsParam,
      initialComment: Type.Optional(
        Type.String({ description: "Message posted with the file. Needs channelId." }),
      ),
    }),
    outputSchema: Type.Object(
      {
        fileId: Type.String(),
        permalink: Type.String(),
        channelId: Type.Union([Type.String(), Type.Null()], {
          description: "Where the file was shared; null when it was kept private.",
        }),
        ts: Type.Union([Type.String(), Type.Null()], {
          description:
            "Timestamp of the share message; null when private or when Slack had not reported the share yet.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(
      { title, content, filename, contentEncoding, channelId, threadTs, initialComment },
      config,
      context,
    ) {
      context.signal?.throwIfAborted();
      const bytes = new Uint8Array(Buffer.from(content, contentEncoding === "base64" ? "base64" : "utf8"));
      if (bytes.byteLength === 0) throw new Error("File content is empty; Slack rejects empty uploads.");
      return uploadFile(
        resolveToken(config),
        { title, filename: filename ?? title, bytes, channelId, threadTs, initialComment },
        context,
      );
    },
  }),
];
