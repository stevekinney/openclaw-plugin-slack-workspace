import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  toolPluginMetadataSymbol,
  type ToolPluginMetadata,
} from "openclaw/plugin-sdk/tool-plugin";
import type { TSchema } from "typebox";
import { registerDoctorCli } from "./doctor.js";
import { beforeToolCall } from "./hooks.js";
import { configSchema } from "./schemas.js";
import { registerTools } from "./tool.js";
import { tools } from "./tools/index.js";

/** TypeBox schemas are plain JSON Schema objects; the SDK types them separately. */
const jsonSchema = (schema: TSchema) => schema as unknown as ToolPluginMetadata["configSchema"];

const id = "slack-workspace";
const name = "Slack Workspace";
const description =
  "Slack workspace tools: identity and message scheduling, search, structured messaging (tables, plans, charts, rich text), raw Block Kit messages, canvases, channel bookmarks, public-channel lifecycle (create, archive, rename, topic, purpose, invite, join, leave, one-call kickoff), Slack Lists, file uploads, and Workflow Builder webhook triggers.";
const pluginConfigSchema = buildJsonPluginConfigSchema(jsonSchema(configSchema));

const entry = definePluginEntry({
  id,
  name,
  description,
  configSchema: pluginConfigSchema,
  register(api) {
    registerTools(api, tools);
    const [first, ...rest] = tools.map((tool) => tool.name);
    api.on("before_tool_call", beforeToolCall, { matcher: [first, ...rest] });
    registerDoctorCli(api);
  },
});

// `openclaw plugins build`/`validate` only read entries that carry authoring metadata.
// Attach it the way the SDK's own `defineFeaturePlugin` does, so the CLI keeps
// checking the hand-authored manifest's id, configSchema, and contracts.tools
// against the code.
const metadata: ToolPluginMetadata = {
  id,
  name,
  description,
  activation: { onStartup: true },
  configSchema: pluginConfigSchema.jsonSchema ?? jsonSchema(configSchema),
  tools: tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: jsonSchema(tool.parameters),
    ...(tool.outputSchema ? { outputSchema: jsonSchema(tool.outputSchema) } : {}),
  })),
};
Object.defineProperty(entry, toolPluginMetadataSymbol, { value: metadata, enumerable: false });

export default entry;
