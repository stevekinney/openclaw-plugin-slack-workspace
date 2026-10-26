import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const { values } = parseArgs({ options: {
  artifact: { type: "string" }, "host-root": { type: "string" },
  image: { type: "string" }, companion: { type: "boolean", default: false },
} });
const scripts = dirname(fileURLToPath(import.meta.url));
const repository = dirname(scripts);
const directory = mkdtempSync(join(tmpdir(), "slack-artifact-"));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const readJson = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(record(value));
  return value;
};

function command(binary: string, args: string[], env = process.env, allowFailure = false) {
  const result = spawnSync(binary, args, { cwd: repository, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 300_000 });
  assert.ifError(result.error);
  if (!allowFailure && result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    assert.fail(`${basename(binary)} ${args.slice(0, 4).join(" ")} exited ${result.status}`);
  }
  return result;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let artifact = values.artifact && resolve(values.artifact);
if (!artifact) {
  command(npm, ["pack", "--pack-destination", directory]);
  const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one artifact");
  artifact = join(directory, archives[0]);
}
assert(existsSync(artifact));
const artifactDigest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
const files = new Set(command("tar", ["-tzf", artifact]).stdout.trim().split("\n"));
for (const file of ["dist/index.js", "openclaw.plugin.json", "README.md", "CHANGELOG.md", "docs/routing.md", "docs/openclaw-routing.patch", "skills/slack-block-kit/SKILL.md"]) {
  assert(files.has(`package/${file}`), `Missing published file: ${file}`);
}
const packedJson = (name: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(command("tar", ["-xOf", artifact, `package/${name}`]).stdout);
  assert(record(value));
  return value;
};
const manifest = packedJson("package.json");
assert.equal(packedJson("openclaw.plugin.json").version, manifest.version);
const readme = command("tar", ["-xOf", artifact, "package/README.md"]).stdout;
for (const match of readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/g)) {
  assert(files.has(`package/${match[1]}`), `Broken packaged README link: ${match[1]}`);
}

if (values.image) {
  const tag = `slack-artifact-host:${randomUUID()}`;
  const container = `slack-artifact-${randomUUID()}`;
  let built = false;
  try {
    command("docker", ["build", "--progress=plain", "-f", join(scripts, "artifact-host.Dockerfile"),
      "--build-arg", `HOST_IMAGE=${values.image}`, "-t", tag, scripts]);
    built = true;
    const result = command("docker", ["run", "--rm", "--name", container, "--entrypoint", "node",
      "--mount", `type=bind,src=${scripts},dst=/smoke,readonly`,
      "--mount", `type=bind,src=${artifact},dst=/artifact/plugin.tgz,readonly`,
      tag, "/smoke/test-artifact.ts", "--artifact", "/artifact/plugin.tgz", "--host-root", "/app",
      ...(values.companion ? ["--companion"] : [])]);
    process.stdout.write(result.stdout);
  } finally {
    command("docker", ["rm", "--force", container], process.env, true);
    if (built) command("docker", ["image", "rm", tag]);
  }
} else {
  const host = realpathSync(values["host-root"] ?? join(repository, "node_modules/openclaw"));
  const cli = join(host, "openclaw.mjs");
  const state = join(directory, "host-state");
  const configuration = join(state, "configuration.json");
  const probe = join(directory, "probe");
  mkdirSync(state, { recursive: true });
  mkdirSync(probe);
  mkdirSync(join(state, "temporary"));
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: state, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: join(state, "state"),
    OPENCLAW_CONFIG_PATH: configuration, OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_SUPERVISOR_MODE: "external",
    XDG_CACHE_HOME: join(state, "cache"), TMPDIR: join(state, "temporary"),
    NPM_CONFIG_USERCONFIG: join(state, "npmrc"), NPM_CONFIG_CACHE: join(state, "npm-cache"),
  };
  const cliCommand = (args: string[], guarded = true, allowFailure = false) => command(process.execPath, [cli, ...args], {
    ...environment,
    ...(guarded ? { NODE_OPTIONS: `--import=${join(scripts, "artifact-network.ts")}` } : {}),
  }, allowFailure);
  const report = (output: string): Record<string, unknown> => {
    const text = stripVTControlCharacters(output);
    const value: unknown = JSON.parse(text.slice(text.indexOf("{")));
    assert(record(value) && record(value.plugin));
    return value.plugin;
  };
  writeFileSync(configuration, JSON.stringify({ gateway: { mode: "local" }, plugins: { allow: [] } }));
  let verified = false;
  try {
    console.log(`Installing ${manifest.name}@${manifest.version} on OpenClaw ${readJson(join(host, "package.json")).version}`);
    cliCommand(["plugins", "install", `npm-pack:${artifact}`, "--force", "--accept-capabilities"], false);
    const original = report(cliCommand(["plugins", "inspect", "slack-workspace", "--json"]).stdout);
    writeFileSync(join(directory, "installation.json"), JSON.stringify(original, null, 2));
    assert.equal(original.version, manifest.version);
    assert(typeof original.source === "string");
    const installedEntry = realpathSync(original.source);
    assert(installedEntry.startsWith(realpathSync(state) + sep), "Artifact must load from its isolated installation");
    const installedRoot = dirname(dirname(installedEntry));
    assert(record(original.dependencyStatus) && original.dependencyStatus.requiredInstalled === true);
    assert(Array.isArray(original.dependencyStatus.dependencies));
    const dependency: unknown = original.dependencyStatus.dependencies.find((value: unknown) => record(value) && value.name === "typebox");
    assert(record(dependency) && dependency.installed === true && typeof dependency.resolvedPath === "string");
    assert(realpathSync(dependency.resolvedPath).startsWith(realpathSync(state) + sep), "Production dependency must resolve from the isolated npm installation");
    assert(existsSync(join(dependency.resolvedPath, "package.json")));
    command(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import tls from 'node:tls';
      import dns from 'node:dns';
      assert.throws(() => fetch('https://slack.com/api/auth.test'), /Network access/);
      assert.throws(() => net.connect({host:'slack.com',port:443}), /Network access/);
      assert.throws(() => tls.connect({host:'slack.com',port:443}), /Network access/);
      assert.throws(() => dns.lookup('slack.com',()=>{}), /Network access/);
    `], { ...environment, NODE_OPTIONS: `--import=${join(scripts, "artifact-network.ts")}` });
    const pluginManifest = readJson(join(installedRoot, "openclaw.plugin.json"));
    copyFileSync(join(scripts, "artifact-probe.ts"), join(probe, "index.ts"));
    writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "slack-release-probe", type: "module", openclaw: { extensions: ["./index.ts"] } }));
    writeFileSync(join(probe, "openclaw.plugin.json"), JSON.stringify({
      id: "slack-release-probe", configSchema: pluginManifest.configSchema,
      cliCommands: [{ name: "slack-release-probe", description: "Verify the packed Slack artifact", hasSubcommands: false }],
    }));
    environment.SLACK_ARTIFACT_ENTRY = installedEntry;
    environment.SLACK_ARTIFACT_RECEIPT = join(directory, "probe-receipt.json");
    const configure = (enabled: boolean) => {
      const config = { botToken: "xoxb-test", routing: { enabled, semanticReplies: { enabled: false }, directMessages: { defaultTarget: { agentId: "main", sessionKey: "agent:main:release-fallback" } } } };
      const operations = [
        { path: "plugins.allow", value: ["slack-workspace", "slack-release-probe"] },
        { path: "plugins.load.paths", value: [probe] },
        { path: "plugins.entries.slack-workspace.config", value: config },
        { path: "plugins.entries.slack-release-probe", value: { enabled: true, config } },
      ];
      cliCommand(["config", "set", "--batch-json", JSON.stringify(operations)]);
    };
    const verify = (companion: boolean) => {
      environment.SLACK_ARTIFACT_COMPANION = companion ? "1" : "0";
      const loaded = report(cliCommand(["plugins", "inspect", "slack-workspace", "--runtime", "--json"]).stdout);
      assert.equal(loaded.status, "loaded");
      cliCommand(["slack-release-probe"]);
      const receipt = readJson(environment.SLACK_ARTIFACT_RECEIPT!);
      assert.equal(receipt.verified, true);
      assert.equal(receipt.companion, companion);
      assert(record(pluginManifest.contracts) && Array.isArray(pluginManifest.contracts.tools));
      assert.equal(receipt.toolCount, pluginManifest.contracts.tools.length);
      console.log(JSON.stringify({ mode: companion ? "companion-routing" : "stock-tools", ...receipt }));
    };
    configure(false);
    verify(false);
    if (values.companion) {
      configure(true);
      verify(true);
    } else {
      // A separate profile avoids asking config.set to accept a host-incompatible activation.
      const unsupported = join(directory, "unsupported");
      mkdirSync(unsupported);
      const path = join(unsupported, "configuration.json");
      writeFileSync(path, JSON.stringify({ gateway: { mode: "local" }, plugins: {
        allow: ["slack-workspace"], load: { paths: [installedRoot] },
        entries: { "slack-workspace": { enabled: true, config: { botToken: "xoxb-test", routing: { enabled: true } } } },
      } }));
      const rejected = command(process.execPath, [cli, "plugins", "inspect", "slack-workspace", "--runtime", "--json"], {
        ...environment, OPENCLAW_HOME: unsupported, OPENCLAW_STATE_DIR: join(unsupported, "state"), OPENCLAW_CONFIG_PATH: path,
        NODE_OPTIONS: `--import=${join(scripts, "artifact-network.ts")}`,
      }, true);
      const plugin = report(rejected.stdout);
      assert.equal(plugin.status, "error");
      assert.match(JSON.stringify(plugin), /inbound route contract version 1/);
      console.log("Unsupported routing activation rejected with its companion requirement.");
    }
    verified = true;
  } finally {
    if (verified) {
      rmSync(state, { recursive: true, force: true });
      rmSync(probe, { recursive: true, force: true });
    } else {
      console.error(`Artifact failure evidence retained in ${directory}`);
    }
  }
}
const result = { artifact, sha256: artifactDigest, version: manifest.version, companion: values.companion, image: values.image, verified: true };
writeFileSync(join(directory, "verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
