import { test } from "node:test";
import assert from "node:assert/strict";
import { affectedPackages, affectedTests, qualityScopes } from "./affected-selection.mjs";

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
