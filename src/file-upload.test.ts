import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const UPLOAD_URL = "https://files.slack.com/upload/v1/ABC123";

const completed = (shares?: Record<string, unknown>) => ({
  ok: true,
  files: [
    {
      id: "F0FILE",
      title: "Weekly report",
      name: "report.csv",
      permalink: "https://example.slack.com/files/U0BOT/F0FILE/report.csv",
      ...(shares ? { shares } : {}),
    },
  ],
});

const flow =
  (complete: Record<string, unknown> = completed()) =>
  (call: RecordedCall) => {
    if (call.method === "files.getUploadURLExternal") {
      return { ok: true, upload_url: UPLOAD_URL, file_id: "F0FILE" };
    }
    if (call.url === UPLOAD_URL) return new Response("OK - 12", { status: 200 });
    if (call.method === "files.completeUploadExternal") return complete;
    throw new Error(`unexpected call ${call.url}`);
  };

const outputSchema = () =>
  getToolPluginMetadata(entry)?.tools.find((tool) => tool.name === "slack_file_upload")
    ?.outputSchema;

describe("slack_file_upload", () => {
  it("runs the three-step upload and shares the file into a thread", async () => {
    const shares = {
      public: { C0TEAM: [{ ts: "1726000500.000100", thread_ts: "1726000000.000001" }] },
    };
    await withMockFetch(flow(completed(shares)), async (calls) => {
      const result = await runTool("slack_file_upload", {
        title: "Weekly report",
        filename: "report.csv",
        content: "a,b\n1,2\n",
        channelId: "C0TEAM",
        threadTs: "1726000000.000001",
        initialComment: "Here's the report",
      });

      expect(calls.map((call) => call.url)).toEqual([
        "https://slack.com/api/files.getUploadURLExternal",
        UPLOAD_URL,
        "https://slack.com/api/files.completeUploadExternal",
      ]);

      const [getUrl, upload, complete] = calls;
      expect(getUrl.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(getUrl.body).toEqual({ filename: "report.csv", length: "8" });

      expect(upload.httpMethod).toBe("POST");
      expect(upload.headers.authorization).toBeUndefined();
      expect(upload.headers["content-type"]).toBe("application/octet-stream");
      expect(Buffer.from(upload.rawBody as Uint8Array).toString("utf8")).toBe("a,b\n1,2\n");

      expect(complete.body).toMatchObject({
        channel_id: "C0TEAM",
        thread_ts: "1726000000.000001",
        initial_comment: "Here's the report",
      });
      expect(JSON.parse(complete.body.files as string)).toEqual([
        { id: "F0FILE", title: "Weekly report" },
      ]);

      expect(result).toEqual({
        fileId: "F0FILE",
        permalink: "https://example.slack.com/files/U0BOT/F0FILE/report.csv",
        channelId: "C0TEAM",
        ts: "1726000500.000100",
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("keeps the file private when channelId is omitted", async () => {
    await withMockFetch(flow(), async (calls) => {
      const result = await runTool("slack_file_upload", {
        title: "notes.txt",
        content: "hello",
      });
      expect(calls[0].body).toEqual({ filename: "notes.txt", length: "5" });
      const complete = calls[2].body;
      expect(complete).not.toHaveProperty("channel_id");
      expect(complete).not.toHaveProperty("thread_ts");
      expect(complete).not.toHaveProperty("initial_comment");
      expect(result).toEqual({
        fileId: "F0FILE",
        permalink: "https://example.slack.com/files/U0BOT/F0FILE/report.csv",
        channelId: null,
        ts: null,
      });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("measures length in bytes, not characters", async () => {
    await withMockFetch(flow(), async (calls) => {
      await runTool("slack_file_upload", { title: "t.txt", content: "héllo ✓" });
      expect(calls[0].body.length).toBe(String(Buffer.byteLength("héllo ✓")));
    });
  });

  it("decodes base64 content for binary files like chart images", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await withMockFetch(flow(), async (calls) => {
      await runTool("slack_file_upload", {
        title: "Chart",
        filename: "chart.png",
        content: png.toString("base64"),
        contentEncoding: "base64",
      });
      expect(calls[0].body).toEqual({ filename: "chart.png", length: "6" });
      expect(Buffer.from(calls[1].rawBody as Uint8Array).equals(png)).toBe(true);
    });
  });

  it("reads a private channel share too", async () => {
    const shares = { private: { G0SECRET: [{ ts: "1726000600.000200" }] } };
    await withMockFetch(flow(completed(shares)), async () => {
      const result = await runTool("slack_file_upload", {
        title: "t.txt",
        content: "x",
        channelId: "G0SECRET",
      });
      expect(result).toMatchObject({ channelId: "G0SECRET", ts: "1726000600.000200" });
    });
  });

  it("returns a null ts when Slack has not reported the share yet", async () => {
    await withMockFetch(flow(), async () => {
      const result = await runTool("slack_file_upload", {
        title: "t.txt",
        content: "x",
        channelId: "C0TEAM",
      });
      expect(result).toMatchObject({ channelId: "C0TEAM", ts: null });
      expect(Value.Check(outputSchema()!, result)).toBe(true);
    });
  });

  it("fails with the HTTP status when the upload step is rejected", async () => {
    await withMockFetch(
      (call) =>
        call.url === UPLOAD_URL
          ? new Response("nope", { status: 500 })
          : flow()(call),
      async (calls) => {
        await expect(
          runTool("slack_file_upload", { title: "t.txt", content: "x", channelId: "C0TEAM" }),
        ).rejects.toThrow(/upload.*500/i);
        expect(calls.map((call) => call.method)).not.toContain("files.completeUploadExternal");
      },
    );
  });

  it("rejects empty content before calling Slack", async () => {
    await withMockFetch(flow(), async (calls) => {
      await expect(runTool("slack_file_upload", { title: "t.txt", content: "" })).rejects.toThrow(
        /empty/i,
      );
      expect(calls).toHaveLength(0);
    });
  });
});
