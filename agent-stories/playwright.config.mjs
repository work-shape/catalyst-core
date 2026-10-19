import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.story.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 12 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["line"]],
  // Playwright clears only its artifacts; stack auth, ownership and reports are siblings.
  outputDir: resolve(
    process.env.AGENT_STORIES_OUTPUT ?? "../tmp/agent-stories/discovery",
    "playwright"
  ),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.AGENT_STORIES_UI,
    trace: "off",
    video: "off",
    screenshot: "off"
  }
});
