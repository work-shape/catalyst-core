import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";

// The release probes: measurements that take a long time and name a machine, run on demand
// with their own script (`pnpm probe:knowledge-import`) and in no check. They start processes
// of their own and measure them, so they run one at a time.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    exclude: configDefaults.exclude,
    globalSetup: ["tests/support/postgres-global-setup.ts"],
    include: ["tests/release-probes/**/*.probe.ts"],
    fileParallelism: false
  }
});
