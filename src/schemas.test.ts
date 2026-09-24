import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { CHANNEL_ID_DESCRIPTION, channelIdParam } from "./schemas.js";

type JsonSchema = { properties?: Record<string, { type?: string; description?: string }> };

describe("channelIdParam", () => {
  it("uses the canonical description on its own", () => {
    expect(channelIdParam()).toMatchObject({
      type: "string",
      description: CHANNEL_ID_DESCRIPTION,
    });
  });

  it("appends a usage note after the canonical description", () => {
    expect(channelIdParam("Omit for all channels.")).toMatchObject({
      description: `${CHANNEL_ID_DESCRIPTION} Omit for all channels.`,
    });
  });

  it("is the source of every tool's channelId parameter", () => {
    const tools = getToolPluginMetadata(entry)?.tools ?? [];
    const withChannelId = tools.filter(
      (tool) => (tool.parameters as JsonSchema).properties?.channelId,
    );
    expect(withChannelId.length).toBe(25);
    for (const tool of withChannelId) {
      const channelId = (tool.parameters as JsonSchema).properties!.channelId;
      expect(channelId.type, tool.name).toBe("string");
      expect(channelId.description?.startsWith(CHANNEL_ID_DESCRIPTION), tool.name).toBe(true);
    }
  });
});

describe("configSchema", () => {
  const schema = entry.configSchema as {
    safeParse: (value: unknown) => { success: boolean };
    jsonSchema?: Record<string, unknown>;
  };

  it("forbids additional properties", () => {
    expect(schema.jsonSchema).toMatchObject({ additionalProperties: false });
  });

  it("accepts the documented token keys", () => {
    expect(schema.safeParse({ botToken: "xoxb-test", userToken: "xoxp-test" }).success).toBe(true);
    expect(schema.safeParse({ botToken: { source: "env", id: "SLACK_BOT_TOKEN" } }).success).toBe(true);
  });

  it("rejects an unknown (typo'd) config key", () => {
    expect(schema.safeParse({ boToken: "xoxb-test" }).success).toBe(false);
  });

  it("does not claim a reminders tool in the userToken description", () => {
    expect(JSON.stringify(schema.jsonSchema)).not.toMatch(/reminders/);
  });
});

describe("plugin description", () => {
  it("names all six tool domains", () => {
    const description = getToolPluginMetadata(entry)?.description ?? "";
    for (const domain of ["identity", "schedul", "search", "structured", "Block Kit", "canvas", "bookmark"]) {
      expect(description, domain).toContain(domain);
    }
  });
});
