import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveToken } from "./client.js";

describe("resolveToken prefix check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns, naming the config path, when a user token is configured as botToken", () => {
    const warn = vi.fn();
    expect(resolveToken({ botToken: "xoxp-mismatch-bot" }, "bot", warn)).toBe("xoxp-mismatch-bot");
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("plugins.entries.slack-workspace.config.botToken");
    expect(message).toContain("xoxb-");
    expect(message).not.toContain("mismatch-bot");
  });

  it("warns when a bot token is configured as userToken", () => {
    const warn = vi.fn();
    resolveToken({ userToken: "xoxb-mismatch-user" }, "user", warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("plugins.entries.slack-workspace.config.userToken");
    expect(warn.mock.calls[0][0]).toContain("xoxp-");
  });

  it("names the environment variable when the token came from there", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxp-mismatch-env");
    const warn = vi.fn();
    resolveToken({}, "bot", warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("SLACK_BOT_TOKEN");
  });

  it("does not warn when the prefix matches the kind", () => {
    const warn = vi.fn();
    resolveToken({ botToken: "xoxb-match" }, "bot", warn);
    resolveToken({ userToken: "xoxp-match" }, "user", warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not echo an unrecognized prefix, which could be part of the secret", () => {
    const warn = vi.fn();
    resolveToken({ botToken: "secretvalue-unknown" }, "bot", warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain("secretvalue");
  });

  it("warns once per token rather than on every call", () => {
    const warn = vi.fn();
    resolveToken({ botToken: "xoxp-repeat" }, "bot", warn);
    resolveToken({ botToken: "xoxp-repeat" }, "bot", warn);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still returns the token rather than failing on a mismatch", () => {
    expect(resolveToken({ userToken: "xoxb-still-works" }, "user", () => {})).toBe(
      "xoxb-still-works",
    );
  });
});
