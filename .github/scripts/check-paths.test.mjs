import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserDependencyPaths, selectChecks } from "./check-paths.mjs";

test("PRs select checks from the union of their changed paths", () => {
  assert.deepEqual(selectChecks(["packages/chat-ui/src/chat.css"]), {
    code: true,
    browser: true,
    images: true
  });
  assert.deepEqual(selectChecks(["packages/chat-server/src/index.ts"]), {
    code: true,
    browser: true,
    images: true
  });
  assert.deepEqual(selectChecks(["packages/core/src/index.ts"]), {
    code: true,
    browser: true,
    images: true
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

test("browser and isolated image builds follow the current workspace dependency closure", () => {
  for (const path of browserDependencyPaths()) {
    assert.deepEqual(
      selectChecks([`${path}src/new-import.ts`]),
      {
        code: true,
        browser: true,
        images: true
      },
      path
    );
  }
  for (const name of [
    "auth",
    "api-contract",
    "app-build",
    "model-provider",
    "tool-execution",
    "mail",
    "usage-governance",
    "asset-schemas",
    "client-assembly",
    "api-client",
    "config-schema",
    "tool-sdk"
  ]) {
    assert.equal(selectChecks([`packages/${name}/src/index.ts`]).browser, true, name);
  }
  assert.deepEqual(selectChecks(["packages/registry-canary/src/index.ts"]), {
    code: true,
    browser: false,
    images: false
  });
});

test("new transitive dependencies are discovered from manifests, including cycles and dev/peer/optional edges", (t) => {
  const root = mkdtempSync(join(tmpdir(), "check-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifests = {
    "clients/demo": { name: "@work-shape/catalyst-demo", dependencies: { direct: "workspace:*" } },
    "packages/chat-server": {
      name: "@work-shape/catalyst-server",
      devDependencies: { builder: "workspace:*" }
    },
    "packages/direct": {
      name: "direct",
      optionalDependencies: { transitive: "workspace:*", external: "1.0.0" }
    },
    "packages/transitive": { name: "transitive", peerDependencies: { direct: "workspace:*" } },
    "packages/builder": { name: "builder" },
    "packages/unrelated": { name: "unrelated" }
  };
  for (const [path, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  }
  assert.deepEqual(browserDependencyPaths(root).sort(), [
    "clients/demo/",
    "packages/builder/",
    "packages/chat-server/",
    "packages/direct/",
    "packages/transitive/"
  ]);
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
