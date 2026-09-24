const SLACK_API = "https://slack.com/api";

export type SlackResponse = Record<string, unknown> & { ok?: boolean; error?: string };

export type PluginConfig = {
  botToken?: string | { id?: string };
  userToken?: string | { id?: string };
  /** Join a public channel and retry when a bot-token call hits `not_in_channel`. Default true. */
  autoJoin?: boolean;
  /** Channel IDs never to auto-join. */
  autoJoinDeny?: string[];
};

/**
 * Slack splits its API across two token types. Bot tokens (xoxb-) act as the app;
 * user tokens (xoxp-) act as Steve. Methods like search.* and reminders.* reject
 * bot tokens outright with `not_allowed_token_type`, so each tool declares which
 * identity it needs rather than hoping one token covers everything.
 *
 * A token whose prefix doesn't match `kind` (say, a user token pasted into `botToken`)
 * only warns: Slack could change its prefixes, and a hard failure here would break a
 * working setup. Without the warning, the mistake surfaces later as an opaque Slack error.
 */
export function resolveToken(
  config: PluginConfig,
  kind: "bot" | "user" = "bot",
  warn: (message: string) => void = console.warn,
): string {
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
  const expected = TOKEN_PREFIXES[kind];
  if (!token.startsWith(expected) && !warnedTokens.has(token)) {
    warnedTokens.add(token);
    const source = configured?.trim()
      ? `plugins.entries.slack-workspace.config.${field}`
      : envVar;
    // Only echo a recognizable Slack prefix; anything else could be part of the secret.
    const actual = /^xox[a-z]-/.exec(token)?.[0];
    warn(
      `slack-workspace: the Slack ${kind} token ${actual ? `starts with ${actual}` : "has an unrecognized prefix"}, but ${kind} tokens start with ${expected}. Check ${source}.`,
    );
  }
  return token;
}

const TOKEN_PREFIXES = { bot: "xoxb-", user: "xoxp-" } as const;

/** Tokens already warned about, so a misconfiguration warns once rather than per call. */
const warnedTokens = new Set<string>();

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Per-tool-call auto-join state: the plugin config, and the channels joined so far. */
export type AutoJoinState = { config: PluginConfig; joined: Set<string> };

/** The slice of the tool execution context the Slack client needs. */
export type SlackCallContext = {
  signal?: AbortSignal;
  api?: { logger?: PluginLogger };
  /** Set by the tool runner; without it, `not_in_channel` is never auto-joined. */
  autoJoin?: AutoJoinState;
};

/** A Slack API error, keeping Slack's bare error code alongside the readable message. */
export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

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
  not_in_channel:
    "the bot is not a member of this channel: join a public channel with slack_channel_join, or have someone `/invite @OpenClaw`",
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
 *
 * A bot-token call that fails with `not_in_channel` joins the channel and retries once,
 * when `context.autoJoin` allows it (see `autoJoinTarget`). Only public channels are
 * joined; the retry never joins again, so there are no join loops.
 */
export async function callSlackRaw(
  method: string,
  token: string,
  body: Record<string, unknown>,
  context: SlackCallContext = {},
  form = false,
): Promise<{ data: SlackResponse; scopes: string[] }> {
  try {
    return await callSlackOnce(method, token, body, context, form);
  } catch (error) {
    const channelId = autoJoinTarget(error, method, token, body, context);
    if (!channelId) throw error;
    try {
      await joinPublicChannel(channelId, token, context);
    } catch (joinError) {
      context.signal?.throwIfAborted();
      throw new Error(
        `${(error as Error).message}. Could not auto-join: ${(joinError as Error).message}`,
        { cause: joinError },
      );
    }
    context.autoJoin!.joined.add(channelId);
    context.api?.logger?.info(`slack-workspace: auto-joined ${channelId}; retrying ${method}`);
    try {
      return await callSlackOnce(method, token, body, context, form);
    } catch (retryError) {
      context.signal?.throwIfAborted();
      throw new Error(
        `${(retryError as Error).message} (the bot auto-joined ${channelId} before retrying)`,
        { cause: retryError },
      );
    }
  }
}

const MEMBERSHIP_METHODS = new Set(["conversations.join", "conversations.leave"]);

/** The channel to auto-join for this failed call, or undefined when auto-join doesn't apply. */
function autoJoinTarget(
  error: unknown,
  method: string,
  token: string,
  body: Record<string, unknown>,
  context: SlackCallContext,
): string | undefined {
  const state = context.autoJoin;
  if (!state || state.config.autoJoin === false) return undefined;
  if (!(error instanceof SlackApiError) || error.code !== "not_in_channel") return undefined;
  if (MEMBERSHIP_METHODS.has(method)) return undefined;
  const channel = body.channel ?? body.channel_id;
  if (typeof channel !== "string" || !channel) return undefined;
  if (state.config.autoJoinDeny?.includes(channel)) return undefined;
  // Auto-join acts as the app; a user token's membership is the human's business.
  let botToken: string;
  try {
    botToken = resolveToken(state.config, "bot", () => {});
  } catch {
    return undefined;
  }
  return token === botToken ? channel : undefined;
}

const inviteNeeded = (channelId: string, why: string) =>
  new Error(
    `Channel ${channelId} ${why}, so the bot cannot join it on its own: the bot must be invited (\`/invite @OpenClaw\`).`,
  );

/**
 * Join a public channel with the bot token. Checks `conversations.info` first and
 * refuses private channels, DMs, and group DMs (they need an invite) and archived
 * channels, before `conversations.join` is ever called.
 */
export async function joinPublicChannel(
  channelId: string,
  token: string,
  context: SlackCallContext = {},
): Promise<{ channel: Record<string, unknown>; alreadyMember: boolean }> {
  let channel: Record<string, unknown>;
  try {
    const { data } = await callSlackOnce(
      "conversations.info",
      token,
      { channel: channelId },
      context,
      true,
    );
    channel = (data.channel ?? {}) as Record<string, unknown>;
  } catch (error) {
    // A private channel the bot isn't in is invisible to it, or needs a `groups:*` scope.
    const hidden =
      error instanceof SlackApiError &&
      (error.code === "channel_not_found" || /needs scope: groups:/.test(error.message));
    if (hidden) {
      throw inviteNeeded(channelId, "is not visible to the bot (it may be private)");
    }
    throw error;
  }
  if (channel.is_im === true || channel.is_mpim === true) {
    throw inviteNeeded(channelId, "is a direct message");
  }
  if (channel.is_private === true) throw inviteNeeded(channelId, "is a private channel");
  if (channel.is_archived === true) {
    throw new Error(`Channel ${channelId} is archived; unarchive it before joining.`);
  }
  let data: SlackResponse;
  try {
    ({ data } = await callSlackOnce("conversations.join", token, { channel: channelId }, context));
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "missing_scope") {
      throw new Error(
        `${error.message}. Joining channels needs the bot scope \`channels:join\`, which this Slack app has not been granted yet: add it to the app manifest and reinstall (roadmap O-12).`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    channel: (data.channel ?? channel) as Record<string, unknown>,
    alreadyMember: data.warning === "already_in_channel",
  };
}

async function callSlackOnce(
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
      throw new SlackApiError(`Slack ${method} failed: ${error}${hint}`, error);
    }

    log("ok");
    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return { data, scopes };
  }
}

export async function callSlack(
  method: string,
  token: string,
  body: Record<string, unknown>,
  context?: SlackCallContext,
  form = false,
): Promise<SlackResponse> {
  return (await callSlackRaw(method, token, body, context, form)).data;
}

/**
 * Who a token authenticates as, plus the scopes Slack reports it was granted. Read-only:
 * `auth.test` changes nothing, so it is safe for diagnostics like the doctor command.
 */
export async function authTest(
  token: string,
  context?: SlackCallContext,
): Promise<{ data: SlackResponse; scopes: string[] }> {
  const result = await callSlackRaw("auth.test", token, {}, context);
  const workspace = workspaceFromAuthTest(result.data);
  if (workspace) workspaces.set(token, Promise.resolve(workspace));
  return result;
}

/** The workspace a token belongs to: its web origin and team id. */
export type Workspace = { origin: string; teamId: string };

/** One `auth.test` per token per process; `slack_identity` primes this too. */
const workspaces = new Map<string, Promise<Workspace | null>>();

function workspaceFromAuthTest(data: SlackResponse): Workspace | null {
  if (typeof data.url !== "string" || typeof data.team_id !== "string") return null;
  try {
    return { origin: new URL(data.url).origin, teamId: data.team_id };
  } catch {
    return null;
  }
}

/**
 * The token's workspace, from a cached `auth.test`. Resolves to null rather than
 * throwing when the lookup fails, and forgets the failure so the next call retries.
 */
export function workspaceFor(token: string, context?: SlackCallContext): Promise<Workspace | null> {
  const cached = workspaces.get(token);
  if (cached) return cached;
  const lookup = callSlackRaw("auth.test", token, {}, context).then(
    ({ data }) => workspaceFromAuthTest(data),
    () => null,
  );
  workspaces.set(token, lookup);
  void lookup.then((workspace) => {
    if (!workspace && workspaces.get(token) === lookup) workspaces.delete(token);
  });
  return lookup;
}

/** Test hook: forget every cached workspace. */
export function resetWorkspaceCache(): void {
  workspaces.clear();
}

/**
 * Canvas permalinks are workspace-scoped: `https://<workspace>.slack.com/docs/<team id>/<canvas id>`.
 * `canvases.create` returns only `canvas_id`, so the URL has to be built here.
 */
export function canvasPermalink(workspace: Workspace, canvasId: string): string {
  return `${workspace.origin}/docs/${workspace.teamId}/${canvasId}`;
}
