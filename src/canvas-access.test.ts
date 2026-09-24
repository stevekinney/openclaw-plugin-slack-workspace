import { beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { resetWorkspaceCache } from "./client.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const ORIGIN = "https://example-workspace.slack.com";
const TEAM_ID = "T0TEST";

const ok = (call: RecordedCall) =>
  call.method === "auth.test"
    ? { ok: true, url: `${ORIGIN}/`, team_id: TEAM_ID }
    : call.method === "canvases.create"
      ? { ok: true, canvas_id: "F0CANVAS" }
      : { ok: true };

const outputSchema = (name: string) =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === name)?.outputSchema;

beforeEach(() => resetWorkspaceCache());

describe("slack_canvas_access_set", () => {
  it("grants access to several channels in one call", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_access_set", {
        canvasId: "F0CANVAS",
        channelIds: ["C0ONE", "C0TWO"],
        accessLevel: "read",
      });
      expect(calls.map((call) => call.method)).toEqual(["canvases.access.set"]);
      expect(calls[0]!.body).toEqual({
        canvas_id: "F0CANVAS",
        channel_ids: ["C0ONE", "C0TWO"],
        access_level: "read",
      });
      expect(result).toEqual({
        canvasId: "F0CANVAS",
        accessLevel: "read",
        channelIds: ["C0ONE", "C0TWO"],
      });
      expect(Value.Check(outputSchema("slack_canvas_access_set")!, result)).toBe(true);
    });
  });

  it("grants owner access to users", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_access_set", {
        canvasId: "F0CANVAS",
        userIds: ["U0ONE", "U0TWO"],
        accessLevel: "owner",
      });
      expect(calls[0]!.body).toEqual({
        canvas_id: "F0CANVAS",
        user_ids: ["U0ONE", "U0TWO"],
        access_level: "owner",
      });
      expect(result).toEqual({
        canvasId: "F0CANVAS",
        accessLevel: "owner",
        userIds: ["U0ONE", "U0TWO"],
      });
      expect(Value.Check(outputSchema("slack_canvas_access_set")!, result)).toBe(true);
    });
  });

  it.each([
    [{ channelIds: ["C0ONE"], userIds: ["U0ONE"] }, "either channelIds or userIds, not both"],
    [{}, "channelIds or userIds"],
    [{ channelIds: ["C0ONE"], accessLevel: "owner" }, "owner access can only be granted to users"],
  ])("rejects %o before calling Slack", async (target, message) => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_canvas_access_set", { canvasId: "F0CANVAS", accessLevel: "write", ...target }),
      ).rejects.toThrow(message);
      expect(calls).toEqual([]);
    });
  });

  it("surfaces Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "canvas_not_found" }),
      async () => {
        await expect(
          runTool("slack_canvas_access_set", {
            canvasId: "F0MISSING",
            channelIds: ["C0ONE"],
            accessLevel: "write",
          }),
        ).rejects.toThrow("canvases.access.set failed: canvas_not_found");
      },
    );
  });
});

describe("slack_canvas_access_delete", () => {
  it("revokes access from channels", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_access_delete", {
        canvasId: "F0CANVAS",
        channelIds: ["C0ONE", "C0TWO"],
      });
      expect(calls.map((call) => call.method)).toEqual(["canvases.access.delete"]);
      expect(calls[0]!.body).toEqual({ canvas_id: "F0CANVAS", channel_ids: ["C0ONE", "C0TWO"] });
      expect(result).toEqual({ canvasId: "F0CANVAS", revoked: true, channelIds: ["C0ONE", "C0TWO"] });
      expect(Value.Check(outputSchema("slack_canvas_access_delete")!, result)).toBe(true);
    });
  });

  it("revokes access from users", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_access_delete", {
        canvasId: "F0CANVAS",
        userIds: ["U0ONE"],
      });
      expect(calls[0]!.body).toEqual({ canvas_id: "F0CANVAS", user_ids: ["U0ONE"] });
      expect(result).toEqual({ canvasId: "F0CANVAS", revoked: true, userIds: ["U0ONE"] });
      expect(Value.Check(outputSchema("slack_canvas_access_delete")!, result)).toBe(true);
    });
  });

  it("rejects both targets at once before calling Slack", async () => {
    await withMockFetch(ok, async (calls) => {
      await expect(
        runTool("slack_canvas_access_delete", {
          canvasId: "F0CANVAS",
          channelIds: ["C0ONE"],
          userIds: ["U0ONE"],
        }),
      ).rejects.toThrow("either channelIds or userIds, not both");
      expect(calls).toEqual([]);
    });
  });
});

describe("slack_canvas_create channelIds", () => {
  it("shares the new canvas with every listed channel in one access call", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_create", {
        title: "t",
        markdown: "m",
        channelIds: ["C0ONE", "C0TWO"],
        accessLevel: "read",
      });
      const share = calls.find((call) => call.method === "canvases.access.set");
      expect(share!.body).toEqual({
        canvas_id: "F0CANVAS",
        channel_ids: ["C0ONE", "C0TWO"],
        access_level: "read",
      });
      expect(result).toEqual({
        canvasId: "F0CANVAS",
        url: `${ORIGIN}/docs/${TEAM_ID}/F0CANVAS`,
        sharedWith: ["C0ONE", "C0TWO"],
      });
      expect(Value.Check(outputSchema("slack_canvas_create")!, result)).toBe(true);
    });
  });

  it("skips sharing when channelIds is empty", async () => {
    await withMockFetch(ok, async (calls) => {
      const result = await runTool("slack_canvas_create", { title: "t", markdown: "m", channelIds: [] });
      expect(calls.map((call) => call.method)).not.toContain("canvases.access.set");
      expect(result).toMatchObject({ sharedWith: null });
    });
  });
});
