import { describe, expect, it } from "vitest";
import { approvalFor } from "./approvals.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const channel = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name,
  is_private: false,
  is_archived: false,
  is_member: false,
  num_members: 3,
  topic: { value: "", creator: "U0X", last_set: 0 },
  purpose: { value: "", creator: "U0X", last_set: 0 },
  ...extra,
});

const LIST_PAGES: Record<string, Record<string, unknown>> = {
  "": {
    ok: true,
    channels: [
      channel("C01", "general", { is_member: true }),
      channel("C02", "launch-planning", { topic: { value: "Q4 launch" } }),
    ],
    response_metadata: { next_cursor: "page2" },
  },
  page2: {
    ok: true,
    channels: [
      channel("C03", "random", { purpose: { value: "Anything about the LAUNCH party" } }),
      channel("G04", "secret-ops", { is_private: true, is_member: true, num_members: 2 }),
    ],
    response_metadata: { next_cursor: "" },
  },
};

const byCursor = (pages: Record<string, Record<string, unknown>>) => (call: RecordedCall) =>
  pages[String(call.body.cursor ?? "")];

describe("slack_channel_list", () => {
  it("walks every page of public and private channels, excluding archived by default", async () => {
    await withMockFetch(byCursor(LIST_PAGES), async (calls) => {
      const result = await runTool("slack_channel_list", {});
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.list",
        "conversations.list",
      ]);
      expect(calls[0].body).toMatchObject({
        types: "public_channel,private_channel",
        exclude_archived: true,
      });
      expect(calls[1].body).toMatchObject({ cursor: "page2" });
      expect(result).toEqual({
        channels: [
          { id: "C01", name: "general", isPrivate: false, isArchived: false, isMember: true, memberCount: 3 },
          {
            id: "C02",
            name: "launch-planning",
            isPrivate: false,
            isArchived: false,
            isMember: false,
            topic: "Q4 launch",
            memberCount: 3,
          },
          {
            id: "C03",
            name: "random",
            isPrivate: false,
            isArchived: false,
            isMember: false,
            purpose: "Anything about the LAUNCH party",
            memberCount: 3,
          },
          { id: "G04", name: "secret-ops", isPrivate: true, isArchived: false, isMember: true, memberCount: 2 },
        ],
        privateIncluded: true,
        hasMore: false,
      });
    });
  });

  it("filters by a case-insensitive substring of name, topic, or purpose", async () => {
    await withMockFetch(byCursor(LIST_PAGES), async () => {
      const result = (await runTool("slack_channel_list", { query: "Launch" })) as {
        channels: { id: string }[];
      };
      expect(result.channels.map((entry) => entry.id)).toEqual(["C02", "C03"]);
    });
  });

  it("passes excludeArchived: false through and reports archived channels", async () => {
    await withMockFetch(
      () => ({ ok: true, channels: [channel("C09", "old", { is_archived: true })] }),
      async (calls) => {
        const result = await runTool("slack_channel_list", { excludeArchived: false });
        expect(calls[0].body).toMatchObject({ exclude_archived: false });
        expect(result).toMatchObject({ channels: [{ id: "C09", isArchived: true }] });
      },
    );
  });

  it("stops at maxPages and returns the cursor to resume from", async () => {
    let n = 0;
    await withMockFetch(
      () => ({
        ok: true,
        channels: [channel(`C${n}`, `chan-${n}`)],
        response_metadata: { next_cursor: `c${++n}` },
      }),
      async (calls) => {
        const result = await runTool("slack_channel_list", { maxPages: 3, limit: 200 });
        expect(calls).toHaveLength(3);
        expect(calls[0].body).toMatchObject({ limit: 200 });
        expect(result).toMatchObject({ cursor: "c3", hasMore: true });
      },
    );
  });

  it("resumes from a caller's cursor", async () => {
    await withMockFetch(byCursor(LIST_PAGES), async (calls) => {
      const result = (await runTool("slack_channel_list", { cursor: "page2" })) as {
        channels: { id: string }[];
      };
      expect(calls).toHaveLength(1);
      expect(result.channels.map((entry) => entry.id)).toEqual(["C03", "G04"]);
    });
  });

  it("falls back to public channels only when groups:read is missing", async () => {
    await withMockFetch(
      ({ body }) =>
        String(body.types).includes("private_channel")
          ? { ok: false, error: "missing_scope", needed: "groups:read" }
          : { ok: true, channels: [channel("C01", "general")] },
      async (calls) => {
        const result = await runTool("slack_channel_list", {});
        expect(calls.map((call) => call.body.types)).toEqual([
          "public_channel,private_channel",
          "public_channel",
        ]);
        expect(result).toMatchObject({ channels: [{ id: "C01" }], privateIncluded: false });
      },
    );
  });

  it("surfaces other Slack errors", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "missing_scope", needed: "channels:read" }),
      async () => {
        await expect(runTool("slack_channel_list", {})).rejects.toThrow(/channels:read/);
      },
    );
  });

  it("is not approval-gated", () => {
    expect(approvalFor("slack_channel_list", {})).toBeUndefined();
  });
});

describe("slack_channel_members", () => {
  const pages: Record<string, Record<string, unknown>> = {
    "": { ok: true, members: ["U01", "U02"], response_metadata: { next_cursor: "m2" } },
    m2: { ok: true, members: ["U03"], response_metadata: { next_cursor: "" } },
  };

  it("walks every page of member IDs", async () => {
    await withMockFetch(byCursor(pages), async (calls) => {
      const result = await runTool("slack_channel_members", { channelId: "C01" });
      expect(calls.map((call) => call.method)).toEqual([
        "conversations.members",
        "conversations.members",
      ]);
      expect(calls[0].body).toMatchObject({ channel: "C01" });
      expect(calls[1].body).toMatchObject({ channel: "C01", cursor: "m2" });
      expect(result).toEqual({ channelId: "C01", userIds: ["U01", "U02", "U03"], hasMore: false });
    });
  });

  it("stops at maxPages and returns the cursor to resume from", async () => {
    await withMockFetch(byCursor(pages), async (calls) => {
      const result = await runTool("slack_channel_members", { channelId: "C01", maxPages: 1 });
      expect(calls).toHaveLength(1);
      expect(result).toEqual({ channelId: "C01", userIds: ["U01", "U02"], cursor: "m2", hasMore: true });
    });
  });

  it("is not approval-gated", () => {
    expect(approvalFor("slack_channel_members", { channelId: "C01" })).toBeUndefined();
  });
});
