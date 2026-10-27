import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceCache } from "./client.js";
import { routingTestHost, withMockFetch } from "./test-utils.js";

const incoming = {
  channel: "slack", accountId: "default", workspaceId: "TTEST", conversationId: "DTEST",
  senderId: "UTEST", messageId: "2000.000001", content: "Please continue", isDirect: true,
  agentId: "main", sessionKey: "agent:main:default",
};
const response = (method: string) => method === "auth.test"
  ? { ok: true, team_id: "TTEST", user_id: "UBOT", url: "https://test.slack.com/" }
  : { ok: true, channel: "DTEST", ts: "1000.000001", permalink: "https://test.slack.com/archives/DTEST/p1000000001" };

describe("registered Slack routing", () => {
  beforeEach(resetWorkspaceCache);

  it("resolves configured targets without trusted-plugin Gateway privileges", async () => {
    const host = routingTestHost({ enabled: true, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:default" } } });
    host.api.runtime.gateway.request = vi.fn(async () => { throw new Error("Gateway requests are only available to bundled or trusted official plugins"); });
    await withMockFetch(({ method }) => response(method), async () => {
      expect(await host.hooks.get("resolve_inbound_route")!(incoming, {})).toMatchObject({ expectedSessionId: "default-id" });
    });
    expect(host.api.runtime.gateway.request).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: "other-account", workspaceId: "TTEST" },
    { accountId: "default", workspaceId: "TOTHER" },
  ])("keeps unmatched DM identity on native routing: $accountId/$workspaceId", async (identity) => {
    const host = routingTestHost({ enabled: true, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:default" } } });
    await withMockFetch(({ method }) => response(method), async () => {
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, ...identity }, {})).toBeUndefined();
      expect(host.namespaces.get("slack-routing-targets")?.size).toBe(0);
    });
  });

  it("fails closed for a DM default when the token workspace cannot be authenticated", async () => {
    const host = routingTestHost({ enabled: true, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:default" } } });
    await withMockFetch(() => ({ ok: false, error: "invalid_auth" }), async () => {
      expect(await host.hooks.get("resolve_inbound_route")!(incoming, {})).toBeUndefined();
      expect(host.namespaces.get("slack-routing-targets")?.size).toBe(0);
    });
  });

  it.each([
    { userId: "UOTHER" },
    { channelId: "DOTHER" },
  ])("rejects prepared interaction identity overrides: %j", async (identity) => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      await expect(host.run("slack_interaction_prepare", { kind: "modal", ...identity, view: { type: "modal", title: { type: "plain_text", text: "Review" }, blocks: [] } })).rejects.toThrow(/must match the trusted/);
      expect(host.namespaces.get("slack-routing-interactions")?.size).toBe(0);
    });
  });

  it.each([
    { messageChannel: undefined, nativeChannelId: undefined, requesterSenderId: undefined },
    { messageChannel: "discord", nativeChannelId: "DTEST", requesterSenderId: "UTEST" },
    { messageChannel: "slack", nativeChannelId: undefined, requesterSenderId: "UTEST" },
    { messageChannel: "slack", nativeChannelId: "DTEST", requesterSenderId: undefined },
  ])("requires a trusted Slack turn for interaction preparation: %j", async (context) => {
    const host = routingTestHost();
    Object.assign(host.turn, context);
    await withMockFetch(({ method }) => response(method), async () => {
      await expect(host.run("slack_interaction_prepare", { kind: "options", channelId: "DTEST", userId: "UTEST", options: [{ text: { type: "plain_text", text: "Alpha" }, value: "a" }] })).rejects.toThrow(/trusted Slack/);
      expect(host.namespaces.get("slack-routing-interactions")?.size).toBe(0);
    });
  });

  it("records the tool's actual origin and routes an explicit reply back to it", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      await host.run("slack_blocks_send", { text: "Ready for review", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Ready" } }] });
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1000.000001" }, {})).toMatchObject({
        agentId: "main", sessionKey: "agent:main:origin", expectedSessionId: "origin-id", reason: "reply",
      });
    });
  });

  it("does not revive an archived origin and drops its interactive controls", async () => {
    const host = routingTestHost({ enabled: true, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:default" } } });
    await withMockFetch(({ method }) => response(method), async () => {
      await host.run("slack_blocks_send", { text: "Ready", blocks: [{ type: "divider" }] });
      host.sessions.set("agent:main:origin", { key: "agent:main:origin", agentId: "main", sessionId: "origin-id", archivedAt: Date.now() });
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1000.000001" }, {})).toMatchObject({ sessionKey: "agent:main:default", expectedSessionId: "default-id" });
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, interaction: { kind: "button", messageTs: "1000.000001" } }, {})).toMatchObject({ drop: expect.any(Object) });
    });
  });

  it("pins fixed DM rules across resets and plugin restarts", async () => {
    const host = routingTestHost({ enabled: true, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:default" } } });
    await withMockFetch(({ method }) => response(method), async () => {
      expect(await host.hooks.get("resolve_inbound_route")!(incoming, {})).toMatchObject({ expectedSessionId: "default-id" });
      host.sessions.set("agent:main:default", { key: "agent:main:default", agentId: "main", sessionId: "replacement" });
      host.register();
      expect(await host.hooks.get("resolve_inbound_route")!(incoming, {})).toBeUndefined();
    });
  });

  it("preserves origin ownership when another session edits a card", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      await host.run("slack_blocks_send", { text: "Ready", blocks: [{ type: "divider" }] });
      host.turn.sessionKey = "agent:main:default";
      host.turn.sessionId = "default-id";
      await host.run("slack_blocks_update", { ts: "1000.000001", text: "Updated", blocks: [{ type: "divider" }] });
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1000.000001" }, {})).toMatchObject({ expectedSessionId: "origin-id" });
    });
  });

  it("keeps server-scheduled origins using an opaque block marker, not broken Slack metadata", async () => {
    const host = routingTestHost();
    let scheduledBlocks: unknown;
    const deliveredTs = String(Date.now() / 1000);
    let deliveredUser = "UFORGED";
    await withMockFetch(({ method, body }) => {
      if (method === "auth.test") return response(method);
      if (method === "chat.scheduleMessage") {
        scheduledBlocks = body.blocks;
        expect(body.metadata).toBeUndefined();
        expect(JSON.stringify(body.blocks)).not.toContain("origin-id");
        return { ok: true, channel: "DTEST", scheduled_message_id: "QTEST" };
      }
      if (method === "conversations.replies") return { ok: true, messages: [{ ts: deliveredTs, user: deliveredUser, text: "Scheduled reminder", blocks: scheduledBlocks }] };
      throw new Error(`Unexpected API ${method}`);
    }, async () => {
      const postAt = Math.floor(Date.now() / 1000) + 60;
      await host.run("slack_schedule_message", { channelId: "DTEST", text: "Scheduled reminder", postAt });
      // A delivery record is not eligible before its scheduled time.
      const entries = host.namespaces.get("slack-routing-pending")!;
      for (const row of entries.values()) (row.value as { dueAt: number }).dueAt = Date.now() - 1000;
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: deliveredTs }, {})).toBeUndefined();
      deliveredUser = "UBOT";
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: deliveredTs }, {})).toMatchObject({ expectedSessionId: "origin-id" });
    });
  });

  it("records native Slack send events using the host event/context contract", async () => {
    const host = routingTestHost();
    await host.hooks.get("message_sent")!({ success: true, content: "Native reply", messageId: "1001.000001", sessionId: "origin-id", workspaceId: "TTEST" }, {
      channelId: "slack", accountId: "default", conversationId: "DTEST", sessionKey: "agent:main:origin",
    });
    expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1001.000001" }, {})).toMatchObject({ expectedSessionId: "origin-id" });
    await host.hooks.get("message_sent")!({ success: false, content: "Failed", messageId: "1002.000001", sessionId: "origin-id", workspaceId: "TTEST" }, {
      channelId: "slack", accountId: "default", conversationId: "DTEST", sessionKey: "agent:main:origin",
    });
    expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1002.000001" }, {})).toBeUndefined();
  });

  it("accepts explicit interaction identity only when it matches the trusted turn", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      const result = await host.run("slack_interaction_prepare", { kind: "options", channelId: "DTEST", userId: "UTEST", options: [{ text: { type: "plain_text", text: "Alpha" }, value: "a" }] });
      expect(result.details).toMatchObject({ actionId: expect.stringMatching(/^slack-workspace:options:/) });
    });
  });

  it("prepares and handles modal/options callbacks through the registered tool and handler", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      const result = await host.run("slack_interaction_prepare", { kind: "modal", view: { type: "modal", title: { type: "plain_text", text: "Review" }, blocks: [] } });
      const prepared = result.details as { actionId: string };
      const openModal = vi.fn(async () => undefined);
      const context = { accountId: "default", workspaceId: "TTEST", conversationId: "DTEST", senderId: "UTEST", auth: { isAuthorizedSender: true }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond: { openModal } };
      expect(await host.handlers.get("slack-workspace")!(context)).toEqual({ handled: true });
      expect(await host.handlers.get("slack-workspace")!(context)).toEqual({ handled: true });
      expect(openModal).toHaveBeenCalledTimes(1);
      const view = openModal.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(JSON.stringify(view)).not.toContain("origin-id");
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, interaction: { kind: "view_submission", callbackId: prepared.actionId } }, {})).toMatchObject({ expectedSessionId: "origin-id" });
      const optionsResult = await host.run("slack_interaction_prepare", { kind: "options", options: [{ text: { type: "plain_text", text: "Alpha" }, value: "a" }] });
      const options = vi.fn(async () => undefined);
      await host.handlers.get("slack-workspace")!({ ...context, interaction: { kind: "options", actionId: (optionsResult.details as { actionId: string }).actionId, payload: "", query: "alp" }, respond: { options } });
      expect(options).toHaveBeenCalledWith([{ text: { type: "plain_text", text: "Alpha" }, value: "a" }]);
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, interaction: { kind: "select", actionId: (optionsResult.details as { actionId: string }).actionId } }, {})).toMatchObject({ expectedSessionId: "origin-id" });
    });
  });

  it.each([
    { kind: "options", reference: "V_PROVIDER_VIEW" },
    { kind: "select", reference: "B_PROVIDER_BLOCK" },
    { kind: "select", reference: "another-prepared-reference" },
  ])("keeps the prepared origin when $kind includes a provider reference", async ({ kind, reference }) => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      const result = await host.run("slack_interaction_prepare", { kind: "options", options: [{ text: { type: "plain_text", text: "Alpha" }, value: "a" }] });
      const prepared = result.details as { actionId: string };
      host.turn.sessionKey = "agent:main:default";
      host.turn.sessionId = "default-id";
      await host.run("slack_blocks_send", { text: "Another session's card", blocks: [{ type: "divider" }] });
      const another = await host.run("slack_interaction_prepare", { kind: "options", options: [{ text: { type: "plain_text", text: "Other" }, value: "other" }] });
      const providerReference = reference === "another-prepared-reference" ? (another.details as { actionId: string }).actionId : reference;
      const event = { ...incoming, interaction: { kind, reference: providerReference, actionId: prepared.actionId, messageTs: "1000.000001" } };
      expect(await host.hooks.get("resolve_inbound_route")!(event, {})).toMatchObject({ expectedSessionId: "origin-id", reason: "interaction" });
      host.sessions.set("agent:main:origin", { key: "agent:main:origin", agentId: "main", sessionId: "origin-id", archivedAt: Date.now() });
      expect(await host.hooks.get("resolve_inbound_route")!(event, {})).toMatchObject({ drop: expect.any(Object) });
    });
  });

  it("removes deleted message origins and retired session generations", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async () => {
      await host.run("slack_blocks_send", { text: "Ready", blocks: [{ type: "divider" }] });
      await host.hooks.get("session_end")!({ sessionId: "origin-id", reason: "reset" }, {});
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1000.000001" }, {})).toBeUndefined();
    });
  });


  it("fails registration when routing is enabled on an unsupported host", () => {
    const host = routingTestHost();
    host.api.runtime.channel.routing.inboundRouteContractVersion = 0;
    expect(() => host.register()).toThrow(/contract version 1/);
  });

  it("reports a committed send's tracking failure without sending it again", async () => {
    const host = routingTestHost();
    host.turn.sessionId = undefined;
    await withMockFetch(({ method }) => response(method), async (calls) => {
      const result = await host.run("slack_blocks_send", { text: "Ready", blocks: [{ type: "divider" }] }) as unknown as { content: Array<{ text: string }> };
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
      expect(result.content.some((item) => item.text.includes("Do not resend"))).toBe(true);
      expect(host.logger.lines.some((line) => line.level === "warn" && line.message.includes("committed"))).toBe(true);
      expect(await host.hooks.get("resolve_inbound_route")!({ ...incoming, replyToId: "1000.000001" }, {})).toBeUndefined();
    });
  });


  it("rejects a scheduled message without room for the origin marker before posting", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => response(method), async (calls) => {
      await expect(host.run("slack_schedule_message", { channelId: "DTEST", text: "Ready", blocks: Array.from({ length: 50 }, () => ({ type: "divider" })), postAt: Math.floor(Date.now() / 1000) + 60 })).rejects.toThrow(/49 content blocks/);
      expect(calls.some((call) => call.method === "chat.scheduleMessage")).toBe(false);
    });
  });

  it("does not record rejected Slack sends", async () => {
    const host = routingTestHost();
    await withMockFetch(({ method }) => method === "chat.postMessage" ? { ok: false, error: "invalid_blocks" } : response(method), async () => {
      await expect(host.run("slack_blocks_send", { text: "Ready", blocks: [{ type: "divider" }] })).rejects.toThrow(/invalid_blocks/);
      expect(host.namespaces.get("slack-routing-messages")?.size).toBe(0);
    });
  });


  it("retains modal state at the configured interaction capacity after replay claims", async () => {
    const host = routingTestHost({ enabled: true, retention: { maximumInteractions: 1 } });
    await withMockFetch(({ method }) => response(method), async () => {
      const result = await host.run("slack_interaction_prepare", { kind: "modal", view: { type: "modal", title: { type: "plain_text", text: "Review" }, blocks: [] } });
      const prepared = result.details as { actionId: string };
      const context = { accountId: "default", workspaceId: "TTEST", conversationId: "DTEST", senderId: "UTEST", auth: { isAuthorizedSender: true }, interaction: { kind: "button", actionId: prepared.actionId, payload: "" }, respond: { openModal: async () => undefined, acknowledge: async () => undefined } };
      await host.handlers.get("slack-workspace")!(context);
      expect(await host.handlers.get("slack-workspace")!({ ...context, interaction: { kind: "view_submission", callbackId: prepared.actionId, payload: "" } })).toMatchObject({ handled: false, systemEvent: { reference: prepared.actionId } });
      expect(host.namespaces.get("slack-routing-interactions")?.size).toBe(1);
      expect(host.namespaces.get("slack-routing-interaction-replay")?.size).toBe(2);
    });
  });

});
