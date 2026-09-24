import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

// `openclaw plugins build` only preserves configContracts/skills if they are already
// in the manifest; it never generates them. Rebuild from a manifest stripped of every
// field scripts/patch-manifest.mjs owns, in a scratch copy of the package, and check
// the full `plugin:build` pipeline puts them back.
describe("plugin:build", () => {
  let scratch: string;
  let committed: Record<string, any>;
  let built: Record<string, any>;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "slack-workspace-manifest-"));
    for (const entry of ["package.json", "skills", "scripts"]) {
      await cp(join(ROOT, entry), join(scratch, entry), { recursive: true });
    }
    await symlink(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");

    committed = await readJson(join(ROOT, "openclaw.plugin.json"));
    const { configContracts, skills, toolMetadata, ...generated } = committed;
    await writeFile(join(scratch, "openclaw.plugin.json"), JSON.stringify(generated, null, 2));

    await run(bin("tsc"), ["-p", join(ROOT, "tsconfig.build.json"), "--outDir", join(scratch, "dist")]);
    await run(bin("openclaw"), ["plugins", "build", "--root", scratch, "--entry", "./dist/index.js"]);
    await run(process.execPath, [join(scratch, "scripts", "patch-manifest.mjs")]);
    built = await readJson(join(scratch, "openclaw.plugin.json"));
  }, 120_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("restores configContracts.secretInputs for botToken and userToken", () => {
    const paths = built.configContracts?.secretInputs?.paths ?? [];
    expect(paths.map((entry: { path: string }) => entry.path)).toEqual(["botToken", "userToken"]);
  });

  it("restores the bundled skills directory", () => {
    expect(built.skills).toEqual(["./skills"]);
  });

  it("reproduces the committed manifest exactly", () => {
    expect(built).toEqual(committed);
  });
});
