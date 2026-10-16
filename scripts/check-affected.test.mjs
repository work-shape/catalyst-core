import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  affectedPackages,
  affectedTests,
  isGlobalChange,
  qualityScopes
} from "./affected-selection.mjs";

const packages = [
  { name: "a", dir: "packages/a" },
  { name: "b", dir: "packages/b" },
  { name: "c", dir: "clients/c" },
  { name: "unrelated", dir: "packages/unrelated" }
];
const graph = { a: [], b: ["a"], c: ["b"], unrelated: [] };
test("changed packages include transitive dependents, not dependencies or unrelated packages", () => {
  assert.deepEqual(affectedPackages(graph, packages, ["packages/b/src/deleted.ts"]), ["b", "c"]);
  assert.deepEqual(qualityScopes(packages, ["b", "c"]), ["packages/b", "clients/c"]);
});
test("shared config changes select everything; docs alone select nothing", () => {
  assert.deepEqual(affectedPackages(graph, packages, ["pnpm-lock.yaml"]), [
    "a",
    "b",
    "c",
    "unrelated"
  ]);
  assert.deepEqual(affectedPackages(graph, packages, ["README.md", "changes/unreleased/x.md"]), []);
});
test("test selection follows support/re-exports and terminates on cycles", () => {
  const deps = new Map([
    ["tests/a.test.ts", ["tests/support.ts"]],
    ["tests/support.ts", ["packages/b/src/index.ts"]],
    ["tests/b.test.ts", ["tests/cycle.ts"]],
    ["tests/cycle.ts", ["tests/b.test.ts"]]
  ]);
  assert.deepEqual(
    affectedTests(["tests/a.test.ts", "tests/b.test.ts"], deps, ["packages/b"], []),
    ["tests/a.test.ts"]
  );
  assert.deepEqual(
    affectedTests(["tests/a.test.ts", "tests/b.test.ts"], deps, [], ["tests/cycle.ts"]),
    ["tests/b.test.ts"]
  );
});

test("shared lint inputs select all packages, including unrelated ones", () => {
  const workspace = [...packages, { name: "quality", dir: "packages/quality-config" }];
  for (const file of [
    "packages/quality-config/eslint.config.mjs",
    "packages/quality-config/baseline.mjs",
    "packages/quality-config/new-rule.mjs",
    "packages/model-provider/src/adapters/new-provider.ts",
    "tsconfig.lint.json",
    "quality-baseline.json",
    "packages/deleted/src/index.ts"
  ]) {
    assert.equal(isGlobalChange(file, workspace), true, file);
    assert.deepEqual(
      affectedPackages(graph, workspace, [file]),
      ["a", "b", "c", "quality", "unrelated"],
      file
    );
  }
});
test("root tests select no packages and only tests reaching the edited file", () => {
  const tests = ["tests/a.test.ts", "tests/b.test.ts"];
  for (const file of [...tests, "tests/support.ts", "e2e/chat.spec.ts"]) {
    assert.equal(isGlobalChange(file, packages), false);
    assert.deepEqual(affectedPackages(graph, packages, [file]), []);
  }
  assert.deepEqual(affectedTests(tests, new Map(), [], [tests[0]]), [tests[0]]);
});

test("runner keeps root-test checks narrow, typechecks package consumers and exposes Git errors", (t) => {
  const root = mkdtempSync(join(tmpdir(), "catalyst-affected-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  for (const pkg of ["a", "unrelated", "quality-config"])
    write(`packages/${pkg}/package.json`, JSON.stringify({ name: pkg }));
  write("packages/a/index.ts", "export const value = 1;\n");
  write("tests/a.test.ts", 'import { value } from "../packages/a/index";\nvoid value;\n');
  write("tests/b.test.ts", "export {};\n");
  write("tsconfig.tests.json", JSON.stringify({ include: ["tests/**/*.ts"] }));
  // The tooling self-check is separate from the package/test commands under observation.
  write("scripts/check-affected.test.mjs", "");
  const callsFile = join(root, "calls.log");
  write(
    "bin/pnpm",
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
`
  );
  // Use an ESM package scope for the pnpm command stand-in.
  write("bin/package.json", '{"type":"module"}');
  chmodSync(join(root, "bin/pnpm"), 0o755);
  write(".gitignore", "calls.log\n");
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Tooling Test",
    "-c",
    "user.email=tooling@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  );
  const runner = fileURLToPath(new URL("./check-affected.mjs", import.meta.url));
  const run = (base = "HEAD") =>
    spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AFFECTED_BASE: base,
        CALLS_FILE: callsFile,
        PATH: `${join(root, "bin")}:${process.env.PATH}`
      }
    });
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  write("tests/a.test.ts", 'import { value } from "../packages/a/index";\nvoid value; // edit\n');
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 packages, 1 test files/);
  assert.deepEqual(calls(), [["typecheck:tests"], ["exec", "vitest", "run", "tests/a.test.ts"]]);
  git("restore", "tests/a.test.ts");
  write("packages/a/index.ts", "export const value = 2;\n");
  writeFileSync(callsFile, "");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 packages, 1 test files/);
  assert.ok(calls().some((args) => args[0] === "typecheck:tests"));
  assert.ok(calls().some((args) => args[2] === "lint" && args[3]?.startsWith("--scope-file=")));
  git("restore", "packages/a/index.ts");
  // Untracked logs must not enter the changed-file selection.
  rmSync(callsFile);
  write("packages/quality-config/new-rule.mjs", "export {};\n");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 packages, 2 test files/);
  assert.ok(
    calls().some(
      (args) => JSON.stringify(args) === JSON.stringify(["exec", "catalyst-quality", "lint"])
    )
  );
  result = run("missing-affected-base");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fatal:.*missing-affected-base/);
});
