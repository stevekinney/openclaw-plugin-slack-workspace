import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const toolNamed = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!;

/** A user group as usergroups.list returns it, bookkeeping fields included. */
const rawUsergroup = (overrides: Record<string, unknown> = {}) => ({
  id: "S0ONCALL",
  team_id: "T0TEST",
  is_usergroup: true,
  is_subteam: true,
  name: "On-call",
  description: "Whoever is carrying the pager",
  handle: "oncall",
  is_external: false,
  date_create: 1700000000,
  date_update: 1700000100,
  date_delete: 0,
  auto_type: null,
  auto_provision: false,
  enterprise_subteam_id: "",
  created_by: "U0TEST",
  updated_by: "U0TEST",
  deleted_by: null,
  prefs: { channels: ["C0OPS", "C0INCIDENTS"], groups: [] },
  user_count: 3,
  channel_count: 2,
  ...overrides,
});

describe("slack_usergroup_list", () => {
  it("lists user groups with their handle, name, and default channels", async () => {
    await withMockFetch(
      () => ({
        ok: true,
        usergroups: [
          rawUsergroup(),
          rawUsergroup({
            id: "S0DESIGN",
            name: "Design",
            handle: "design",
            description: "",
            prefs: { channels: [], groups: [] },
            user_count: 0,
          }),
        ],
      }),
      async (calls) => {
        const result = await runTool("slack_usergroup_list", {});
        expect(calls.map((call) => call.method)).toEqual(["usergroups.list"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ include_count: "true", include_disabled: "false" });
        expect(result).toEqual({
          usergroups: [
            {
              id: "S0ONCALL",
              handle: "oncall",
              name: "On-call",
              description: "Whoever is carrying the pager",
              defaultChannelIds: ["C0OPS", "C0INCIDENTS"],
              userCount: 3,
              disabled: false,
            },
            {
              id: "S0DESIGN",
              handle: "design",
              name: "Design",
              defaultChannelIds: [],
              userCount: 0,
              disabled: false,
            },
          ],
        });
        expect(Value.Check(toolNamed("slack_usergroup_list").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("includes disabled groups on request and flags them", async () => {
    await withMockFetch(
      () => ({ ok: true, usergroups: [rawUsergroup({ date_delete: 1700000200 })] }),
      async (calls) => {
        const result = (await runTool("slack_usergroup_list", { includeDisabled: true })) as {
          usergroups: { disabled: boolean }[];
        };
        expect(calls[0].body.include_disabled).toBe("true");
        expect(result.usergroups[0].disabled).toBe(true);
      },
    );
  });

  it("returns an empty list when the workspace has no user groups", async () => {
    await withMockFetch(
      () => ({ ok: true, usergroups: [] }),
      async () => {
        expect(await runTool("slack_usergroup_list", {})).toEqual({ usergroups: [] });
      },
    );
  });
});

describe("slack_usergroup_members", () => {
  it("returns the member user IDs of one user group", async () => {
    await withMockFetch(
      () => ({ ok: true, users: ["U0ALICE", "U0BOB"] }),
      async (calls) => {
        const result = await runTool("slack_usergroup_members", { usergroupId: "S0ONCALL" });
        expect(calls.map((call) => call.method)).toEqual(["usergroups.users.list"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ usergroup: "S0ONCALL", include_disabled: "false" });
        expect(result).toEqual({ usergroupId: "S0ONCALL", userIds: ["U0ALICE", "U0BOB"] });
        expect(Value.Check(toolNamed("slack_usergroup_members").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("passes includeDisabled through for a disabled group", async () => {
    await withMockFetch(
      () => ({ ok: true, users: [] }),
      async (calls) => {
        const result = await runTool("slack_usergroup_members", {
          usergroupId: "S0OLD",
          includeDisabled: true,
        });
        expect(calls[0].body.include_disabled).toBe("true");
        expect(result).toEqual({ usergroupId: "S0OLD", userIds: [] });
      },
    );
  });

  it("surfaces Slack's error for an unknown group", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "no_such_subteam" }),
      async () => {
        await expect(
          runTool("slack_usergroup_members", { usergroupId: "S0NOPE" }),
        ).rejects.toThrow(/no_such_subteam/);
      },
    );
  });
});

describe("usergroup tool descriptions", () => {
  it("state that the tools are read-only because usergroups:write is not granted", () => {
    for (const name of ["slack_usergroup_list", "slack_usergroup_members"]) {
      const { description } = toolNamed(name);
      expect(description, name).toMatch(/read-only/i);
      expect(description, name).toContain("usergroups:write");
    }
  });
});
