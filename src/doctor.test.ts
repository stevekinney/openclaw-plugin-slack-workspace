import { describe, expect, it, vi } from "vitest";
import { auditScopes, formatDoctorReport, TOOL_SCOPES } from "./doctor.js";
import {
  recordingLogger,
  registerPlugin,
  slackResponse,
  TEST_CONFIG,
  withMockFetch,
  type RecordedCall,
} from "./test-utils.js";

const BOT_SCOPES = [
  "chat:write",
  "canvases:read",
  "canvases:write",
  "bookmarks:read",
  "bookmarks:write",
  "channels:read",
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:write.topic",
  "channels:write.invites",
];
const USER_SCOPES = ["search:read"];

/** Answer `auth.test` per token, the way Slack reports scopes: in `x-oauth-scopes`. */
const authTest =
  (scopes: { bot: string[]; user: string[] }) =>
  ({ method, headers }: RecordedCall) => {
    expect(method).toBe("auth.test");
    const kind = headers.authorization === "Bearer xoxb-test" ? "bot" : "user";
    return slackResponse(
      { ok: true, team: "Test Team", user: `test-${kind}`, user_id: `U0${kind.toUpperCase()}` },
      { headers: { "x-oauth-scopes": scopes[kind].join(",") } },
    );
  };

describe("TOOL_SCOPES", () => {
  it("declares the token and scopes for every registered tool", () => {
    const names = registerPlugin().tools.map((tool) => tool.name);
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...names].sort());
  });
});

describe("auditScopes", () => {
  it("reports no gaps when both tokens carry every required scope", async () => {
    await withMockFetch(authTest({ bot: BOT_SCOPES, user: USER_SCOPES }), async (calls) => {
      const report = await auditScopes(TEST_CONFIG);
      expect(report.ok).toBe(true);
      expect(report.tokens.map((token) => [token.kind, token.status, token.missing])).toEqual([
        ["bot", "ok", []],
        ["user", "ok", []],
      ]);
      expect(report.tokens[0]).toMatchObject({
        team: "Test Team",
        identity: "test-bot",
        granted: BOT_SCOPES,
        required: [
          "bookmarks:read",
          "bookmarks:write",
          "canvases:read",
          "canvases:write",
          "channels:history",
          "channels:join",
          "channels:manage",
          "channels:read",
          "channels:write.invites",
          "channels:write.topic",
          "chat:write",
        ],
      });
      // Only the read-only auth.test, once per token.
      expect(calls.map((call) => call.method)).toEqual(["auth.test", "auth.test"]);
    });
  });

  it("flags each missing scope with the tools it breaks", async () => {
    const bot = BOT_SCOPES.filter((scope) => scope !== "canvases:write");
    await withMockFetch(authTest({ bot, user: [] }), async () => {
      const report = await auditScopes(TEST_CONFIG);
      expect(report.ok).toBe(false);
      const [botAudit, userAudit] = report.tokens;
      expect(botAudit).toMatchObject({ status: "missing_scopes", missing: ["canvases:write"] });
      expect(botAudit.affectedTools).toEqual([
        { tool: "slack_canvas_create", missing: ["canvases:write"] },
        { tool: "slack_canvas_edit", missing: ["canvases:write"] },
        { tool: "slack_canvas_access_set", missing: ["canvases:write"] },
        { tool: "slack_canvas_access_delete", missing: ["canvases:write"] },
        { tool: "slack_canvas_delete", missing: ["canvases:write"] },
        { tool: "slack_canvas_channel_get_or_create", missing: ["canvases:write"] },
        { tool: "slack_canvas_status_update", missing: ["canvases:write"] },
        { tool: "slack_canvas_from_thread", missing: ["canvases:write"] },
        { tool: "slack_channel_kickoff", missing: ["canvases:write"] },
      ]);
      expect(userAudit).toMatchObject({ status: "missing_scopes", missing: ["search:read"] });
      expect(userAudit.affectedTools).toEqual([{ tool: "slack_search", missing: ["search:read"] }]);
    });
  });

  it("reports an unconfigured token without calling Slack for it", async () => {
    const saved = process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_USER_TOKEN;
    try {
      await withMockFetch(authTest({ bot: BOT_SCOPES, user: [] }), async (calls) => {
        const report = await auditScopes({ botToken: "xoxb-test" });
        expect(report.ok).toBe(false);
        expect(report.tokens[1]).toMatchObject({ kind: "user", status: "unavailable" });
        expect(report.tokens[1].error).toContain("No Slack user token");
        expect(calls).toHaveLength(1);
      });
    } finally {
      if (saved !== undefined) process.env.SLACK_USER_TOKEN = saved;
    }
  });

  it("reports a rejected token as an error instead of throwing", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "invalid_auth" }),
      async () => {
        const report = await auditScopes(TEST_CONFIG);
        expect(report.tokens.map((token) => token.status)).toEqual(["error", "error"]);
        expect(report.tokens[0].error).toContain("invalid_auth");
      },
    );
  });
});

describe("formatDoctorReport", () => {
  it("prints granted vs. required scopes per token and flags gaps", async () => {
    await withMockFetch(authTest({ bot: ["chat:write"], user: USER_SCOPES }), async () => {
      const text = formatDoctorReport(await auditScopes(TEST_CONFIG));
      expect(text).toContain("Bot token");
      expect(text).toContain("Granted:  chat:write");
      expect(text).toContain("MISSING bookmarks:read — needed by slack_bookmark_list");
      expect(text).toContain("User token");
      expect(text).toContain("All required scopes granted.");
      expect(text).not.toContain("xoxb-test");
      expect(text).not.toContain("xoxp-test");
    });
  });
});

/** Just enough of commander's chaining API to capture the doctor action. */
function fakeProgram() {
  const commands = new Map<string, { action?: (options: Record<string, unknown>) => unknown }>();
  const make = (path: string): any => {
    const node: any = {
      command: (name: string) => make(path ? `${path} ${name}` : name),
      description: () => node,
      option: () => node,
      action: (fn: (options: Record<string, unknown>) => unknown) => {
        commands.set(path, { action: fn });
        return node;
      },
    };
    return node;
  };
  return { program: make(""), commands };
}

describe("openclaw slack-workspace doctor", () => {
  it("registers a slack-workspace root command with a doctor subcommand", async () => {
    const { clis } = registerPlugin();
    expect(clis).toHaveLength(1);
    expect(clis[0].opts?.descriptors).toEqual([
      expect.objectContaining({ name: "slack-workspace", hasSubcommands: true }),
    ]);
    const { program, commands } = fakeProgram();
    await clis[0].registrar({ program, logger: recordingLogger() });
    expect([...commands.keys()]).toEqual(["slack-workspace doctor"]);
  });

  /** Run `openclaw slack-workspace doctor` against mocked Slack; capture stdout and exit code. */
  async function runDoctor(scopes: { bot: string[]; user: string[] }, options = {}) {
    const { clis } = registerPlugin();
    const { program, commands } = fakeProgram();
    await clis[0].registrar({ program, logger: recordingLogger() });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const saved = process.exitCode;
    try {
      await withMockFetch(authTest(scopes), async () => {
        await commands.get("slack-workspace doctor")!.action!(options);
      });
      return {
        output: write.mock.calls.map(([chunk]) => String(chunk)).join(""),
        exitCode: process.exitCode,
      };
    } finally {
      write.mockRestore();
      process.exitCode = saved;
    }
  }

  it("prints the report and sets a failing exit code when scopes are missing", async () => {
    const { output, exitCode } = await runDoctor({ bot: BOT_SCOPES, user: [] });
    expect(exitCode).toBe(1);
    expect(output).toContain("MISSING search:read — needed by slack_search");
  });

  it("prints JSON with --json and leaves the exit code alone when nothing is missing", async () => {
    const { output, exitCode } = await runDoctor(
      { bot: BOT_SCOPES, user: USER_SCOPES },
      { json: true },
    );
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });
});
