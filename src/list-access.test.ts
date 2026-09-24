import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch } from "./test-utils.js";

const outputSchema = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.outputSchema!;

const ok = () => ({ ok: true });

describe("slack_list_access_set", () => {
  it("grants access to several channels in one call", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_access_set", {
        listId: "F0LIST",
        channelIds: ["C0ONE", "C0TWO"],
        accessLevel: "read",
      });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.access.set"]);
      expect(calls[0]!.body).toEqual({
        list_id: "F0LIST",
        channel_ids: ["C0ONE", "C0TWO"],
        access_level: "read",
      });
      expect(result).toEqual({ listId: "F0LIST", accessLevel: "read", channelIds: ["C0ONE", "C0TWO"] });
      expect(Value.Check(outputSchema("slack_list_access_set"), result)).toBe(true);
    });
  });

  it("grants owner access to users", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_access_set", {
        listId: "F0LIST",
        userIds: ["U0ONE"],
        accessLevel: "owner",
      });
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", user_ids: ["U0ONE"], access_level: "owner" });
      expect(result).toEqual({ listId: "F0LIST", accessLevel: "owner", userIds: ["U0ONE"] });
      expect(Value.Check(outputSchema("slack_list_access_set"), result)).toBe(true);
    });
  });

  it.each([
    [{ channelIds: ["C0ONE"], userIds: ["U0ONE"] }, "either channelIds or userIds, not both"],
    [{}, "channelIds or userIds"],
    [{ channelIds: ["C0ONE"], accessLevel: "owner" }, "owner access can only be granted to users"],
  ])("rejects %o before calling Slack", async (target, message) => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_list_access_set", { listId: "F0LIST", accessLevel: "write", ...target }),
      ).rejects.toThrow(message);
      expect(calls).toEqual([]);
    });
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "list_not_found" }),
      async () => {
        await expect(
          runTool("slack_list_access_set", {
            listId: "F0MISSING",
            channelIds: ["C0ONE"],
            accessLevel: "write",
          }),
        ).rejects.toThrow("slackLists.access.set failed: list_not_found");
      },
    );
  });
});

describe("slack_list_access_delete", () => {
  it("revokes access from channels", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_access_delete", {
        listId: "F0LIST",
        channelIds: ["C0ONE", "C0TWO"],
      });
      expect(calls.map((call) => call.method)).toEqual(["slackLists.access.delete"]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", channel_ids: ["C0ONE", "C0TWO"] });
      expect(result).toEqual({ listId: "F0LIST", revoked: true, channelIds: ["C0ONE", "C0TWO"] });
      expect(Value.Check(outputSchema("slack_list_access_delete"), result)).toBe(true);
    });
  });

  it("revokes access from users", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_list_access_delete", { listId: "F0LIST", userIds: ["U0ONE"] });
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", user_ids: ["U0ONE"] });
      expect(result).toEqual({ listId: "F0LIST", revoked: true, userIds: ["U0ONE"] });
      expect(Value.Check(outputSchema("slack_list_access_delete"), result)).toBe(true);
    });
  });

  it("rejects both targets at once before calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_list_access_delete", {
          listId: "F0LIST",
          channelIds: ["C0ONE"],
          userIds: ["U0ONE"],
        }),
      ).rejects.toThrow("either channelIds or userIds, not both");
      expect(calls).toEqual([]);
    });
  });
});
