import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const bin = (name: string) => join(ROOT, "node_modules", ".bin", name);
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("package.json", () => {
  it("pins the openclaw devDependency to the version the manifest was built with", async () => {
    const pkg = await readJson(join(ROOT, "package.json"));
    expect(pkg.devDependencies.openclaw).toBe(pkg.openclaw.build.openclawVersion);
  });

  it("ships the plugin artwork in the published package", async () => {
    const pkg = await readJson(join(ROOT, "package.json"));
    expect(pkg.files).toContain("assets");
  });

  it("matches the manifest version", async () => {
    const pkg = await readJson(join(ROOT, "package.json"));
    const manifest = await readJson(join(ROOT, "openclaw.plugin.json"));
    expect(manifest.version).toBe(pkg.version);
  });
});

// OpenClaw discovers artwork at fixed paths; no manifest field points at it.
// See node_modules/openclaw/docs/plugins/manifest/surfaces.md.
describe("plugin artwork", () => {
  it("ships a square PNG at assets/icon.png", async () => {
    const png = await readFile(join(ROOT, "assets", "icon.png"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(256);
  });

  it("ships a monochrome activity SVG within the host's geometry limits", async () => {
    const path = join(ROOT, "assets", "activity.svg");
    const svg = await readFile(path, "utf8");
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(32 * 1024);
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    const elements = [...svg.matchAll(/<([a-z]+)[\s/>]/g)].map((match) => match[1]);
    expect(elements.length).toBeLessThanOrEqual(4);
    for (const name of elements.slice(1)) {
      expect(["path", "circle", "ellipse", "line", "polygon", "polyline", "rect", "g"]).toContain(name);
    }
    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b|<style|<script|href=|filter/i);
  });
});

// openclaw.plugin.json is hand-authored. `openclaw plugins build` regenerates only
// the fields it derives from the entry (id, name, description, configSchema,
// contracts.tools) and keeps everything else, so the hand-authored fields must be
// present and a bare rebuild must leave the committed manifest untouched.
describe("openclaw.plugin.json", () => {
  let scratch: string;
  let committed: Record<string, any>;
  let rebuilt: Record<string, any>;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "slack-workspace-manifest-"));
    for (const entry of ["package.json", "skills", "openclaw.plugin.json"]) {
      await cp(join(ROOT, entry), join(scratch, entry), { recursive: true });
    }
    await symlink(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");

    committed = await readJson(join(ROOT, "openclaw.plugin.json"));
    await run(bin("tsc"), ["-p", join(ROOT, "tsconfig.build.json"), "--outDir", join(scratch, "dist")]);
    await run(bin("openclaw"), ["plugins", "build", "--root", scratch, "--entry", "./dist/index.js"]);
    rebuilt = await readJson(join(scratch, "openclaw.plugin.json"));
  }, 120_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("declares configContracts.secretInputs for botToken, userToken, and each workflow trigger", () => {
    const paths = committed.configContracts?.secretInputs?.paths ?? [];
    expect(paths.map((entry: { path: string }) => entry.path)).toEqual([
      "botToken",
      "userToken",
      "workflowTriggers.*",
    ]);
  });

  it("declares the bundled skills directory", () => {
    expect(committed.skills).toEqual(["./skills"]);
  });

  it("declares exactly one ClawHub category", () => {
    expect(committed.categories).toEqual(["inbox-collaboration"]);
  });

  it("marks every credential config field sensitive", () => {
    for (const field of ["botToken", "userToken", "workflowTriggers"]) {
      expect(committed.uiHints?.[field]?.sensitive).toBe(true);
    }
  });

  it("is unchanged by a bare openclaw plugins build", () => {
    expect(rebuilt).toEqual(committed);
  });
});
