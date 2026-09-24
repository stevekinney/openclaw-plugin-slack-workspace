import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const SLACK_API = "https://slack.com/api";

type SlackResponse = Record<string, unknown> & { ok?: boolean; error?: string };

type PluginConfig = {
  botToken?: string | { id?: string };
  userToken?: string | { id?: string };
};

/**
 * Slack splits its API across two token types. Bot tokens (xoxb-) act as the app;
 * user tokens (xoxp-) act as Steve. Methods like search.* and reminders.* reject
 * bot tokens outright with `not_allowed_token_type`, so each tool declares which
 * identity it needs rather than hoping one token covers everything.
 */
function resolveToken(config: PluginConfig, kind: "bot" | "user" = "bot"): string {
  const field = kind === "bot" ? "botToken" : "userToken";
  const envVar = kind === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_USER_TOKEN";
  const configured = config[field];
  if (configured && typeof configured !== "string") {
    throw new Error(
      `Slack ${kind} token SecretRef was not resolved by the host. Check the secret store entry and run \`openclaw secrets reload\`.`,
    );
  }
  const token = configured?.trim() || process.env[envVar]?.trim();
  if (!token) {
    throw new Error(
      `No Slack ${kind} token. Set plugins.entries.slack-workspace.config.${field} (SecretRef) or ${envVar}.`,
    );
  }
  return token;
}

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** The slice of the tool execution context the Slack client needs. */
type SlackCallContext = { signal?: AbortSignal; api?: { logger?: PluginLogger } };

/** Mirrors the bundled Slack channel plugin: retry a rate-limited call at most twice. */
const MAX_RATE_LIMIT_RETRIES = 2;
/** Longest `Retry-After` worth waiting out inside a single tool call. */
const MAX_RETRY_AFTER_SECONDS = 30;

/** One-line explanations for error codes whose bare name does not say what to do. */
const ERROR_HINTS: Record<string, string> = {
  not_allowed_token_type: "this method requires the other token type — bot vs user",
  cant_update_message: "only messages posted by this app's bot token can be updated",
  free_teams_cannot_create_standalone_canvases:
    "free workspaces cannot create standalone canvases; use a channel canvas instead",
  channel_canvas_already_exists: "this channel already has a canvas; edit that one instead",
  canvas_too_large: "the canvas exceeds Slack's size limit; split the content up",
  canvas_editing_locked: "the canvas is locked for editing; try again shortly",
  invalid_primary_column: "a list's primary column must be a text column",
  over_column_maximum: "the list has more columns than Slack allows",
};

function retryAfterSeconds(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Slack's older methods (search.*, reminders.*) only accept form encoding; the newer
 * ones accept JSON. `form: true` picks the legacy wire format.
 *
 * Rate-limited calls (HTTP 429 or a `ratelimited` body) are retried up to twice,
 * honoring `Retry-After`. Each call logs its method, elapsed time, and outcome —
 * never the token or the response body.
 */
async function callSlackRaw(
  method: string,
  token: string,
  body: Record<string, unknown>,
  context: SlackCallContext = {},
  form = false,
): Promise<{ data: SlackResponse; scopes: string[] }> {
  const { signal } = context;
  const logger = context.api?.logger;
  const started = Date.now();
  const log = (outcome: string) => {
    const message = `slack-workspace: ${method} ${outcome} in ${Date.now() - started}ms`;
    if (outcome === "ok") (logger?.debug ?? logger?.info)?.(message);
    else logger?.warn(message);
  };

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": form
          ? "application/x-www-form-urlencoded; charset=utf-8"
          : "application/json; charset=utf-8",
      },
      body: form
        ? new URLSearchParams(
            Object.entries(body).flatMap(([key, value]) =>
              value === undefined || value === null ? [] : [[key, String(value)]],
            ),
          ).toString()
        : JSON.stringify(body),
      signal,
    });

    let data: SlackResponse;
    try {
      data = (await response.json()) as SlackResponse;
    } catch {
      // Slack's edge sometimes answers with an HTML error page; a raw SyntaxError
      // from JSON.parse would hide the status that actually matters.
      data = { ok: false };
      if (response.status !== 429) {
        log(`error=http_${response.status}`);
        const contentType = response.headers.get("content-type") ?? "unknown";
        throw new Error(
          `Slack ${method} failed: http_${response.status} (non-JSON response, content-type ${contentType})`,
        );
      }
    }

    if (response.status === 429 || data.error === "ratelimited") {
      const wait = retryAfterSeconds(response);
      if (wait > MAX_RETRY_AFTER_SECONDS) {
        log(`error=ratelimited`);
        throw new Error(
          `Slack ${method} failed: ratelimited (Slack asked to wait ${wait}s; try again later)`,
        );
      }
      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        logger?.warn(`slack-workspace: ${method} ratelimited; retrying in ${wait}s`);
        await sleep(wait * 1000, signal);
        continue;
      }
      log(`error=ratelimited`);
      throw new Error(
        `Slack ${method} failed: ratelimited (still rate limited after ${MAX_RATE_LIMIT_RETRIES} retries)`,
      );
    }

    if (!data.ok) {
      const error = data.error ?? `http_${response.status}`;
      log(`error=${error}`);
      // Block Kit rejections carry per-block detail here; without it "invalid_blocks"
      // is unactionable.
      const detail = (data.response_metadata as { messages?: string[] } | undefined)?.messages;
      const hint =
        error === "missing_scope"
          ? ` (needs scope: ${String(data.needed ?? "unknown")})`
          : ERROR_HINTS[error]
            ? ` (${ERROR_HINTS[error]})`
            : detail?.length
              ? ` — ${detail.join("; ")}`
              : "";
      throw new Error(`Slack ${method} failed: ${error}${hint}`);
    }

    log("ok");
    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return { data, scopes };
  }
}

async function callSlack(
  method: string,
  token: string,
  body: Record<string, unknown>,
  context?: SlackCallContext,
  form = false,
): Promise<SlackResponse> {
  return (await callSlackRaw(method, token, body, context, form)).data;
}

const secretRefSchema = Type.Object({
  source: Type.String(),
  provider: Type.Optional(Type.String()),
  id: Type.String(),
});

const configSchema = Type.Object({
  botToken: Type.Optional(
    Type.Union([Type.String(), secretRefSchema], {
      description:
        "Slack bot token (xoxb-) or a SecretRef ({source,provider,id}). Falls back to SLACK_BOT_TOKEN.",
    }),
  ),
  userToken: Type.Optional(
    Type.Union([Type.String(), secretRefSchema], {
      description:
        "Slack user token (xoxp-) or a SecretRef. Required by search and reminders, which reject bot tokens. Falls back to SLACK_USER_TOKEN.",
    }),
  ),
});

const canvasUrl = (canvasId: string) => `https://slack.com/docs/${canvasId}`;

const blockSchema = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "One Block Kit block object, e.g. {\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*hi*\"}}.",
});

const blocksSchema = Type.Array(blockSchema, {
  minItems: 1,
  maxItems: 50,
  description:
    "Block Kit blocks, passed to Slack verbatim. Supports every block type the workspace allows, including ones OpenClaw's portable `presentation` cannot express: section, header, actions, context, divider, image, input, rich_text, table, video, and the newer card/carousel/alert families. Max 50 blocks.",
});

/** Wrap plain text as the single-paragraph rich_text entity task cards expect. */
const richText = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
});

async function postOrUpdate(
  config: PluginConfig,
  args: {
    channelId: string;
    text: string;
    blocks: unknown[];
    threadTs?: string;
    updateTs?: string;
  },
  context?: SlackCallContext,
): Promise<{ channelId: string; ts: string; updated: boolean }> {
  const token = resolveToken(config, "bot");
  const body: Record<string, unknown> = {
    channel: args.channelId,
    text: args.text,
    blocks: args.blocks,
  };
  if (args.updateTs) {
    body.ts = args.updateTs;
    const data = await callSlack("chat.update", token, body, context);
    return { channelId: args.channelId, ts: String(data.ts ?? args.updateTs), updated: true };
  }
  if (args.threadTs) body.thread_ts = args.threadTs;
  const data = await callSlack("chat.postMessage", token, body, context);
  return { channelId: args.channelId, ts: String(data.ts ?? ""), updated: false };
}

const targetParams = {
  channelId: Type.String({ description: "Channel or DM ID, e.g. C0C42LZQZGQ." }),
  threadTs: Type.Optional(
    Type.String({ description: "Post as a reply to this message timestamp." }),
  ),
  updateTs: Type.Optional(
    Type.String({
      description:
        "Timestamp of an existing message from this app to rewrite in place instead of posting a new one. Use this to keep one live card current.",
    }),
  ),
};

const postResultSchema = Type.Object(
  { channelId: Type.String(), ts: Type.String(), updated: Type.Boolean() },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "slack-workspace",
  name: "Slack Workspace",
  description: "Create and edit Slack canvases and manage channel bookmarks.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "slack_identity",
      label: "Inspect Slack token identity",
      description:
        "Report who a Slack token authenticates as and which OAuth scopes it was granted. Use to diagnose missing_scope or not_allowed_token_type errors.",
      parameters: Type.Object({
        tokenKind: Type.Optional(
          Type.Union([Type.Literal("bot"), Type.Literal("user")], {
            description: "Which configured token to inspect. Default: bot.",
          }),
        ),
      }),
      async execute({ tokenKind }, config, context) {
        context.signal?.throwIfAborted();
        const kind = tokenKind ?? "bot";
        const { data, scopes } = await callSlackRaw(
          "auth.test",
          resolveToken(config, kind),
          {},
          context,
        );
        return {
          tokenKind: kind,
          team: data.team ?? null,
          identity: data.user ?? null,
          userId: data.user_id ?? null,
          scopeCount: scopes.length,
          scopes,
        };
      },
    }),

    tool({
      name: "slack_search",
      label: "Search Slack",
      description:
        "Search Slack messages or files as the authorizing user. Covers every private channel, group, and DM that user belongs to — not just what the bot was invited to. Supports Slack's search modifiers: in:#channel, from:@user, before:2026-09-01, has:link.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search query. Slack modifiers work: `in:#ai-development`, `from:@steve`, `during:September`, `has:pin`.",
        }),
        scope: Type.Optional(
          Type.Union([Type.Literal("messages"), Type.Literal("files")], {
            description: "What to search. Default: messages.",
          }),
        ),
        count: Type.Optional(
          Type.Number({ minimum: 1, maximum: 100, description: "Results per page. Default 20." }),
        ),
        page: Type.Optional(Type.Number({ minimum: 1, description: "Page number. Default 1." })),
        sort: Type.Optional(
          Type.Union([Type.Literal("score"), Type.Literal("timestamp")], {
            description: "Rank by relevance (score) or recency (timestamp). Default: score.",
          }),
        ),
        sortDir: Type.Optional(
          Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
            description: "Sort direction. Default: desc.",
          }),
        ),
      }),
      async execute({ query, scope, count, page, sort, sortDir }, config, context) {
        context.signal?.throwIfAborted();
        const searchFiles = scope === "files";
        const data = await callSlack(
          searchFiles ? "search.files" : "search.messages",
          // search.* rejects bot tokens outright.
          resolveToken(config, "user"),
          {
            query,
            count: count ?? 20,
            page: page ?? 1,
            sort: sort ?? "score",
            sort_dir: sortDir ?? "desc",
          },
          context,
          true,
        );

        const result = (searchFiles ? data.files : data.messages) as
          | { total?: number; paging?: unknown; matches?: Record<string, unknown>[] }
          | undefined;
        const matches = result?.matches ?? [];

        // Slack match objects are large and mostly irrelevant; keep what identifies a hit.
        return {
          query,
          scope: searchFiles ? "files" : "messages",
          total: result?.total ?? 0,
          paging: result?.paging ?? null,
          matches: matches.map((match) =>
            searchFiles
              ? {
                  id: match.id,
                  name: match.name,
                  title: match.title,
                  filetype: match.filetype,
                  user: match.user,
                  created: match.created,
                  permalink: match.permalink,
                }
              : {
                  ts: match.ts,
                  // Block-only messages match on indexed block text but return text:"".
                  // Fall back to an attachment fallback so the hit isn't blank.
                  text:
                    match.text ||
                    (match.attachments as { fallback?: string }[] | undefined)?.[0]?.fallback ||
                    "(no plain text — Block Kit message; open the permalink)",
                  user: match.user,
                  username: match.username,
                  channel: (match.channel as { id?: string; name?: string } | undefined)?.name
                    ? {
                        id: (match.channel as { id?: string }).id,
                        name: (match.channel as { name?: string }).name,
                      }
                    : match.channel,
                  permalink: match.permalink,
                },
          ),
        };
      },
    }),

    tool({
      name: "slack_schedule_message",
      label: "Schedule Slack message",
      description:
        "Schedule a message to post at a future time, up to 120 days out. This is the working replacement for Slack reminders, whose API Slack retired in 2023 — reminders.add reports success but nothing is retrievable. Use for time-based nudges that must actually arrive. For recurring work, use an OpenClaw automation instead.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel or DM ID to post into." }),
        text: Type.String({ description: "Message text, or the fallback when blocks are set." }),
        postAt: Type.Union([Type.String(), Type.Number()], {
          description:
            'When to post: an ISO-8601 datetime ("2026-09-23T09:00:00-06:00") or Unix seconds. Must be in the future and within 120 days.',
        }),
        blocks: Type.Optional(blocksSchema),
        threadTs: Type.Optional(
          Type.String({ description: "Post as a reply to this message timestamp." }),
        ),
      }),
      outputSchema: Type.Object(
        {
          channelId: Type.String(),
          scheduledMessageId: Type.String(),
          postAt: Type.Number(),
          postAtIso: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute({ channelId, text, postAt, blocks, threadTs }, config, context) {
        context.signal?.throwIfAborted();

        const seconds =
          typeof postAt === "number" ? Math.floor(postAt) : Math.floor(Date.parse(postAt) / 1000);
        if (!Number.isFinite(seconds)) {
          throw new Error(`Could not read \`postAt\` (${postAt}) as ISO-8601 or Unix seconds.`);
        }
        const now = Math.floor(Date.now() / 1000);
        if (seconds <= now) {
          throw new Error(
            `\`postAt\` is ${now - seconds}s in the past. Slack only schedules future messages.`,
          );
        }
        if (seconds - now > 120 * 24 * 60 * 60) {
          throw new Error("Slack schedules at most 120 days ahead.");
        }

        const body: Record<string, unknown> = { channel: channelId, text, post_at: seconds };
        if (blocks) body.blocks = blocks;
        if (threadTs) body.thread_ts = threadTs;
        const data = await callSlack(
          "chat.scheduleMessage",
          resolveToken(config, "bot"),
          body,
          context,
        );
        return {
          channelId,
          scheduledMessageId: String(data.scheduled_message_id ?? ""),
          postAt: seconds,
          postAtIso: new Date(seconds * 1000).toISOString(),
        };
      },
    }),

    tool({
      name: "slack_scheduled_list",
      label: "List scheduled Slack messages",
      description:
        "List messages this app has scheduled but not yet posted. Use to confirm a schedule landed or to find an ID to cancel.",
      parameters: Type.Object({
        channelId: Type.Optional(
          Type.String({ description: "Limit to one channel. Omit for all channels." }),
        ),
      }),
      async execute({ channelId }, config, context) {
        context.signal?.throwIfAborted();
        const body: Record<string, unknown> = {};
        if (channelId) body.channel = channelId;
        const data = await callSlack(
          "chat.scheduledMessages.list",
          resolveToken(config, "bot"),
          body,
          context,
        );
        const scheduled = (data.scheduled_messages ?? []) as Record<string, unknown>[];
        return {
          scheduled: scheduled.map((entry) => ({
            id: entry.id,
            channelId: entry.channel_id,
            postAt: entry.post_at,
            postAtIso: new Date(Number(entry.post_at ?? 0) * 1000).toISOString(),
            text: entry.text,
          })),
        };
      },
    }),

    tool({
      name: "slack_scheduled_cancel",
      label: "Cancel scheduled Slack message",
      description: "Cancel a pending scheduled message. Get the ID from slack_scheduled_list.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel the message was scheduled into." }),
        scheduledMessageId: Type.String({ description: "ID from slack_scheduled_list." }),
      }),
      async execute({ channelId, scheduledMessageId }, config, context) {
        context.signal?.throwIfAborted();
        await callSlack(
          "chat.deleteScheduledMessage",
          resolveToken(config, "bot"),
          { channel: channelId, scheduled_message_id: scheduledMessageId },
          context,
        );
        return { channelId, scheduledMessageId, cancelled: true };
      },
    }),

    tool({
      name: "slack_post_table",
      label: "Post Slack table",
      description:
        "Post tabular data to Slack as a sortable, paginated data_table. Prefer this over a Markdown table or a bullet list whenever the data has columns. Pass plain strings and numbers — numeric cells sort numerically and are encoded correctly for you.",
      parameters: Type.Object({
        ...targetParams,
        caption: Type.String({
          description: "Table caption. Required by Slack and read by screen readers.",
        }),
        columns: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 20,
          description: "Header labels, left to right.",
        }),
        rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()])), {
          minItems: 1,
          maxItems: 200,
          description:
            "Data rows, excluding the header. Every row must have exactly as many cells as `columns`. Numbers sort numerically; strings sort alphabetically.",
        }),
        pageSize: Type.Optional(
          Type.Number({ minimum: 1, maximum: 100, description: "Rows per page. Default 5." }),
        ),
      }),
      outputSchema: postResultSchema,
      async execute(
        { channelId, caption, columns, rows, pageSize, threadTs, updateTs },
        config,
        context,
      ) {
        context.signal?.throwIfAborted();
        const bad = rows.findIndex((row) => row.length !== columns.length);
        if (bad !== -1) {
          throw new Error(
            `Row ${bad} has ${rows[bad].length} cells but there are ${columns.length} columns. Slack requires every row to match the header width.`,
          );
        }
        // raw_number needs BOTH value and text; sending either alone fails validation.
        const table: Record<string, unknown> = {
          type: "data_table",
          caption,
          rows: [
            columns.map((column) => ({ type: "raw_text", text: column })),
            ...rows.map((row) =>
              row.map((cell) =>
                typeof cell === "number"
                  ? { type: "raw_number", value: cell, text: String(cell) }
                  : { type: "raw_text", text: cell },
              ),
            ),
          ],
        };
        if (pageSize) table.page_size = pageSize;
        return postOrUpdate(
          config,
          { channelId, text: caption, blocks: [table], threadTs, updateTs },
          context,
        );
      },
    }),

    tool({
      name: "slack_post_plan",
      label: "Post Slack plan",
      description:
        "Post a checklist of steps to Slack as a native plan block with per-task status indicators. Use for multi-step work instead of a bullet list. Re-post with `updateTs` as steps complete so one card stays current.",
      parameters: Type.Object({
        ...targetParams,
        title: Type.String({ description: "Plan title, plain text." }),
        tasks: Type.Array(
          Type.Object({
            title: Type.String({ description: "What this step does." }),
            status: Type.Union(
              [
                Type.Literal("in_progress"),
                Type.Literal("complete"),
                Type.Literal("error"),
              ],
              { description: "Step state." },
            ),
            details: Type.Optional(Type.String({ description: "What the step is doing." })),
            output: Type.Optional(Type.String({ description: "What the step produced." })),
          }),
          { minItems: 1, maxItems: 50, description: "Steps in order." },
        ),
      }),
      outputSchema: postResultSchema,
      async execute({ channelId, title, tasks, threadTs, updateTs }, config, context) {
        context.signal?.throwIfAborted();
        // Slack wants a fresh block_id on every revision of a message.
        const revision = Date.now().toString(36);
        const plan = {
          type: "plan",
          block_id: `plan_${revision}`,
          title,
          tasks: tasks.map((task, index) => ({
            task_id: `task_${index + 1}`,
            title: task.title,
            status: task.status,
            ...(task.details ? { details: richText(task.details) } : {}),
            ...(task.output ? { output: richText(task.output) } : {}),
          })),
        };
        const done = tasks.filter((task) => task.status === "complete").length;
        return postOrUpdate(
          config,
          {
            channelId,
            text: `${title} — ${done}/${tasks.length} complete`,
            blocks: [plan],
            threadTs,
            updateTs,
          },
          context,
        );
      },
    }),

    tool({
      name: "slack_post_chart",
      label: "Post Slack chart",
      description:
        "Post a native Slack chart (pie, bar, line, or area). Use instead of describing numbers in prose or generating a chart image. Max 2 charts per message.",
      parameters: Type.Object({
        ...targetParams,
        title: Type.String({ description: "Chart title. Max 50 characters." }),
        chartType: Type.Union(
          [
            Type.Literal("pie"),
            Type.Literal("bar"),
            Type.Literal("line"),
            Type.Literal("area"),
          ],
          { description: "Chart style." },
        ),
        segments: Type.Optional(
          Type.Array(
            Type.Object({
              label: Type.String({ description: "Slice label. Max 20 characters." }),
              value: Type.Number(),
            }),
            { minItems: 1, maxItems: 12, description: "Pie slices. Required when chartType is pie." },
          ),
        ),
        categories: Type.Optional(
          Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 20,
            description:
              "X-axis labels, left to right. Required for bar, line, and area. Max 20 characters each.",
          }),
        ),
        series: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ description: "Legend name. Max 20 characters, unique." }),
              values: Type.Array(Type.Number(), {
                description: "One value per entry in `categories`, same order.",
              }),
            }),
            { minItems: 1, maxItems: 12, description: "Required for bar, line, and area." },
          ),
        ),
        xLabel: Type.Optional(Type.String({ description: "X-axis title." })),
        yLabel: Type.Optional(Type.String({ description: "Y-axis title." })),
      }),
      outputSchema: postResultSchema,
      async execute(args, config, context) {
        context.signal?.throwIfAborted();
        const { channelId, title, chartType, segments, categories, series, xLabel, yLabel } = args;
        let chart: Record<string, unknown>;

        if (chartType === "pie") {
          if (!segments?.length) throw new Error("A pie chart requires `segments`.");
          chart = { type: "pie", segments };
        } else {
          if (!categories?.length || !series?.length) {
            throw new Error(`A ${chartType} chart requires both \`categories\` and \`series\`.`);
          }
          const mismatch = series.find((entry) => entry.values.length !== categories.length);
          if (mismatch) {
            throw new Error(
              `Series "${mismatch.name}" has ${mismatch.values.length} values but there are ${categories.length} categories. Slack requires exactly one value per category.`,
            );
          }
          chart = {
            type: chartType,
            series: series.map((entry) => ({
              name: entry.name,
              data: entry.values.map((value, index) => ({ label: categories[index], value })),
            })),
            axis_config: {
              categories,
              ...(xLabel ? { x_label: xLabel } : {}),
              ...(yLabel ? { y_label: yLabel } : {}),
            },
          };
        }

        return postOrUpdate(
          config,
          {
            channelId,
            text: title,
            blocks: [{ type: "data_visualization", title, chart }],
            threadTs: args.threadTs,
            updateTs: args.updateTs,
          },
          context,
        );
      },
    }),

    tool({
      name: "slack_blocks_send",
      label: "Send Slack Block Kit message",
      description:
        "Post a message built from raw Slack Block Kit blocks. Use when the layout needs block types OpenClaw's portable `presentation` cannot express — headers, rich_text, tables, images, button rows, carousels, alerts. Always set `text` as the notification fallback.",
      parameters: Type.Object({
        channelId: Type.String({
          description: "Channel or DM ID, e.g. C0C42LZQZGQ or D0B9DMSCL58.",
        }),
        text: Type.String({
          description:
            "Plain-text fallback used in notifications and by screen readers. Required by Slack; summarize the blocks.",
        }),
        blocks: blocksSchema,
        threadTs: Type.Optional(
          Type.String({ description: "Post as a reply to this message timestamp." }),
        ),
        replyBroadcast: Type.Optional(
          Type.Boolean({
            description: "With threadTs, also surface the reply in the parent channel.",
          }),
        ),
      }),
      outputSchema: Type.Object(
        { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number() },
        { additionalProperties: false },
      ),
      async execute({ channelId, text, blocks, threadTs, replyBroadcast }, config, context) {
        context.signal?.throwIfAborted();
        const body: Record<string, unknown> = { channel: channelId, text, blocks };
        if (threadTs) body.thread_ts = threadTs;
        if (replyBroadcast) body.reply_broadcast = true;
        const data = await callSlack(
          "chat.postMessage",
          resolveToken(config, "bot"),
          body,
          context,
        );
        return { channelId, ts: String(data.ts ?? ""), blockCount: blocks.length };
      },
    }),

    tool({
      name: "slack_blocks_update",
      label: "Update Slack Block Kit message",
      description:
        "Replace the blocks of a message this app posted. Use to keep one card current — a build status, a running checklist — instead of posting a new message each time.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel or DM ID the message lives in." }),
        ts: Type.String({ description: "Message timestamp from slack_blocks_send." }),
        text: Type.String({ description: "Updated plain-text notification fallback." }),
        blocks: blocksSchema,
      }),
      outputSchema: Type.Object(
        { channelId: Type.String(), ts: Type.String(), blockCount: Type.Number() },
        { additionalProperties: false },
      ),
      async execute({ channelId, ts, text, blocks }, config, context) {
        context.signal?.throwIfAborted();
        const data = await callSlack(
          "chat.update",
          resolveToken(config, "bot"),
          { channel: channelId, ts, text, blocks },
          context,
        );
        return { channelId, ts: String(data.ts ?? ts), blockCount: blocks.length };
      },
    }),

    tool({
      name: "slack_canvas_create",
      label: "Create Slack canvas",
      description:
        "Create a Slack canvas from markdown. Optionally share it to a channel with read or write access.",
      parameters: Type.Object({
        title: Type.String({ description: "Canvas title." }),
        markdown: Type.String({
          description: "Canvas body as markdown. Supports headings, lists, checklists, tables, code.",
        }),
        channelId: Type.Optional(
          Type.String({ description: "Channel ID to share the canvas with, e.g. C0C42LZQZGQ." }),
        ),
        accessLevel: Type.Optional(
          Type.Union([Type.Literal("read"), Type.Literal("write")], {
            description: "Channel access level when channelId is set. Default: write.",
          }),
        ),
      }),
      outputSchema: Type.Object(
        {
          canvasId: Type.String(),
          url: Type.String(),
          sharedWith: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      async execute({ title, markdown, channelId, accessLevel }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);
        const created = await callSlack(
          "canvases.create",
          token,
          {
            title,
            document_content: { type: "markdown", markdown },
          },
          context,
        );
        const canvasId = String(created.canvas_id ?? "");
        if (channelId) {
          await callSlack(
            "canvases.access.set",
            token,
            {
              canvas_id: canvasId,
              channel_ids: [channelId],
              access_level: accessLevel ?? "write",
            },
            context,
          );
        }
        return { canvasId, url: canvasUrl(canvasId), sharedWith: channelId ?? null };
      },
    }),

    tool({
      name: "slack_canvas_edit",
      label: "Edit Slack canvas",
      description:
        "Edit a Slack canvas: append markdown, prepend it, replace the whole body, or rename the canvas.",
      parameters: Type.Object({
        canvasId: Type.String({ description: "Canvas ID, e.g. F0166DCSTS7." }),
        operation: Type.Union(
          [
            Type.Literal("append"),
            Type.Literal("prepend"),
            Type.Literal("replace"),
            Type.Literal("rename"),
          ],
          { description: "Edit to perform." },
        ),
        markdown: Type.Optional(
          Type.String({ description: "Markdown content for append, prepend, or replace." }),
        ),
        title: Type.Optional(Type.String({ description: "New title when operation is rename." })),
        sectionId: Type.Optional(
          Type.String({ description: "Section ID to target when replacing one section." }),
        ),
      }),
      outputSchema: Type.Object(
        { canvasId: Type.String(), operation: Type.String(), url: Type.String() },
        { additionalProperties: false },
      ),
      async execute({ canvasId, operation, markdown, title, sectionId }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);

        if (operation === "rename") {
          if (!title) throw new Error("rename requires title.");
          await callSlack(
            "canvases.edit",
            token,
            { canvas_id: canvasId, changes: [{ operation: "rename", title_content: title }] },
            context,
          );
          return { canvasId, operation, url: canvasUrl(canvasId) };
        }

        if (!markdown) throw new Error(`${operation} requires markdown.`);
        const slackOperation =
          operation === "append"
            ? "insert_at_end"
            : operation === "prepend"
              ? "insert_at_start"
              : "replace";
        const change: Record<string, unknown> = {
          operation: slackOperation,
          document_content: { type: "markdown", markdown },
        };
        if (slackOperation === "replace" && sectionId) change.section_id = sectionId;

        await callSlack(
          "canvases.edit",
          token,
          { canvas_id: canvasId, changes: [change] },
          context,
        );
        return { canvasId, operation, url: canvasUrl(canvasId) };
      },
    }),

    tool({
      name: "slack_canvas_sections",
      label: "Look up Slack canvas sections",
      description:
        "List sections of a canvas, optionally filtered by heading level, to get section IDs for targeted edits.",
      parameters: Type.Object({
        canvasId: Type.String({ description: "Canvas ID." }),
        containsText: Type.Optional(
          Type.String({ description: "Only return sections containing this text." }),
        ),
      }),
      async execute({ canvasId, containsText }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);
        const criteria: Record<string, unknown> = {};
        if (containsText) criteria.contains_text = containsText;
        const data = await callSlack(
          "canvases.sections.lookup",
          token,
          { canvas_id: canvasId, criteria },
          context,
        );
        return { sections: data.sections ?? [] };
      },
    }),

    tool({
      name: "slack_bookmark_list",
      label: "List Slack bookmarks",
      description: "List the bookmarks pinned to a Slack channel.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel ID, e.g. C0C42LZQZGQ." }),
      }),
      async execute({ channelId }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);
        const data = await callSlack(
          "bookmarks.list",
          token,
          { channel_id: channelId },
          context,
        );
        return { bookmarks: data.bookmarks ?? [] };
      },
    }),

    tool({
      name: "slack_bookmark_add",
      label: "Add Slack bookmark",
      description: "Add a link bookmark to a Slack channel. Channels are limited to 100 bookmarks.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel ID." }),
        title: Type.String({ description: "Bookmark title." }),
        link: Type.String({ description: "Bookmark URL." }),
        emoji: Type.Optional(Type.String({ description: "Emoji shortcode, e.g. :books:." })),
      }),
      async execute({ channelId, title, link, emoji }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);
        const body: Record<string, unknown> = {
          channel_id: channelId,
          title,
          type: "link",
          link,
        };
        if (emoji) body.emoji = emoji;
        const data = await callSlack("bookmarks.add", token, body, context);
        return { bookmark: data.bookmark ?? null };
      },
    }),

    tool({
      name: "slack_bookmark_remove",
      label: "Remove Slack bookmark",
      description: "Remove a bookmark from a Slack channel.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Channel ID." }),
        bookmarkId: Type.String({ description: "Bookmark ID from slack_bookmark_list." }),
      }),
      async execute({ channelId, bookmarkId }, config, context) {
        context.signal?.throwIfAborted();
        const token = resolveToken(config);
        await callSlack(
          "bookmarks.remove",
          token,
          { channel_id: channelId, bookmark_id: bookmarkId },
          context,
        );
        return { removed: true, bookmarkId };
      },
    }),
  ],
});
