import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";

// The probes of the Workflow engine (packages/workflows/scripts/probes.mjs): a loop over 10,000
// items, and the test of a killed worker process, which the script lets wait in real time.
// They start processes of their own and take minutes, so they run beside the suite.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    exclude: configDefaults.exclude,
    globalSetup: ["tests/support/postgres-global-setup.ts"],
    include: ["tests/probes/**/*.probe.ts", "tests/workflow-worker-kill.test.ts"],
    // One at a time: each starts server processes and measures them.
    fileParallelism: false
  }
});
