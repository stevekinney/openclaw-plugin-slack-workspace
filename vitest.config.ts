import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Safety net: never let a mocked fetch or a stubbed env var leak between tests.
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
