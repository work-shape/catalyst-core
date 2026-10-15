import assert from "node:assert/strict";
import { test } from "node:test";
import { selectChecks } from "./check-paths.mjs";

test("PRs select checks from the union of their changed paths", () => {
  assert.deepEqual(selectChecks(["packages/chat-ui/src/chat.css"]), {
    code: true,
    browser: true,
    images: false
  });
  assert.deepEqual(selectChecks(["packages/chat-server/src/index.ts"]), {
    code: true,
    browser: true,
    images: false
  });
  assert.deepEqual(selectChecks(["packages/core/src/index.ts"]), {
    code: true,
    browser: false,
    images: false
  });
  assert.deepEqual(
    selectChecks([
      "README.md",
      "packages/docs/src/content/docs/start.md",
      "changes/unreleased/fix.md"
    ]),
    {
      code: false,
      browser: false,
      images: false
    }
  );
  assert.equal(selectChecks(["packages/core/src/prompt.md"]).code, true);
  assert.equal(selectChecks(["docker/runner.Dockerfile"]).images, true);
  assert.equal(selectChecks(["packages/core/package.json"]).images, true);
  assert.equal(selectChecks(["packages/docs/package.json"]).code, true);
  assert.equal(selectChecks(["tests/fixtures/e2e-app.yaml"]).browser, true);
  assert.equal(selectChecks(["e2e/chat.spec.ts"]).browser, true);
  assert.equal(selectChecks(["packages/ui/src/old.ts", "README.md"]).browser, true);
});

test("shared configuration, unknown paths and non-PR events always run everything", () => {
  const full = { code: true, browser: true, images: true };
  for (const file of [
    ".github/workflows/check.yml",
    ".github/actions/setup-check/action.yml",
    "packages/quality-config/check.mjs",
    "quality-baseline.json",
    "pnpm-lock.yaml",
    "packages/docs/package-lock.json",
    "pnpm-workspace.yaml",
    "package.json",
    "vitest.config.ts",
    "packages/docs/astro.config.mjs",
    "packages/chat-ui/tsconfig.json",
    "scripts/run-chat-e2e.mjs",
    "new-area/input.txt"
  ]) {
    assert.deepEqual(selectChecks(["README.md", file]), full, file);
  }
  assert.deepEqual(selectChecks(["README.md"], "push"), full);
  assert.deepEqual(selectChecks(["README.md"], "workflow_dispatch"), full);
  assert.deepEqual(selectChecks([]), full);
});
