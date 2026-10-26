import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const manifest = readJson("../package.json");
const plugin = readJson("../openclaw.plugin.json");
const lock = readJson("../package-lock.json");

describe("release contract", () => {
  it("keeps the package, lockfile, and plugin release versions consistent", () => {
    expect(plugin.version).toBe(manifest.version);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].version).toBe(manifest.version);
  });

  it("requires a host with the asynchronous session reader imported at startup", () => {
    // 2026.9.5 exposes this SDK subpath, but not getSessionEntryAsync.
    expect(manifest.peerDependencies.openclaw).toBe(">=2026.10.5");
    expect(manifest.openclaw.compat.pluginApi).toBe(manifest.peerDependencies.openclaw);
    expect(manifest.openclaw.compat.minGatewayVersion).toBe("2026.10.5");
  });

  it("ships the routing guide and its referenced companion patch", () => {
    expect(manifest.files).toEqual(expect.arrayContaining([
      "docs/routing.md", "docs/openclaw-routing.patch", "CHANGELOG.md",
    ]));
  });
});
