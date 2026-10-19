import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Hosted Check runs the runner's deterministic seams; it never imports Playwright stories.
it("agent story selection, ownership, cleanup, budget and state oracles", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ["--test", "scripts/agent-stories/runner.test.mjs"],
    { timeout: 15_000 }
  );
  expect(result.stdout).toContain("# fail 0");
});
