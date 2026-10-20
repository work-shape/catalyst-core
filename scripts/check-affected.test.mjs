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
import ts from "typescript";
import { BARREL_NODE, testImportGraph } from "./affected-graph.mjs";

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
    affectedTests(
      ["tests/a.test.ts", "tests/b.test.ts"],
      deps,
      ["packages/b"],
      ["packages/b/src/index.ts"]
    ),
    ["tests/a.test.ts"]
  );
  assert.deepEqual(
    affectedTests(["tests/a.test.ts", "tests/b.test.ts"], deps, [], ["tests/cycle.ts"]),
    ["tests/b.test.ts"]
  );
});

test("tests are selected by the file graph, not by widened packages", () => {
  const tests = [
    "tests/a.test.ts",
    "tests/c.test.ts",
    "tests/d.test.ts",
    "tests/e.test.ts",
    "tests/f.test.ts"
  ];
  const deps = new Map([
    ["tests/a.test.ts", ["packages/b/src/x.ts"]],
    ["tests/c.test.ts", ["packages/b/src/y.ts"]],
    // A test that reads package b with fs, and one that runs the dependent client c.
    ["tests/d.test.ts", ["packages/b/"]],
    ["tests/f.test.ts", ["clients/c/"]],
    ["tests/e.test.ts", ["clients/c/src/z.ts"]],
    ["clients/c/src/z.ts", []],
    ["packages/b/src/x.ts", []],
    ["packages/b/src/y.ts", []]
  ]);
  const scopes = qualityScopes(
    packages,
    affectedPackages(graph, packages, ["packages/b/src/x.ts"])
  );
  assert.deepEqual(scopes, ["packages/b", "clients/c"]);
  // Another file of b, or of its dependent c, is no reason to run a test.
  assert.deepEqual(affectedTests(tests, deps, scopes, ["packages/b/src/x.ts"]), [
    "tests/a.test.ts",
    "tests/d.test.ts",
    "tests/f.test.ts"
  ]);
  // A file no test imports stands for its whole package, not for its dependents.
  assert.deepEqual(affectedTests(tests, deps, scopes, ["packages/b/migrations/0001_x.sql"]), [
    "tests/a.test.ts",
    "tests/c.test.ts",
    "tests/d.test.ts",
    "tests/f.test.ts"
  ]);
});

test("the graph follows named imports through barrels to the defining files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "catalyst-affected-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write("packages/b/src/index.ts", 'export * from "./inner";\nexport { y } from "./y";\n');
  write("packages/b/src/inner.ts", 'export * from "./x";\nexport * from "./unused";\n');
  write("packages/b/src/x.ts", 'import { y } from "./y";\nexport const x = y;\n');
  write("packages/b/src/y.ts", "export const y = 1;\nexport type Y = number;\n");
  write("packages/b/src/unused.ts", "export const unused = 1;\n");
  write("packages/b/src/types.ts", "export interface T { a: number }\n");
  write("packages/b/src/lazy.ts", "export const lazy = 1;\n");
  write("packages/b/src/mixed.ts", 'import { y } from "./y";\nexport const m = y;\n');
  write(
    "tests/a.test.ts",
    [
      'import { x } from "../packages/b/src/index";',
      'import type { T } from "../packages/b/src/types";',
      'import { type Y } from "../packages/b/src/y";',
      'import { m } from "../packages/b/src/mixed";',
      'void import("../packages/b/src/lazy");',
      "void x, m;"
    ].join("\n")
  );
  const graph = testImportGraph({
    root,
    tests: ["tests/a.test.ts"],
    // The fixture imports by relative path; no whole-package text edges here.
    packageDirs: [],
    options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  });
  assert.deepEqual(graph.get("tests/a.test.ts")?.toSorted(), [
    `packages/b/src/index.ts${BARREL_NODE}`,
    `packages/b/src/inner.ts${BARREL_NODE}`,
    "packages/b/src/lazy.ts",
    "packages/b/src/mixed.ts",
    "packages/b/src/x.ts"
  ]);
  assert.deepEqual(graph.get("packages/b/src/x.ts"), ["packages/b/src/y.ts"]);
  // Known to the graph, so not taken for files outside it, but no edge reaches them.
  assert.ok(graph.has("packages/b/src/unused.ts") && graph.has("packages/b/src/types.ts"));
  const tests = ["tests/a.test.ts"];
  const scopes = ["packages/b"];
  // The barrel's own text and the defining file's import select the test; an unused sibling does not.
  for (const file of ["packages/b/src/index.ts", "packages/b/src/inner.ts", "packages/b/src/y.ts"])
    assert.deepEqual(affectedTests(tests, graph, scopes, [file]), tests, file);
  for (const file of ["packages/b/src/unused.ts", "packages/b/src/types.ts"])
    assert.deepEqual(affectedTests(tests, graph, scopes, [file]), [], file);
});

test("shared lint inputs select all packages, including unrelated ones", () => {
  const workspace = [...packages, { name: "quality", dir: "packages/quality-config" }];
  for (const file of [
    "packages/quality-config/eslint.config.mjs",
    "packages/quality-config/baseline.mjs",
    "packages/quality-config/new-rule.mjs",
    "packages/model-provider/src/adapters/new-provider.ts",
    "tsconfig.lint.json",
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
test("baseline counts select only their readers, without widening package checks", () => {
  const changed = ["quality-baseline.json"];
  assert.equal(isGlobalChange(changed[0], packages), false);
  assert.deepEqual(affectedPackages(graph, packages, changed), []);
  assert.deepEqual(
    affectedTests(
      ["tests/a.test.ts", "tests/b.test.ts"],
      new Map([["tests/a.test.ts", ["quality-baseline.json"]]]),
      [],
      changed
    ),
    ["tests/a.test.ts"]
  );
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
  for (const pkg of ["a", "dependent", "quality-config"])
    write(`packages/${pkg}/package.json`, JSON.stringify({ name: pkg }));
  write(
    "packages/dependent/package.json",
    JSON.stringify({
      name: "dependent",
      dependencies: { a: "workspace:*" }
    })
  );
  write("packages/a/index.ts", "export const value = 1; // docs mention packages/dependent\n");
  write("packages/dependent/index.ts", "export const other = 1;\n");
  write("tests/a.test.ts", 'import { value } from "../packages/a/index";\nvoid value;\n');
  write(
    "tests/b.test.ts",
    'import { readFileSync } from "node:fs";\nreadFileSync("packages/dependent/index.ts");\n'
  );
  write(
    "tests/baseline.test.ts",
    'import { readFileSync } from "node:fs";\nreadFileSync("quality-baseline.json");\n'
  );
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
  assert.match(result.stdout, /2 packages, 2 test files/);
  assert.ok(calls().some((args) => args[0] === "typecheck:tests"));
  assert.ok(calls().some((args) => args.includes("dependent...")));
  assert.ok(calls().some((args) => args[2] === "lint" && args[3]?.startsWith("--scope-file=")));
  git("restore", "packages/a/index.ts");
  // The fs reader keeps its dependency; a package's prose mention adds no edge.
  write("packages/dependent/index.ts", "export const other = 2;\n");
  writeFileSync(callsFile, "");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 packages, 1 test files/);
  assert.deepEqual(calls().at(-1), ["exec", "vitest", "run", "tests/b.test.ts"]);
  git("restore", "packages/dependent/index.ts");
  write("quality-baseline.json", '{"version":1,"entries":[]}\n');
  writeFileSync(callsFile, "");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 packages, 1 test files/);
  assert.deepEqual(calls(), [
    ["typecheck:tests"],
    ["exec", "vitest", "run", "tests/baseline.test.ts"]
  ]);
  rmSync(join(root, "quality-baseline.json"));
  // Untracked logs must not enter the changed-file selection.
  rmSync(callsFile);
  write("packages/quality-config/new-rule.mjs", "export {};\n");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 packages, 3 test files/);
  assert.ok(
    calls().some(
      (args) => JSON.stringify(args) === JSON.stringify(["exec", "catalyst-quality", "lint"])
    )
  );
  result = run("missing-affected-base");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fatal:.*missing-affected-base/);
});

test("runner defaults its base to origin/main, github/main or the catalyst-core remote", (t) => {
  const root = mkdtempSync(join(tmpdir(), "catalyst-affected-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(join(root, "tsconfig.tests.json"), JSON.stringify({ include: ["tests/**/*.ts"] }));
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "fixture");
  const runner = fileURLToPath(new URL("./check-affected.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.AFFECTED_BASE;
  const run = () =>
    spawnSync(process.execPath, [runner, "--list"], { cwd: root, encoding: "utf8", env });

  let result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no base branch found; tried origin\/main, github\/main\./);

  git("remote", "add", "upstream", "git@github.com:work-shape/catalyst-core.git");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check:affected vs upstream\/main:/);

  git("update-ref", "refs/remotes/github/main", "HEAD");
  result = run();
  assert.match(result.stdout, /check:affected vs github\/main:/);

  git("update-ref", "refs/remotes/origin/main", "HEAD");
  result = run();
  assert.match(result.stdout, /check:affected vs origin\/main:/);
});
