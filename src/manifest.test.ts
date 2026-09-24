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

  it("is unchanged by a bare openclaw plugins build", () => {
    expect(rebuilt).toEqual(committed);
  });
});
