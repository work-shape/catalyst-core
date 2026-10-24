import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";
import { toolingFiles } from "./vitest.projects.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    pool: "forks",
    // Tooling tests run real tools (tsc, ESLint, pnpm, a nested Vitest with its own Postgres
    // setup) side by side; the product suite's 30 s per test is too tight for one of those
    // under load. The product suite keeps its limit.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    isolate: true,
    include: toolingFiles,
    exclude: configDefaults.exclude,
    globalSetup: ["tests/support/postgres-global-setup.ts"]
  }
});
