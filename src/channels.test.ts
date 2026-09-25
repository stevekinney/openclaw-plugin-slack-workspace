import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { approvalFor } from "./approvals.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const PUBLIC = { id: "C0TEST", name: "general", is_private: false };
const PRIVATE = { id: "C0PRIV", name: "secret", is_private: true };

/** Answer `conversations.info` with `info`, and every other method with `result`. */
const slack =
  (info: Record<string, unknown>, result: Record<string, unknown> = { ok: true }) =>
  ({ method }: RecordedCall) =>
    method === "conversations.info" ? { ok: true, channel: info } : result;

const methods = (calls: RecordedCall[]) => calls.map((call) => call.method);

type Case = {
  tool: string;
  params: Record<string, unknown>;
  method: string;
  body: Record<string, unknown>;
  result: Record<string, unknown>;
  expected: unknown;
  scope: string;
};

const existingChannelCases: Case[] = [
  {
    tool: "slack_channel_archive",
    params: { channelId: "C0TEST", confirm: true },
    method: "conversations.archive",
    body: { channel: "C0TEST" },
    result: { ok: true },
    expected: { archived: true, channelId: "C0TEST" },
    scope: "groups:write",
  },
  {
    tool: "slack_channel_rename",
    params: { channelId: "C0TEST", name: "renamed", confirm: true },
    method: "conversations.rename",
    body: { channel: "C0TEST", name: "renamed" },
    result: { ok: true, channel: { id: "C0TEST", name: "renamed", is_private: false } },
    expected: { channel: { id: "C0TEST", name: "renamed" } },
    scope: "groups:write",
  },
  {
    tool: "slack_channel_set_topic",
    params: { channelId: "C0TEST", topic: "Ship it" },
    method: "conversations.setTopic",
    body: { channel: "C0TEST", topic: "Ship it" },
    result: { ok: true, channel: PUBLIC },
    expected: { channelId: "C0TEST", topic: "Ship it" },
    scope: "groups:write.topic",
  },
  {
    tool: "slack_channel_set_purpose",
    params: { channelId: "C0TEST", purpose: "Launch room" },
    method: "conversations.setPurpose",
    body: { channel: "C0TEST", purpose: "Launch room" },
    result: { ok: true, channel: PUBLIC },
    expected: { channelId: "C0TEST", purpose: "Launch room" },
    scope: "groups:write",
  },
  {
    tool: "slack_channel_invite",
    params: { channelId: "C0TEST", userIds: ["U0A", "U0B"] },
    method: "conversations.invite",
    body: { channel: "C0TEST", users: "U0A,U0B" },
    result: { ok: true, channel: PUBLIC },
    expected: { channel: { id: "C0TEST", name: "general" }, invited: ["U0A", "U0B"] },
    scope: "groups:write.invites",
  },
];

describe("channel lifecycle tools on public channels", () => {
  it("slack_channel_create creates a public channel", async () => {
    await withMockFetch(
      () => ({ ok: true, channel: { id: "C0NEW", name: "launch", is_private: false } }),
      async (calls) => {
        await expect(runTool("slack_channel_create", { name: "launch" })).resolves.toEqual({
          channel: { id: "C0NEW", name: "launch" },
        });
        expect(methods(calls)).toEqual(["conversations.create"]);
        expect(calls[0].body).toEqual({ name: "launch", is_private: false });
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
      },
    );
  });

  it.each(existingChannelCases)(
    "$tool checks the channel is public, then calls $method",
    async ({ tool, params, method, body, result, expected }) => {
      await withMockFetch(slack(PUBLIC, result), async (calls) => {
        await expect(runTool(tool, params)).resolves.toEqual(expected);
        expect(methods(calls)).toEqual(["conversations.info", method]);
        expect(calls[0].body).toEqual({ channel: "C0TEST" });
        expect(calls[1].body).toEqual(body);
      });
    },
  );
});

describe("channel lifecycle tools on private channels", () => {
  it("slack_channel_create refuses isPrivate without calling Slack", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        await expect(
          runTool("slack_channel_create", { name: "secret", isPrivate: true }),
        ).rejects.toThrow("needs the `groups:write` scope");
        expect(calls).toHaveLength(0);
      },
    );
  });

  it.each(existingChannelCases)(
    "$tool names $scope instead of calling $method",
    async ({ tool, params, scope }) => {
      await withMockFetch(slack(PRIVATE), async (calls) => {
        const failure = runTool(tool, { ...params, channelId: "C0PRIV" });
        await expect(failure).rejects.toThrow(
          `Channel C0PRIV is a private channel. This plugin only manages public channels: acting on private channels needs the \`${scope}\` scope, which this Slack app is not granted.`,
        );
        expect(methods(calls)).toEqual(["conversations.info"]);
      });
    },
  );

  it.each(existingChannelCases)(
    "$tool translates Slack's groups:* missing_scope into the explicit error",
    async ({ tool, params, scope }) => {
      await withMockFetch(
        ({ method }) =>
          method === "conversations.info"
            ? { ok: true, channel: PUBLIC }
            : { ok: false, error: "missing_scope", needed: scope },
        async () => {
          await expect(runTool(tool, params)).rejects.toThrow(`needs the \`${scope}\` scope`);
        },
      );
    },
  );

  it("explains a channel_not_found as a bad ID or an unseen private channel", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "channel_not_found" }),
      async (calls) => {
        await expect(
          runTool("slack_channel_archive", { channelId: "C0GONE", confirm: true }),
        ).rejects.toThrow(
          "Slack conversations.info failed: channel_not_found. Check the channel ID; if C0GONE is a private channel",
        );
        expect(methods(calls)).toEqual(["conversations.info"]);
      },
    );
  });

  it("treats a groups:read missing_scope from conversations.info as private", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope", needed: "groups:read" }),
      async (calls) => {
        await expect(
          runTool("slack_channel_set_topic", { channelId: "C0PRIV", topic: "t" }),
        ).rejects.toThrow("needs the `groups:write.topic` scope");
        expect(methods(calls)).toEqual(["conversations.info"]);
      },
    );
  });

  it("passes other Slack errors through unchanged", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "channel_not_found" }),
      async () => {
        await expect(
          runTool("slack_channel_set_topic", { channelId: "C0NONE", topic: "t" }),
        ).rejects.toThrow("Slack conversations.info failed: channel_not_found");
      },
    );
  });
});

describe("confirm guard on archive and rename", () => {
  const parameters = (name: string) =>
    getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.parameters;

  it.each([
    ["slack_channel_archive", { channelId: "C0TEST" }],
    ["slack_channel_rename", { channelId: "C0TEST", name: "renamed" }],
  ])("%s requires confirm: true in its schema, with no default", (name, params) => {
    const schema = parameters(name) as { required?: string[]; properties: Record<string, any> };
    expect(schema.required).toContain("confirm");
    expect(schema.properties.confirm.default).toBeUndefined();
    expect(Value.Check(schema, { ...params, confirm: true })).toBe(true);
    expect(Value.Check(schema, params)).toBe(false);
    expect(Value.Check(schema, { ...params, confirm: false })).toBe(false);
    expect(Value.Check(schema, { ...params, confirm: "true" })).toBe(false);
  });

  it.each([
    ["slack_channel_archive", { channelId: "C0TEST" }],
    ["slack_channel_rename", { channelId: "C0TEST", name: "renamed" }],
  ])("%s without confirm: true never reaches Slack", async (name, params) => {
    await withMockFetch(
      () => ({ ok: true, channel: PUBLIC }),
      async (calls) => {
        for (const confirm of [undefined, false, "true"]) {
          await expect(runTool(name, { ...params, confirm })).rejects.toThrow(
            "without `confirm: true`",
          );
        }
        expect(calls).toHaveLength(0);
      },
    );
  });
});

describe("channel approvals", () => {
  it("gates archive and rename, naming the channel", () => {
    expect(
      approvalFor("slack_channel_archive", { channelId: "C0TEST", confirm: true }),
    ).toMatchObject({
      title: "Archive Slack channel",
      scope: { kind: "external-post", target: "channel C0TEST" },
      allowedDecisions: ["allow-once", "deny"],
    });
    const rename = approvalFor("slack_channel_rename", {
      channelId: "C0TEST",
      name: "renamed",
      confirm: true,
    });
    expect(rename).toMatchObject({ scope: { target: "channel C0TEST" } });
    expect(rename?.description).toContain("#renamed");
  });

  it.each([
    ["slack_channel_create", { name: "launch" }],
    ["slack_channel_set_topic", { channelId: "C0TEST", topic: "t" }],
    ["slack_channel_set_purpose", { channelId: "C0TEST", purpose: "p" }],
    ["slack_channel_invite", { channelId: "C0TEST", userIds: ["U0A"] }],
  ])("does not gate %s", (name, params) => {
    expect(approvalFor(name, params)).toBeUndefined();
  });
});

describe("slack_channel_kickoff", () => {
  const NEW = { id: "C0NEW", name: "launch", is_private: false };
  const full = {
    name: "launch",
    topic: "Ship it",
    purpose: "Launch room",
    invite: ["U0A", "U0B"],
    canvas: { title: "Launch plan", markdown: "# Plan" },
    bookmark: { title: "Tracker", link: "https://example.com/tracker", emoji: ":dart:" },
  };

  /** Answer each method with a success payload, or with `failures[method]` when set. */
  const kickoffSlack =
    (failures: Record<string, string> = {}) =>
    ({ method }: RecordedCall) => {
      if (failures[method]) return { ok: false, error: failures[method] };
      switch (method) {
        case "conversations.create":
          return { ok: true, channel: NEW };
        case "canvases.create":
          return { ok: true, canvas_id: "F0CANVAS" };
        case "auth.test":
          return { ok: true, url: "https://lostgradient.slack.com/", team_id: "T0TEST" };
        case "bookmarks.add":
          return {
            ok: true,
            bookmark: { id: "Bk0NEW", title: "Tracker", link: full.bookmark.link, emoji: ":dart:", type: "link" },
          };
        default:
          return { ok: true, channel: NEW };
      }
    };

  it("stands up the room in order and reports every step", async () => {
    await withMockFetch(kickoffSlack(), async (calls) => {
      const result = (await runTool("slack_channel_kickoff", full)) as Record<string, any>;
      expect(methods(calls).filter((method) => method !== "auth.test")).toEqual([
        "conversations.create",
        "conversations.setTopic",
        "conversations.setPurpose",
        "conversations.invite",
        "canvases.create",
        "canvases.access.set",
        "bookmarks.add",
      ]);
      const body = (method: string) => calls.find((call) => call.method === method)!.body;
      expect(body("conversations.create")).toEqual({ name: "launch", is_private: false });
      expect(body("conversations.setTopic")).toEqual({ channel: "C0NEW", topic: "Ship it" });
      expect(body("conversations.setPurpose")).toEqual({ channel: "C0NEW", purpose: "Launch room" });
      expect(body("conversations.invite")).toEqual({ channel: "C0NEW", users: "U0A,U0B" });
      expect(body("canvases.access.set")).toMatchObject({
        canvas_id: "F0CANVAS",
        channel_ids: ["C0NEW"],
        access_level: "write",
      });
      expect(body("bookmarks.add")).toMatchObject({
        channel_id: "C0NEW",
        title: "Tracker",
        link: full.bookmark.link,
        emoji: ":dart:",
      });
      expect(result).toMatchObject({
        channel: { id: "C0NEW", name: "launch" },
        complete: true,
        steps: [
          { step: "create", ok: true },
          { step: "topic", ok: true },
          { step: "purpose", ok: true },
          { step: "invite", ok: true },
          { step: "canvas", ok: true },
          { step: "bookmark", ok: true },
        ],
        invited: ["U0A", "U0B"],
        canvas: { canvasId: "F0CANVAS", sharedWith: ["C0NEW"] },
        bookmark: { id: "Bk0NEW", title: "Tracker" },
      });
      for (const step of result.steps) expect(step.error).toBeUndefined();
    });
  });

  it("only runs the steps it was given", async () => {
    await withMockFetch(kickoffSlack(), async (calls) => {
      await expect(runTool("slack_channel_kickoff", { name: "launch" })).resolves.toEqual({
        channel: { id: "C0NEW", name: "launch" },
        complete: true,
        steps: [{ step: "create", ok: true }],
        invited: [],
        canvas: null,
        bookmark: null,
      });
      expect(methods(calls)).toEqual(["conversations.create"]);
    });
  });

  it("keeps going after a failed step and reports it", async () => {
    await withMockFetch(
      kickoffSlack({ "conversations.invite": "user_not_found" }),
      async (calls) => {
        const result = (await runTool("slack_channel_kickoff", full)) as Record<string, any>;
        expect(result.complete).toBe(false);
        expect(result.steps).toEqual([
          { step: "create", ok: true },
          { step: "topic", ok: true },
          { step: "purpose", ok: true },
          {
            step: "invite",
            ok: false,
            error: "Slack conversations.invite failed: user_not_found",
          },
          { step: "canvas", ok: true },
          { step: "bookmark", ok: true },
        ]);
        expect(result.invited).toEqual([]);
        expect(result.channel).toEqual({ id: "C0NEW", name: "launch" });
        expect(methods(calls)).toContain("bookmarks.add");
      },
    );
  });

  it("reports a canvas that was created but not shared as a failed step, keeping its ID", async () => {
    await withMockFetch(
      kickoffSlack({ "canvases.access.set": "not_allowed" }),
      async () => {
        const result = (await runTool("slack_channel_kickoff", full)) as Record<string, any>;
        expect(result.complete).toBe(false);
        expect(result.steps[4]).toEqual({
          step: "canvas",
          ok: false,
          error: "Slack canvases.access.set failed: not_allowed",
        });
        expect(result.canvas).toMatchObject({ canvasId: "F0CANVAS", sharedWith: null });
      },
    );
  });

  it("throws when the channel can't be created, since no later step can run", async () => {
    await withMockFetch(kickoffSlack({ "conversations.create": "name_taken" }), async (calls) => {
      await expect(runTool("slack_channel_kickoff", full)).rejects.toThrow(
        "Slack conversations.create failed: name_taken",
      );
      expect(methods(calls)).toEqual(["conversations.create"]);
    });
  });

  it("always asks a human first, listing what it will do", () => {
    const approval = approvalFor("slack_channel_kickoff", full);
    expect(approval).toMatchObject({
      title: "Kick off Slack channel",
      scope: { kind: "external-post", target: "new channel #launch" },
      allowedDecisions: ["allow-once", "deny"],
    });
    for (const detail of ["#launch", "U0A", "Launch plan", "Tracker"]) {
      expect(approval?.description).toContain(detail);
    }
    expect(approvalFor("slack_channel_kickoff", { name: "launch" })).toBeDefined();
  });
});
