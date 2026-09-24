import { vi } from "vitest";
import entry from "./index.js";

/** Obviously fake tokens. Tests must never see a real one. */
export const TEST_CONFIG = { botToken: "xoxb-test", userToken: "xoxp-test" };

/** One intercepted Slack request, decoded for assertions. */
export type RecordedCall = {
  /** Slack Web API method, e.g. `chat.postMessage`. */
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON bodies are parsed; form bodies are decoded into a string map. */
  body: Record<string, unknown>;
  /** HTTP verb, e.g. `POST`. */
  httpMethod: string;
  /** The request body exactly as sent, for non-JSON payloads like file bytes. */
  rawBody: unknown;
};

/** A handler returns a Slack JSON payload, or a full Response for header/status control. */
export type MockFetchHandler = (
  call: RecordedCall,
) => Record<string, unknown> | Response | Promise<Record<string, unknown> | Response>;

/** Build a Slack-shaped JSON response. */
export function slackResponse(data: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function decodeBody(body: unknown, contentType: string): Record<string, unknown> {
  if (typeof body !== "string" || body === "") return {};
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Run `fn` with `globalThis.fetch` replaced by `handler`, in the scoped style of
 * OpenClaw's `plugin-sdk/test-env` helpers (`withEnv`, `withFetchPreconnect`).
 * Every request is recorded and the real fetch is restored afterward, even on throw.
 */
export async function withMockFetch<T>(
  handler: MockFetchHandler,
  fn: (calls: RecordedCall[]) => Promise<T>,
): Promise<T> {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: RecordedCall = {
      method: new URL(url).pathname.replace(/^\/api\//, ""),
      url,
      headers,
      body: decodeBody(init.body, headers["content-type"] ?? ""),
      httpMethod: init.method ?? "GET",
      rawBody: init.body,
    };
    calls.push(call);
    const result = await handler(call);
    return result instanceof Response ? result : slackResponse(result);
  });
  vi.stubGlobal("fetch", mock);
  try {
    return await fn(calls);
  } finally {
    vi.unstubAllGlobals();
  }
}

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ details: unknown }>;
};

/** Log lines captured from the fake plugin logger, tagged by level. */
export type LogLine = { level: "debug" | "info" | "warn" | "error"; message: string };

/** A plugin logger that records every line so tests can assert on (and scan) it. */
export function recordingLogger(lines: LogLine[] = []) {
  const record = (level: LogLine["level"]) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** One `api.on(...)` registration captured from the fake plugin API. */
export type RegisteredHook = {
  hookName: string;
  handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
  opts?: { matcher?: readonly string[]; priority?: number };
};

/** One `api.registerCli(...)` registration captured from the fake plugin API. */
export type RegisteredCli = {
  registrar: (ctx: Record<string, unknown>) => void | Promise<void>;
  opts?: { commands?: readonly string[]; descriptors?: readonly Record<string, unknown>[] };
};

/**
 * Run the plugin's `register(api)` against a minimal fake API and return every tool,
 * hook, and CLI registrar it registered, in registration order.
 */
export function registerPlugin(
  config: Record<string, unknown> = TEST_CONFIG,
  logger = recordingLogger(),
): { tools: RegisteredTool[]; hooks: RegisteredHook[]; clis: RegisteredCli[] } {
  const tools: RegisteredTool[] = [];
  const hooks: RegisteredHook[] = [];
  const clis: RegisteredCli[] = [];
  const api = {
    pluginConfig: config,
    logger,
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: (hookName: string, handler: RegisteredHook["handler"], opts?: RegisteredHook["opts"]) =>
      hooks.push({ hookName, handler, opts }),
    registerCli: (registrar: RegisteredCli["registrar"], opts?: RegisteredCli["opts"]) =>
      clis.push({ registrar, opts }),
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  return { tools, hooks, clis };
}

/**
 * Register the plugin against a minimal fake API and invoke one tool the way the
 * host does, returning the JSON `details` payload. Parameters are passed through
 * unvalidated so tests can reach execute()-body checks the schema would not catch.
 */
export async function runTool(
  name: string,
  params: Record<string, unknown>,
  config: Record<string, unknown> = TEST_CONFIG,
  logger = recordingLogger(),
): Promise<unknown> {
  const { tools } = registerPlugin(config, logger);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No registered tool named ${name}.`);
  return (await tool.execute("test-call", params)).details;
}
