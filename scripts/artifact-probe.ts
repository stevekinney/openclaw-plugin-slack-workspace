import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntryAsync, patchSessionEntry, resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

type Registration = Parameters<OpenClawPluginApi["registerTool"]>[0];
type RouteHandler = (event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

/** Executes the installed artifact with a real host API; only registration and Slack HTTP are intercepted. */
async function verify(api: OpenClawPluginApi): Promise<void> {
  const entryPath = process.env.SLACK_ARTIFACT_ENTRY;
  const receipt = process.env.SLACK_ARTIFACT_RECEIPT;
  assert(entryPath && receipt);
  const companion = process.env.SLACK_ARTIFACT_COMPANION === "1";
  const source: unknown = (await import(pathToFileURL(entryPath).href)).default;
  assert(source && typeof source === "object" && "register" in source && typeof source.register === "function");
  const origin = { agentId: "main", sessionKey: "agent:main:release-origin", sessionId: randomUUID() };
  const fallback = { agentId: "main", sessionKey: "agent:main:release-fallback", sessionId: randomUUID() };
  const turn = { ...origin, messageChannel: "slack", nativeChannelId: "DRELEASE", requesterSenderId: "URELEASE" };
  const registrations: Registration[] = [];
  const hooks = new Map<string, RouteHandler>();
  const interactions: unknown[] = [];
  const proxy = new Proxy(api, {
    get(target, key, receiver) {
      if (key === "registerTool") return (registration: Registration) => registrations.push(registration);
      if (key === "on") return (name: string, handler: RouteHandler) => hooks.set(name, handler);
      if (key === "registerCli") return () => {};
      if (key === "registerInteractiveHandler") return (registration: unknown) => interactions.push(registration);
      return Reflect.get(target, key, receiver);
    },
  });
  source.register(proxy);
  const tools = registrations.flatMap((registration) => {
    if (typeof registration === "function") {
      const tool = registration(turn);
      return tool ? Array.isArray(tool) ? tool : [tool] : [];
    }
    assert("execute" in registration, "Artifact changed its tool factory contract");
    return [registration];
  });
  assert(tools.length > 0);
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://slack.com");
    const method = url.pathname.replace("/api/", "");
    calls.push(method);
    const responses: Record<string, unknown> = {
      "auth.test": { ok: true, url: "https://release-fixture.slack.com/", team: "Release fixture", team_id: "TRELEASE", user: "release-bot", user_id: "UBOT" },
      "chat.postMessage": { ok: true, channel: "DRELEASE", ts: "1000.000001" },
      "chat.getPermalink": { ok: true, permalink: "https://example.invalid/release-message" },
    };
    assert(Object.hasOwn(responses, method), `Unexpected Slack request: ${method}`);
    return new Response(JSON.stringify(responses[method]), { headers: { "content-type": "application/json", "x-oauth-scopes": "chat:write" } });
  };
  const identity = tools.find((tool) => tool.name === "slack_identity");
  assert(identity);
  const result = await identity.execute("release-identity", {});
  assert(result.details && typeof result.details === "object" && "userId" in result.details);
  assert.equal(result.details.userId, "UBOT");
  if (!companion) {
    assert.equal(hooks.has("resolve_inbound_route"), false);
    assert.equal(interactions.length, 0);
  } else {
    const routing = api.runtime.channel.routing;
    assert("inboundRouteContractVersion" in routing && routing.inboundRouteContractVersion === 1);
    assert.equal(interactions.length, 1);
    for (const target of [origin, fallback]) {
      await upsertSessionEntry({
        agentId: target.agentId, sessionKey: target.sessionKey,
        storePath: resolveStorePath(api.config.session?.store, { agentId: target.agentId }),
        entry: { sessionId: target.sessionId, updatedAt: Date.now() },
      });
      assert.equal((await getSessionEntryAsync({ agentId: target.agentId, sessionKey: target.sessionKey }))?.sessionId, target.sessionId);
    }
    const send = tools.find((tool) => tool.name === "slack_blocks_send");
    assert(send);
    const sent = await send.execute("release-send", { channelId: "DRELEASE", text: "Release artifact", blocks: [{ type: "divider" }] });
    assert(!JSON.stringify(sent).includes("bookkeeping failed"), "Outbound provenance must persist after Slack accepts the message");
    const route = hooks.get("resolve_inbound_route");
    assert(route);
    const event = {
      channel: "slack", accountId: "default", workspaceId: "TRELEASE", conversationId: "DRELEASE",
      senderId: "URELEASE", messageId: "2000.000001", content: "Continue", isDirect: true,
      agentId: "main", sessionKey: fallback.sessionKey, replyToId: "1000.000001",
    };
    assert.equal((await route(event))?.expectedSessionId, origin.sessionId);
    const interaction = { ...event, interaction: { kind: "button", messageTs: "1000.000001" } };
    assert.equal((await route(interaction))?.expectedSessionId, origin.sessionId);
    await patchSessionEntry({ agentId: origin.agentId, sessionKey: origin.sessionKey, update: () => ({ archivedAt: Date.now() }) });
    assert.equal((await route(event))?.expectedSessionId, fallback.sessionId);
    assert((await route(interaction))?.drop);
  }
  writeFileSync(receipt, JSON.stringify({ companion, toolCount: tools.length, calls, verified: true }));
}

export default {
  id: "slack-release-probe",
  register(api: OpenClawPluginApi) {
    api.registerCli(({ program }) => {
      program.command("slack-release-probe").action(async () => {
        try { await verify(api); } catch (error) { console.error(error); throw error; }
      });
    }, { descriptors: [{ name: "slack-release-probe", description: "Verify the packed Slack artifact", hasSubcommands: false }] });
  },
};
