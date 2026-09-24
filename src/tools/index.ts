import { defineTool } from "../tool.js";
import { bookmarkTools } from "./bookmarks.js";
import { canvasTools } from "./canvases.js";
import { channelTools } from "./channels.js";
import { identityTools } from "./identity.js";
import { messagingTools } from "./messaging.js";
import { schedulingTools } from "./scheduling.js";
import { searchTools } from "./search.js";

/** Every tool this plugin registers, in manifest `contracts.tools` order. */
export const tools = [
  ...identityTools(defineTool),
  ...searchTools(defineTool),
  ...schedulingTools(defineTool),
  ...messagingTools(defineTool),
  ...canvasTools(defineTool),
  ...bookmarkTools(defineTool),
  ...channelTools(defineTool),
];
