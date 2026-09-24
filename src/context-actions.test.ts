import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runTool, withMockFetch } from "./test-utils.js";

// The feedback-button pattern is documented as raw JSON rather than shipped as a
// tool. Parse the snippet straight out of the reference so the docs can't drift
// into invalid JSON or a shape slack_blocks_send would mangle.
const reference = readFileSync(
  new URL("../skills/slack-block-kit/references/block-kit.md", import.meta.url),
  "utf8",
);

const feedbackSnippet = () => {
  const section = reference.split("## Feedback buttons")[1];
  const json = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!json) throw new Error("block-kit.md has no JSON snippet under ## Feedback buttons");
  return JSON.parse(json) as { type: string; elements: Record<string, unknown>[] }[];
};

describe("context_actions feedback pattern", () => {
  it("documents a context_actions block with thumbs-up/down feedback buttons", () => {
    const blocks = feedbackSnippet();
    const actions = blocks.find((block) => block.type === "context_actions");
    expect(actions).toBeDefined();
    expect(actions!.elements.length).toBeLessThanOrEqual(5);
    expect(actions!.elements[0]).toMatchObject({
      type: "feedback_buttons",
      positive_button: { text: { type: "plain_text" }, value: expect.any(String) },
      negative_button: { text: { type: "plain_text" }, value: expect.any(String) },
    });
  });

  it("posts the documented snippet through slack_blocks_send verbatim", async () => {
    const blocks = feedbackSnippet();
    await withMockFetch(
      () => ({ ok: true, ts: "1700000000.000100" }),
      async (calls) => {
        await runTool("slack_blocks_send", { channelId: "C0TEST", text: "Answer", blocks });
        expect(calls[0].method).toBe("chat.postMessage");
        expect(calls[0].body.blocks).toEqual(blocks);
      },
    );
  });
});
