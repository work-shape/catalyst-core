import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";
import { toolingFiles } from "./vitest.projects.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    pool: "forks",
    isolate: true,
    include: toolingFiles,
    exclude: configDefaults.exclude,
    globalSetup: ["tests/support/postgres-global-setup.ts"]
  }
});
