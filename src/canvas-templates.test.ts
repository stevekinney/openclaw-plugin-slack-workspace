import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./index.js";
import { CANVAS_TEMPLATES, canvasTemplatePlaceholders, renderCanvasTemplate } from "./tools/canvases.js";
import { runTool, withMockFetch, type RecordedCall } from "./test-utils.js";

const slack = (call: RecordedCall) => {
  if (call.method === "auth.test") {
    return { ok: true, url: "https://example-workspace.slack.com/", team_id: "T0TEST", user_id: "U0BOT" };
  }
  if (call.method === "canvases.create") return { ok: true, canvas_id: "F0CANVAS" };
  return { ok: true };
};

/** A value per placeholder, each unique so we can find it in the output. */
const fillAll = async (template: (typeof CANVAS_TEMPLATES)[number]) =>
  Object.fromEntries(
    (await canvasTemplatePlaceholders(template)).map((name) => [name, `- value for ${name}`]),
  );

const createParameters = () => {
  const tool = getToolPluginMetadata(entry)?.tools.find(({ name }) => name === "slack_canvas_create");
  if (!tool) throw new Error("slack_canvas_create is not registered.");
  return tool.parameters;
};

describe("canvas templates", () => {
  it("ships at least three templates", () => {
    expect(CANVAS_TEMPLATES).toEqual(
      expect.arrayContaining(["status-board", "meeting-notes", "project-brief"]),
    );
  });

  it.each(CANVAS_TEMPLATES)("%s declares placeholders", async (template) => {
    expect((await canvasTemplatePlaceholders(template)).length).toBeGreaterThan(0);
  });

  it.each(CANVAS_TEMPLATES)("%s fills every placeholder into valid canvas markdown", async (template) => {
    const values = await fillAll(template);
    const markdown = await renderCanvasTemplate(template, values);

    expect(markdown).not.toMatch(/\{\{|\}\}/);
    for (const [name, value] of Object.entries(values)) expect(markdown, name).toContain(value);

    const lines = markdown.split("\n");
    const headings = lines.filter((line) => /^#{1,6} /.test(line));
    expect(headings.length).toBeGreaterThan(0);
    // Every heading has a body before the next heading, so no section renders empty.
    const sections = markdown.split(/^#{1,6} .*$/m).slice(1);
    for (const body of sections) expect(body.trim()).not.toBe("");
    // Canvas markdown has no HTML and no Block Kit; neither should leak in.
    expect(markdown).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(markdown).not.toContain('"type":');
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("substitutes values once, leaving placeholder-like text in a value alone", async () => {
    const values = { ...(await fillAll("status-board")), summary: "literal {{owner}}" };
    const markdown = await renderCanvasTemplate("status-board", values);
    expect(markdown).toContain("literal {{owner}}");
  });

  it("names every missing placeholder", async () => {
    const { summary: _summary, owner: _owner, ...values } = await fillAll("status-board");
    await expect(renderCanvasTemplate("status-board", values)).rejects.toThrow(
      "Template status-board is missing values for: owner, summary.",
    );
  });

  it("rejects values the template doesn't use, so a typo isn't silently dropped", async () => {
    const values = { ...(await fillAll("meeting-notes")), atendees: "Ada" };
    await expect(renderCanvasTemplate("meeting-notes", values)).rejects.toThrow(
      "Template meeting-notes has no placeholder for: atendees.",
    );
  });
});

describe("slack_canvas_create with a template", () => {
  it.each(CANVAS_TEMPLATES)("sends the filled %s template to canvases.create", async (template) => {
    const values = await fillAll(template);
    const expected = await renderCanvasTemplate(template, values);
    await withMockFetch(slack, async (calls) => {
      const result = await runTool("slack_canvas_create", { title: "Weekly", template, values });
      const create = calls.find((call) => call.method === "canvases.create");
      expect(create?.body).toEqual({
        title: "Weekly",
        document_content: { type: "markdown", markdown: expected },
      });
      expect(result).toMatchObject({ canvasId: "F0CANVAS" });
    });
  });

  it("fails before calling Slack when a placeholder is missing", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_canvas_create", { title: "Weekly", template: "project-brief", values: {} }),
      ).rejects.toThrow("Template project-brief is missing values for:");
      expect(calls).toHaveLength(0);
    });
  });

  it("requires exactly one of markdown or template", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(runTool("slack_canvas_create", { title: "Weekly" })).rejects.toThrow(
        "Pass markdown or template, not neither.",
      );
      await expect(
        runTool("slack_canvas_create", {
          title: "Weekly",
          markdown: "# Hi",
          template: "status-board",
          values: await fillAll("status-board"),
        }),
      ).rejects.toThrow("Pass markdown or template, not both.");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects values without a template", async () => {
    await withMockFetch(slack, async (calls) => {
      await expect(
        runTool("slack_canvas_create", { title: "Weekly", markdown: "# Hi", values: { a: "b" } }),
      ).rejects.toThrow("values only apply with template.");
      expect(calls).toHaveLength(0);
    });
  });

  it.each(CANVAS_TEMPLATES)("documents every %s placeholder in the template parameter", async (template) => {
    const { properties } = createParameters() as { properties: Record<string, { description?: string }> };
    const description = String(properties.template?.description);
    const listed = description.match(new RegExp(`${template}: ([^.]+)\\.`))?.[1]?.split(", ").sort();
    expect(listed).toEqual(await canvasTemplatePlaceholders(template));
  });

  it("only accepts shipped template names", () => {
    const parameters = createParameters();
    expect(Value.Check(parameters, { title: "t", template: "status-board", values: {} })).toBe(true);
    expect(Value.Check(parameters, { title: "t", template: "retro", values: {} })).toBe(false);
    expect(Value.Check(parameters, { title: "t", template: "status-board", values: { a: 1 } })).toBe(
      false,
    );
  });
});
