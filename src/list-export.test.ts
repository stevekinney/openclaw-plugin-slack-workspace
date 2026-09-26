import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const outputSchema = (name: string) =>
  getToolPluginMetadata(entry)!.tools.find((tool) => tool.name === name)!.outputSchema!;

const URL_CSV = "https://files.slack.com/files-pri/T0-F0LIST/csv/list";

/** start → `pending` IN_PROGRESS polls → COMPLETED. */
const exportFlow = (pending: number) => {
  let polls = 0;
  return (call: RecordedCall) => {
    if (call.method === "slackLists.download.start") return { ok: true, job_id: "LeJOB" };
    polls += 1;
    return polls <= pending
      ? { ok: true, status: "IN_PROGRESS" }
      : { ok: true, status: "COMPLETED", download_url: URL_CSV };
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("slack_list_export", () => {
  it("starts an export and polls until the download is ready", async () => {
    vi.useFakeTimers();
    await withMockFetch(exportFlow(2), async (calls) => {
      const pending = runTool("slack_list_export", { listId: "F0LIST" });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(calls.map((call) => call.method)).toEqual([
        "slackLists.download.start",
        "slackLists.download.get",
        "slackLists.download.get",
        "slackLists.download.get",
      ]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", format: "csv" });
      expect(calls[1]!.body).toEqual({ list_id: "F0LIST", job_id: "LeJOB", format: "csv" });
      expect(result).toEqual({
        listId: "F0LIST",
        jobId: "LeJOB",
        format: "csv",
        status: "COMPLETED",
        ready: true,
        downloadUrl: URL_CSV,
      });
      expect(Value.Check(outputSchema("slack_list_export"), result)).toBe(true);
    });
  });

  it("waits between polls instead of hammering Slack", async () => {
    vi.useFakeTimers();
    await withMockFetch(exportFlow(1), async (calls) => {
      const pending = runTool("slack_list_export", { listId: "F0LIST" });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
      await pending;
    });
  });

  it("passes JSON export options to both start and get", async () => {
    vi.useFakeTimers();
    await withMockFetch(exportFlow(0), async (calls) => {
      const pending = runTool("slack_list_export", {
        listId: "F0LIST",
        format: "json",
        includeArchived: true,
        includeThreads: true,
        includeAttachments: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(calls[0]!.body).toEqual({
        list_id: "F0LIST",
        format: "json",
        include_archived: true,
        include_threads: true,
        include_attachments: false,
      });
      expect(calls[1]!.body).toEqual({
        list_id: "F0LIST",
        job_id: "LeJOB",
        format: "json",
        include_threads: true,
        include_attachments: false,
      });
    });
  });

  it("refuses JSON-only options on a CSV export before calling Slack", async () => {
    await withMockFetch(exportFlow(0), async (calls) => {
      await expect(
        runTool("slack_list_export", { listId: "F0LIST", includeThreads: true }),
      ).rejects.toThrow("format: \"json\"");
      expect(calls).toEqual([]);
    });
  });

  it("returns the job as pending after the maximum number of polls", async () => {
    vi.useFakeTimers();
    await withMockFetch(exportFlow(Infinity), async (calls) => {
      const pending = runTool("slack_list_export", { listId: "F0LIST" });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      const polls = calls.filter((call) => call.method === "slackLists.download.get");
      expect(polls).toHaveLength(10);
      expect(result).toEqual({
        listId: "F0LIST",
        jobId: "LeJOB",
        format: "csv",
        status: "IN_PROGRESS",
        ready: false,
      });
      expect(Value.Check(outputSchema("slack_list_export"), result)).toBe(true);
    });
  });

  it("stops polling once the timeout passes, even under the attempt cap", async () => {
    vi.useFakeTimers();
    await withMockFetch(
      async (call) => {
        if (call.method === "slackLists.download.start") return { ok: true, job_id: "LeJOB" };
        // A slow Slack: each poll takes 10 seconds to answer.
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { ok: true, status: "IN_PROGRESS" };
      },
      async (calls) => {
        const pending = runTool("slack_list_export", { listId: "F0LIST" });
        await vi.advanceTimersByTimeAsync(120_000);
        const result = (await pending) as { ready: boolean };
        const polls = calls.filter((call) => call.method === "slackLists.download.get");
        expect(polls.length).toBeLessThan(10);
        expect(polls.length).toBeGreaterThan(0);
        expect(result.ready).toBe(false);
      },
    );
  });

  it("resumes polling an existing job without starting a new export", async () => {
    vi.useFakeTimers();
    await withMockFetch(exportFlow(0), async (calls) => {
      const pending = runTool("slack_list_export", { listId: "F0LIST", jobId: "LeOLD" });
      await vi.advanceTimersByTimeAsync(0);
      const result = (await pending) as { jobId: string; ready: boolean };
      expect(calls.map((call) => call.method)).toEqual(["slackLists.download.get"]);
      expect(calls[0]!.body).toEqual({ list_id: "F0LIST", job_id: "LeOLD", format: "csv" });
      expect(result).toMatchObject({ jobId: "LeOLD", ready: true });
    });
  });

  it("throws when the export job fails", async () => {
    vi.useFakeTimers();
    await withMockFetch(
      (call) =>
        call.method === "slackLists.download.start"
          ? { ok: true, job_id: "LeJOB" }
          : { ok: true, status: "FAILED" },
      async () => {
        const pending = runTool("slack_list_export", { listId: "F0LIST" });
        const assertion = expect(pending).rejects.toThrow("LeJOB ended with status FAILED");
        await vi.advanceTimersByTimeAsync(0);
        await assertion;
      },
    );
  });

  it("surfaces list_not_found from the start call", async () => {
    await withMockFetch(
      () => ({ ok: false, error: "list_not_found" }),
      async (calls) => {
        await expect(runTool("slack_list_export", { listId: "F0GONE" })).rejects.toThrow(
          "slackLists.download.start failed: list_not_found",
        );
        expect(calls).toHaveLength(1);
      },
    );
  });
});
