import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Explicit opt-in. Spread replaces include; mergeConfig concatenates the default test list.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/data-store-chat.live.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    maxWorkers: 1
  }
});
