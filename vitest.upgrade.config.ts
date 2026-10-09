import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// pnpm test:upgrade: a database of the oldest supported release, migrated to this commit. It reads
// that release's migrations from its tag, so it runs beside the suite instead of inside it.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["tests/upgrade/**/*.upgrade.ts"] }
});
