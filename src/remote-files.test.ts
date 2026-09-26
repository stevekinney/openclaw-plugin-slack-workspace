import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { TOOL_SCOPES } from "./doctor.js";
import { runTool, withMockFetch } from "./test-utils.js";

const toolNamed = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!;

const REMOTE_FILE_TOOLS = [
  "slack_remote_file_add",
  "slack_remote_file_update",
  "slack_remote_file_remove",
  "slack_remote_file_share",
  "slack_remote_file_info",
  "slack_remote_file_list",
];

/** A remote file as files.remote.* returns it, bookkeeping fields included. */
const rawRemoteFile = (overrides: Record<string, unknown> = {}) => ({
  id: "F0REMOTE",
  created: 1700000000,
  timestamp: 1700000000,
  name: "ENG-123",
  title: "ENG-123: Fix the flaky deploy",
  mimetype: "application/vnd.slack-remote",
  filetype: "remote",
  pretty_type: "Remote",
  user: "U0BOT",
  editable: false,
  size: 0,
  mode: "external",
  is_external: true,
  external_type: "app",
  is_public: false,
  public_url_shared: false,
  display_as_bot: false,
  username: "",
  url_private: "https://linear.example/ENG-123",
  permalink: "https://example.slack.com/files/U0BOT/F0REMOTE/eng-123",
  comments_count: 0,
  is_starred: false,
  shares: {},
  channels: [],
  groups: [],
  ims: [],
  external_id: "linear-ENG-123",
  external_url: "https://linear.example/ENG-123",
  has_rich_preview: false,
  ...overrides,
});

const curatedFile = {
  fileId: "F0REMOTE",
  externalId: "linear-ENG-123",
  externalUrl: "https://linear.example/ENG-123",
  title: "ENG-123: Fix the flaky deploy",
  permalink: "https://example.slack.com/files/U0BOT/F0REMOTE/eng-123",
};

describe("slack_remote_file_add", () => {
  it("registers an external document as a remote file with the bot token", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile() }),
      async (calls) => {
        const result = await runTool("slack_remote_file_add", {
          externalId: "linear-ENG-123",
          externalUrl: "https://linear.example/ENG-123",
          title: "ENG-123: Fix the flaky deploy",
        });
        expect(calls.map((call) => call.method)).toEqual(["files.remote.add"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({
          external_id: "linear-ENG-123",
          external_url: "https://linear.example/ENG-123",
          title: "ENG-123: Fix the flaky deploy",
        });
        expect(result).toEqual(curatedFile);
        expect(Value.Check(toolNamed("slack_remote_file_add").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("passes filetype and indexable contents through when given", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile({ filetype: "pdf" }) }),
      async (calls) => {
        await runTool("slack_remote_file_add", {
          externalId: "report-2026-09",
          externalUrl: "https://reports.example/2026-09.pdf",
          title: "September report",
          filetype: "pdf",
          indexableFileContents: "Revenue grew.",
        });
        expect(calls[0].body).toMatchObject({
          filetype: "pdf",
          indexable_file_contents: "Revenue grew.",
        });
      },
    );
  });

  it("surfaces Slack's error when the external ID is already registered", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "file_already_exists" }),
      async () => {
        await expect(
          runTool("slack_remote_file_add", {
            externalId: "linear-ENG-123",
            externalUrl: "https://linear.example/ENG-123",
            title: "Dup",
          }),
        ).rejects.toThrow(/file_already_exists/);
      },
    );
  });
});

describe("slack_remote_file_update", () => {
  it("updates the title and URL of a remote file found by external ID", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile({ title: "ENG-123: Fixed" }) }),
      async (calls) => {
        const result = await runTool("slack_remote_file_update", {
          externalId: "linear-ENG-123",
          title: "ENG-123: Fixed",
        });
        expect(calls.map((call) => call.method)).toEqual(["files.remote.update"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ external_id: "linear-ENG-123", title: "ENG-123: Fixed" });
        expect(result).toEqual({ ...curatedFile, title: "ENG-123: Fixed" });
        expect(Value.Check(toolNamed("slack_remote_file_update").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("targets a remote file by Slack file ID", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile({ external_url: "https://linear.example/ENG-124" }) }),
      async (calls) => {
        await runTool("slack_remote_file_update", {
          fileId: "F0REMOTE",
          externalUrl: "https://linear.example/ENG-124",
        });
        expect(calls[0].body).toEqual({
          file: "F0REMOTE",
          external_url: "https://linear.example/ENG-124",
        });
      },
    );
  });

  it("refuses a call with nothing to change before contacting Slack", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        await expect(
          runTool("slack_remote_file_update", { fileId: "F0REMOTE" }),
        ).rejects.toThrow(/nothing to update/i);
        expect(calls).toHaveLength(0);
      },
    );
  });
});

describe("slack_remote_file_remove", () => {
  it("removes a remote file by external ID", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        const result = await runTool("slack_remote_file_remove", { externalId: "linear-ENG-123" });
        expect(calls.map((call) => call.method)).toEqual(["files.remote.remove"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ external_id: "linear-ENG-123" });
        expect(result).toEqual({ externalId: "linear-ENG-123", removed: true });
        expect(Value.Check(toolNamed("slack_remote_file_remove").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("removes a remote file by Slack file ID", async () => {
    await withMockFetch(
      () => ({ ok: true }),
      async (calls) => {
        const result = await runTool("slack_remote_file_remove", { fileId: "F0REMOTE" });
        expect(calls[0].body).toEqual({ file: "F0REMOTE" });
        expect(result).toEqual({ fileId: "F0REMOTE", removed: true });
      },
    );
  });
});

describe("slack_remote_file_share", () => {
  it("shares a remote file into channels", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile() }),
      async (calls) => {
        const result = await runTool("slack_remote_file_share", {
          externalId: "linear-ENG-123",
          channelIds: ["C0ENG", "C0OPS"],
        });
        expect(calls.map((call) => call.method)).toEqual(["files.remote.share"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ external_id: "linear-ENG-123", channels: "C0ENG,C0OPS" });
        expect(result).toEqual({ ...curatedFile, channelIds: ["C0ENG", "C0OPS"] });
        expect(Value.Check(toolNamed("slack_remote_file_share").outputSchema!, result)).toBe(true);
      },
    );
  });
});

describe("slack_remote_file_info", () => {
  it("reads a remote file by external ID with the bot token", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile() }),
      async (calls) => {
        const result = await runTool("slack_remote_file_info", { externalId: "linear-ENG-123" });
        expect(calls.map((call) => call.method)).toEqual(["files.remote.info"]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ external_id: "linear-ENG-123" });
        expect(result).toEqual(curatedFile);
        expect(Value.Check(toolNamed("slack_remote_file_info").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("reads a remote file by Slack file ID", async () => {
    await withMockFetch(
      () => ({ ok: true, file: rawRemoteFile() }),
      async (calls) => {
        const result = await runTool("slack_remote_file_info", { fileId: "F0REMOTE" });
        expect(calls[0].body).toEqual({ file: "F0REMOTE" });
        expect(result).toEqual(curatedFile);
      },
    );
  });
});

describe("slack_remote_file_list", () => {
  it("walks every page of remote files in a channel", async () => {
    const pages: Record<string, unknown>[] = [
      {
        ok: true,
        files: [rawRemoteFile()],
        response_metadata: { next_cursor: "page-2" },
      },
      {
        ok: true,
        files: [
          rawRemoteFile({
            id: "F0REMOTE2",
            external_id: "linear-ENG-124",
            external_url: "https://linear.example/ENG-124",
            title: "ENG-124",
            permalink: "https://example.slack.com/files/U0BOT/F0REMOTE2/eng-124",
          }),
        ],
        response_metadata: { next_cursor: "" },
      },
    ];
    await withMockFetch(
      () => pages.shift()!,
      async (calls) => {
        const result = await runTool("slack_remote_file_list", { channelId: "C0ENG", limit: 1 });
        expect(calls.map((call) => call.method)).toEqual([
          "files.remote.list",
          "files.remote.list",
        ]);
        expect(calls[0].headers.authorization).toBe("Bearer xoxb-test");
        expect(calls[0].body).toEqual({ channel: "C0ENG", limit: "1" });
        expect(calls[1].body).toEqual({ channel: "C0ENG", limit: "1", cursor: "page-2" });
        expect(result).toEqual({
          files: [
            curatedFile,
            {
              fileId: "F0REMOTE2",
              externalId: "linear-ENG-124",
              externalUrl: "https://linear.example/ENG-124",
              title: "ENG-124",
              permalink: "https://example.slack.com/files/U0BOT/F0REMOTE2/eng-124",
            },
          ],
          hasMore: false,
        });
        expect(Value.Check(toolNamed("slack_remote_file_list").outputSchema!, result)).toBe(true);
      },
    );
  });

  it("resumes from a cursor and returns the next one when pages remain", async () => {
    let page = 0;
    await withMockFetch(
      () => ({
        ok: true,
        files: [rawRemoteFile()],
        response_metadata: { next_cursor: `page-${++page}` },
      }),
      async (calls) => {
        const result = await runTool("slack_remote_file_list", { cursor: "start" });
        expect(calls).toHaveLength(10);
        expect(calls[0].body).toEqual({ cursor: "start" });
        expect(result).toMatchObject({ cursor: "page-10", hasMore: true });
        expect(Value.Check(toolNamed("slack_remote_file_list").outputSchema!, result)).toBe(true);
      },
    );
  });
});

describe("remote file targeting", () => {
  it.each([
    "slack_remote_file_update",
    "slack_remote_file_remove",
    "slack_remote_file_share",
    "slack_remote_file_info",
  ])(
    "%s requires exactly one of fileId or externalId",
    async (name) => {
      await withMockFetch(
        () => ({ ok: true }),
        async (calls) => {
          const rest = { title: "t", channelIds: ["C0ENG"] };
          await expect(runTool(name, rest)).rejects.toThrow(/exactly one of fileId or externalId/);
          await expect(
            runTool(name, { ...rest, fileId: "F0REMOTE", externalId: "linear-ENG-123" }),
          ).rejects.toThrow(/exactly one of fileId or externalId/);
          expect(calls).toHaveLength(0);
        },
      );
    },
  );
});

describe("remote file tool descriptions", () => {
  it("document that remote files need the bot token", () => {
    for (const name of REMOTE_FILE_TOOLS) {
      expect(toolNamed(name).description, name).toMatch(/bot token/i);
      expect(TOOL_SCOPES[name]?.token, name).toBe("bot");
    }
  });
});
