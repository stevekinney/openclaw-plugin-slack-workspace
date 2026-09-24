const SLACK_API = "https://slack.com/api";

export type SlackResponse = Record<string, unknown> & { ok?: boolean; error?: string };

export type PluginConfig = {
  botToken?: string | { id?: string };
  userToken?: string | { id?: string };
};

/**
 * Slack splits its API across two token types. Bot tokens (xoxb-) act as the app;
 * user tokens (xoxp-) act as Steve. Methods like search.* and reminders.* reject
 * bot tokens outright with `not_allowed_token_type`, so each tool declares which
 * identity it needs rather than hoping one token covers everything.
 */
export function resolveToken(config: PluginConfig, kind: "bot" | "user" = "bot"): string {
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
export type SlackCallContext = { signal?: AbortSignal; api?: { logger?: PluginLogger } };

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
export async function callSlackRaw(
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
export function authTest(
  token: string,
  context?: SlackCallContext,
): Promise<{ data: SlackResponse; scopes: string[] }> {
  return callSlackRaw("auth.test", token, {}, context);
}
