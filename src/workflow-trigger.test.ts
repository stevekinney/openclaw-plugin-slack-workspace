import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { recordingLogger, runTool, TEST_CONFIG, withMockFetch } from "./test-utils.js";

const TRIGGER_URL = "https://hooks.slack.com/triggers/T0TEST/000/fake-secret";
const CONFIG = { ...TEST_CONFIG, workflowTriggers: { standup: TRIGGER_URL } };

const tool = () =>
  getToolPluginMetadata(entry)?.tools.find(
    (candidate) => candidate.name === "slack_workflow_trigger_run",
  );

describe("slack_workflow_trigger_run", () => {
  it("POSTs the payload as JSON to the configured trigger URL, without a token", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      const result = await runTool(
        "slack_workflow_trigger_run",
        { name: "standup", payload: { owner: "U0ALICE", topic: "Q3 plan" } },
        CONFIG,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(TRIGGER_URL);
      expect(calls[0].httpMethod).toBe("POST");
      expect(calls[0].headers["content-type"]).toBe("application/json");
      expect(calls[0].headers.authorization).toBeUndefined();
      expect(calls[0].body).toEqual({ owner: "U0ALICE", topic: "Q3 plan" });
      expect(result).toEqual({ name: "standup", status: 200, response: { ok: true } });
    });
  });

  it("sends an empty object when no payload is given", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await runTool("slack_workflow_trigger_run", { name: "standup" }, CONFIG);
      expect(calls[0].rawBody).toBe("{}");
    });
  });

  it("returns a non-JSON response body as text", async () => {
    await withMockFetch(
      () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      async () => {
        const result = await runTool("slack_workflow_trigger_run", { name: "standup" }, CONFIG);
        expect(result).toEqual({ name: "standup", status: 200, response: "ok" });
      },
    );
  });

  it("fails on an unconfigured name before any request, listing the configured names", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await expect(
        runTool("slack_workflow_trigger_run", { name: "retro" }, CONFIG),
      ).rejects.toThrow(/No workflow trigger named "retro".*standup/);
      expect(calls).toHaveLength(0);
    });
  });

  it("explains how to configure triggers when none are configured", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await expect(
        runTool("slack_workflow_trigger_run", { name: "standup" }, TEST_CONFIG),
      ).rejects.toThrow(/workflowTriggers/);
      expect(calls).toHaveLength(0);
    });
  });

  it("does not treat inherited object keys as trigger names", async () => {
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await expect(
        runTool("slack_workflow_trigger_run", { name: "toString" }, CONFIG),
      ).rejects.toThrow(/No workflow trigger named/);
      expect(calls).toHaveLength(0);
    });
  });

  it("fails clearly when a trigger's SecretRef was not resolved", async () => {
    const config = { ...TEST_CONFIG, workflowTriggers: { standup: { source: "env", id: "X" } } };
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await expect(
        runTool("slack_workflow_trigger_run", { name: "standup" }, config),
      ).rejects.toThrow(/SecretRef was not resolved/);
      expect(calls).toHaveLength(0);
    });
  });

  it("refuses a configured URL that is not https", async () => {
    const config = {
      ...TEST_CONFIG,
      workflowTriggers: { standup: "http://hooks.slack.com/triggers/T0TEST/000/fake-secret" },
    };
    await withMockFetch(() => ({ ok: true }), async (calls) => {
      await expect(
        runTool("slack_workflow_trigger_run", { name: "standup" }, config),
      ).rejects.toThrow(/must be an https URL/);
      expect(calls).toHaveLength(0);
    });
  });

  it("surfaces an HTTP error with its status and body, never the URL", async () => {
    const logger = recordingLogger();
    await withMockFetch(
      () => new Response(JSON.stringify({ ok: false, error: "invalid_trigger" }), { status: 404 }),
      async () => {
        const failure = runTool("slack_workflow_trigger_run", { name: "standup" }, CONFIG, logger);
        await expect(failure).rejects.toThrow(/http_404.*invalid_trigger/);
        await expect(failure).rejects.not.toThrow(/fake-secret/);
      },
    );
    for (const line of logger.lines) expect(line.message).not.toContain("fake-secret");
  });

  it("returns output that matches its schema", async () => {
    await withMockFetch(() => ({ ok: true }), async () => {
      const result = await runTool("slack_workflow_trigger_run", { name: "standup" }, CONFIG);
      expect(Value.Check(tool()!.outputSchema!, result)).toBe(true);
    });
  });

  it("requires a name and takes an optional object payload", () => {
    const parameters = tool()!.parameters;
    expect(Value.Check(parameters, { name: "standup" })).toBe(true);
    expect(Value.Check(parameters, { name: "standup", payload: { a: "b" } })).toBe(true);
    expect(Value.Check(parameters, { payload: {} })).toBe(false);
    expect(Value.Check(parameters, { name: "" })).toBe(false);
    expect(Value.Check(parameters, { name: "standup", payload: "text" })).toBe(false);
  });
});

describe("workflowTriggers config", () => {
  const schema = entry.configSchema as { safeParse: (value: unknown) => { success: boolean } };

  it("accepts a map of names to URLs or SecretRefs", () => {
    expect(
      schema.safeParse({
        workflowTriggers: { standup: TRIGGER_URL, retro: { source: "env", id: "RETRO_TRIGGER" } },
      }).success,
    ).toBe(true);
  });

  it("rejects non-string, non-SecretRef entries", () => {
    expect(schema.safeParse({ workflowTriggers: { standup: 42 } }).success).toBe(false);
    expect(schema.safeParse({ workflowTriggers: "standup" }).success).toBe(false);
  });
});
