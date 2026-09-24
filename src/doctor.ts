import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authTest, resolveToken, type PluginConfig, type SlackCallContext } from "./client.js";

type TokenKind = "bot" | "user";

/**
 * The token each tool calls Slack with and the OAuth scopes its methods need, per
 * docs.slack.dev. A test keeps this map in step with the registered tools.
 */
export const TOOL_SCOPES: Record<string, { token: TokenKind | "none"; scopes: string[] }> = {
  // auth.test needs no scope.
  slack_identity: { token: "bot", scopes: [] },
  slack_search: { token: "user", scopes: ["search:read"] },
  slack_schedule_message: { token: "bot", scopes: ["chat:write"] },
  slack_schedule_reschedule: { token: "bot", scopes: ["chat:write"] },
  // conversations.open finds or opens the DM when reminding a user.
  slack_remind: { token: "bot", scopes: ["im:write", "chat:write"] },
  // chat.scheduledMessages.list needs no scope.
  slack_scheduled_list: { token: "bot", scopes: [] },
  slack_scheduled_cancel: { token: "bot", scopes: ["chat:write"] },
  slack_post_table: { token: "bot", scopes: ["chat:write"] },
  slack_post_plan: { token: "bot", scopes: ["chat:write"] },
  slack_post_chart: { token: "bot", scopes: ["chat:write"] },
  slack_post_rich_text: { token: "bot", scopes: ["chat:write"] },
  slack_blocks_send: { token: "bot", scopes: ["chat:write"] },
  slack_blocks_update: { token: "bot", scopes: ["chat:write"] },
  // groups:/im:/mpim:history stand in for channels:history on private channels and DMs.
  slack_message_get: { token: "bot", scopes: ["channels:history", "metadata.message:read"] },
  slack_post_ephemeral: { token: "bot", scopes: ["chat:write"] },
  slack_canvas_create: { token: "bot", scopes: ["canvases:write"] },
  slack_canvas_edit: { token: "bot", scopes: ["canvases:write"] },
  slack_canvas_sections: { token: "bot", scopes: ["canvases:read"] },
  slack_canvas_list: { token: "bot", scopes: ["files:read"] },
  slack_canvas_access_set: { token: "bot", scopes: ["canvases:write"] },
  slack_canvas_access_delete: { token: "bot", scopes: ["canvases:write"] },
  slack_canvas_delete: { token: "bot", scopes: ["canvases:write"] },
  slack_canvas_channel_get_or_create: { token: "bot", scopes: ["channels:read", "canvases:write"] },
  slack_canvas_status_update: {
    token: "bot",
    scopes: ["channels:read", "canvases:read", "canvases:write"],
  },
  // groups:/im:/mpim:history stand in for channels:history on private channels and DMs.
  slack_canvas_from_thread: { token: "bot", scopes: ["channels:history", "canvases:write"] },
  slack_bookmark_list: { token: "bot", scopes: ["bookmarks:read"] },
  slack_bookmark_add: { token: "bot", scopes: ["bookmarks:write"] },
  slack_bookmark_edit: { token: "bot", scopes: ["bookmarks:write"] },
  slack_bookmark_remove: { token: "bot", scopes: ["bookmarks:write"] },
  slack_channel_create: { token: "bot", scopes: ["channels:manage"] },
  // Every channel tool but create reads conversations.info first to refuse private channels.
  slack_channel_archive: { token: "bot", scopes: ["channels:read", "channels:manage"] },
  slack_channel_rename: { token: "bot", scopes: ["channels:read", "channels:manage"] },
  slack_channel_set_topic: { token: "bot", scopes: ["channels:read", "channels:write.topic"] },
  slack_channel_set_purpose: { token: "bot", scopes: ["channels:read", "channels:manage"] },
  slack_channel_invite: { token: "bot", scopes: ["channels:read", "channels:write.invites"] },
  // channels:join is not granted until O-12; any tool can also auto-join with it.
  slack_channel_join: { token: "bot", scopes: ["channels:read", "channels:join"] },
  slack_channel_leave: { token: "bot", scopes: ["channels:read", "channels:manage"] },
  // Creates the channel itself, so it skips the conversations.info check.
  slack_channel_kickoff: {
    token: "bot",
    scopes: [
      "channels:manage",
      "channels:write.topic",
      "channels:write.invites",
      "canvases:write",
      "bookmarks:write",
    ],
  },
  slack_list_create: { token: "bot", scopes: ["lists:write"] },
  slack_list_schema: { token: "bot", scopes: ["lists:read"] },
  // Create and update read the schema first to resolve column names.
  slack_list_item_create: { token: "bot", scopes: ["lists:read", "lists:write"] },
  slack_list_item_update: { token: "bot", scopes: ["lists:read", "lists:write"] },
  slack_list_item_delete: { token: "bot", scopes: ["lists:write"] },
  slack_list_items_delete_multiple: { token: "bot", scopes: ["lists:write"] },
  slack_list_items_list: { token: "bot", scopes: ["lists:read"] },
  slack_list_item_info: { token: "bot", scopes: ["lists:read"] },
  slack_list_access_set: { token: "bot", scopes: ["lists:write"] },
  slack_list_access_delete: { token: "bot", scopes: ["lists:write"] },
  // lists:read resolves an existing list's columns; groups:/im:/mpim:history as for canvases.
  slack_list_from_thread: { token: "bot", scopes: ["channels:history", "lists:read", "lists:write"] },
  slack_file_upload: { token: "bot", scopes: ["files:write"] },
  slack_assistant_set_title: { token: "bot", scopes: ["assistant:write"] },
  slack_assistant_suggest_prompts: { token: "bot", scopes: ["assistant:write"] },
  // POSTs to a configured webhook URL; the URL is the credential, not a Slack token.
  slack_workflow_trigger_run: { token: "none", scopes: [] },
  slack_usergroup_list: { token: "bot", scopes: ["usergroups:read"] },
  slack_usergroup_members: { token: "bot", scopes: ["usergroups:read"] },
  // files.remote.* rejects user tokens.
  slack_remote_file_add: { token: "bot", scopes: ["remote_files:write"] },
  slack_remote_file_update: { token: "bot", scopes: ["remote_files:write"] },
  slack_remote_file_remove: { token: "bot", scopes: ["remote_files:write"] },
  slack_remote_file_share: { token: "bot", scopes: ["remote_files:share"] },
};

export type TokenAudit = {
  kind: TokenKind;
  /** `unavailable`: no usable token configured. `error`: Slack rejected `auth.test`. */
  status: "ok" | "missing_scopes" | "unavailable" | "error";
  error?: string;
  team: string | null;
  identity: string | null;
  granted: string[];
  required: string[];
  missing: string[];
  /** Tools that will fail with `missing_scope`, and which of their scopes are absent. */
  affectedTools: { tool: string; missing: string[] }[];
};

export type DoctorReport = { ok: boolean; tokens: TokenAudit[] };

async function auditToken(
  config: PluginConfig,
  kind: TokenKind,
  context?: SlackCallContext,
): Promise<TokenAudit> {
  const tools = Object.entries(TOOL_SCOPES).filter(([, needs]) => needs.token === kind);
  const required = [...new Set(tools.flatMap(([, needs]) => needs.scopes))].sort();
  const base = { kind, team: null, identity: null, granted: [], required, missing: required };
  const affectedTools = (granted: Set<string>) =>
    tools.flatMap(([tool, needs]) => {
      const missing = needs.scopes.filter((scope) => !granted.has(scope));
      return missing.length ? [{ tool, missing }] : [];
    });

  let token: string;
  try {
    token = resolveToken(config, kind);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      status: "unavailable",
      error: message,
      affectedTools: affectedTools(new Set()),
    };
  }

  try {
    const { data, scopes } = await authTest(token, context);
    const granted = new Set(scopes);
    const missing = required.filter((scope) => !granted.has(scope));
    return {
      ...base,
      status: missing.length ? "missing_scopes" : "ok",
      team: typeof data.team === "string" ? data.team : null,
      identity: typeof data.user === "string" ? data.user : null,
      granted: scopes,
      missing,
      affectedTools: affectedTools(granted),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, status: "error", error: message, affectedTools: affectedTools(new Set()) };
  }
}

/**
 * Diff each configured token's granted scopes (from the read-only `auth.test`) against
 * what this plugin's tools need. Catches an app whose manifest gained scopes but was
 * never reinstalled, before a tool call fails mid-task.
 */
export async function auditScopes(
  config: PluginConfig,
  context?: SlackCallContext,
): Promise<DoctorReport> {
  const tokens = [
    await auditToken(config, "bot", context),
    await auditToken(config, "user", context),
  ];
  return { ok: tokens.every((token) => token.status === "ok"), tokens };
}

const list = (scopes: string[]) => (scopes.length ? scopes.join(", ") : "(none)");

/** Human-readable doctor output. Never includes token values. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["slack-workspace doctor", ""];
  for (const token of report.tokens) {
    const label = token.kind === "bot" ? "Bot token" : "User token";
    const who = token.team ? ` — ${token.identity ?? "unknown"} in ${token.team}` : "";
    lines.push(`${label}${who}`);
    if (token.error)
      lines.push(`  ${token.status === "error" ? "ERROR" : "UNAVAILABLE"}: ${token.error}`);
    else lines.push(`  Granted:  ${list(token.granted)}`);
    lines.push(`  Required: ${list(token.required)}`);
    if (token.status === "ok") {
      lines.push("  All required scopes granted.");
    } else {
      for (const scope of token.missing) {
        const tools = token.affectedTools
          .filter((entry) => entry.missing.includes(scope))
          .map((entry) => entry.tool);
        lines.push(`  MISSING ${scope} — needed by ${tools.join(", ")}`);
      }
    }
    lines.push("");
  }
  lines.push(
    report.ok
      ? "OK: every tool has the scopes it needs."
      : "Problems found. Configure any unavailable token; add missing scopes to the Slack app and reinstall it. Then re-run this check.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `openclaw slack-workspace doctor [--json]`. Exits non-zero when any token is missing
 * a scope, is unavailable, or is rejected, so it can gate scripts.
 */
export function registerDoctorCli(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as PluginConfig;
  api.registerCli(
    ({ program, logger }) => {
      program
        .command("slack-workspace")
        .description("Slack Workspace plugin utilities")
        .command("doctor")
        .description("Compare the bot and user tokens' granted scopes against what each tool needs")
        .option("--json", "Print the report as JSON")
        .action(async (options: { json?: boolean }) => {
          const report = await auditScopes(config, { api: { logger } });
          process.stdout.write(
            options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
          );
          if (!report.ok) process.exitCode = 1;
        });
    },
    {
      descriptors: [
        {
          name: "slack-workspace",
          description: "Slack Workspace plugin utilities",
          hasSubcommands: true,
        },
      ],
    },
  );
}
