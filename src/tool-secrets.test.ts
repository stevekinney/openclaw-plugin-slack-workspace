import { describe, expect, it, vi } from "vitest";
import { resolveToolConfig } from "./tool.js";

const botRef = { source: "store", provider: "default", id: "TEST_BOT_TOKEN" };
const userRef = { source: "store", provider: "default", id: "TEST_USER_TOKEN" };
const triggerRef = { source: "store", provider: "default", id: "TEST_TRIGGER" };

describe("tool SecretRefs", () => {
  it("resolves token and trigger refs at execution time through the host config", async () => {
    const hostConfig = {};
    const resolve = vi.fn(async ({ path }: { path: string }) => ({
      value: path.endsWith("botToken") ? "xoxb-test" :
        path.endsWith("userToken") ? "xoxp-test" : "https://hooks.slack.com/triggers/test",
    }));
    const authored = {
      botToken: botRef,
      userToken: userRef,
      workflowTriggers: { standup: triggerRef },
    };
    const config = await resolveToolConfig(authored, hostConfig, resolve);
    expect(config).toEqual({
      botToken: "xoxb-test",
      userToken: "xoxp-test",
      workflowTriggers: { standup: "https://hooks.slack.com/triggers/test" },
    });
    expect(authored.botToken).toBe(botRef);
    expect(authored.workflowTriggers.standup).toBe(triggerRef);
    expect(resolve.mock.calls.map(([args]) => args.path)).toEqual([
      "plugins.entries.slack-workspace.config.botToken",
      "plugins.entries.slack-workspace.config.userToken",
      "plugins.entries.slack-workspace.config.workflowTriggers.standup",
    ]);
  });

  it("leaves an unresolved ref in place so the called tool fails closed", async () => {
    const config = await resolveToolConfig({ botToken: botRef }, {}, async () => ({}));
    expect(config.botToken).toBe(botRef);
  });
});
