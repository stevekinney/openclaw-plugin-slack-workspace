#!/usr/bin/env node
// `openclaw plugins build` regenerates openclaw.plugin.json from the entry file and
// drops configContracts, which is what tells the host to resolve SecretRefs before
// handing config to the plugin. Without it, a SecretRef config value fails schema
// validation with "must be string". Re-apply it after every build.
import { readFile, writeFile } from "node:fs/promises";

const MANIFEST = new URL("../openclaw.plugin.json", import.meta.url);
const SECRET_PATHS = ["botToken", "userToken"];

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
manifest.configContracts = {
  ...manifest.configContracts,
  secretInputs: {
    paths: SECRET_PATHS.map((path) => ({ path, expected: "string", ownerKind: "capability" })),
  },
};
// Bundled skills are also dropped by the generator. The value is a directory whose
// immediate children each hold a SKILL.md.
manifest.skills = ["./skills"];
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`patched configContracts.secretInputs: ${SECRET_PATHS.join(", ")}; skills: ./skills`);
