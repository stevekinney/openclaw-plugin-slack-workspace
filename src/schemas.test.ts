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
    expect(withChannelId.length).toBe(12);
    for (const tool of withChannelId) {
      const channelId = (tool.parameters as JsonSchema).properties!.channelId;
      expect(channelId.type, tool.name).toBe("string");
      expect(channelId.description?.startsWith(CHANNEL_ID_DESCRIPTION), tool.name).toBe(true);
    }
  });
});
