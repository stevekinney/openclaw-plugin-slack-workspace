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

/**
 * Register the plugin against a minimal fake API and invoke one tool the way the
 * host does, returning the JSON `details` payload. Parameters are passed through
 * unvalidated so tests can reach execute()-body checks the schema would not catch.
 */
export async function runTool(
  name: string,
  params: Record<string, unknown>,
  config: Record<string, unknown> = TEST_CONFIG,
): Promise<unknown> {
  const tools: RegisteredTool[] = [];
  const api = {
    pluginConfig: config,
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No registered tool named ${name}.`);
  return (await tool.execute("test-call", params)).details;
}
