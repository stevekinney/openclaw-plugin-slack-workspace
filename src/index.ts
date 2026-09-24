import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { configSchema } from "./schemas.js";
import { bookmarkTools } from "./tools/bookmarks.js";
import { canvasTools } from "./tools/canvases.js";
import { identityTools } from "./tools/identity.js";
import { messagingTools } from "./tools/messaging.js";
import { schedulingTools } from "./tools/scheduling.js";
import { searchTools } from "./tools/search.js";

export default defineToolPlugin({
  id: "slack-workspace",
  name: "Slack Workspace",
  description: "Create and edit Slack canvases and manage channel bookmarks.",
  configSchema,
  tools: (tool) => [
    ...identityTools(tool),
    ...searchTools(tool),
    ...schedulingTools(tool),
    ...messagingTools(tool),
    ...canvasTools(tool),
    ...bookmarkTools(tool),
  ],
});
