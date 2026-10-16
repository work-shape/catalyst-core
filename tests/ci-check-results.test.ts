import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { required } from "./support/assertions";

// Exercise the actual hosted shell guard, including its selected/skipped distinction.
const workflow = readFileSync(".github/workflows/check.yml", "utf8");
const checkStep = required(workflow.split("      - name: Every selected check passed\n")[1]);
const body = required(checkStep.match(/        run: \|\n((?: {10}.*\n?)+)/u)?.[1]);
const script = body
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(10))
  .join("\n");

type Result = { result: string; outputs?: { browser: string } };
const full = (): Record<string, Result> =>
  Object.fromEntries(
    [
      "paths",
      "changes",
      "build",
      "static",
      "docs",
      "tests",
      "upgrade",
      "release",
      "images",
      "browser-shard"
    ].map((name) => [
      name,
      name === "paths" ? { result: "success", outputs: { browser: "true" } } : { result: "success" }
    ])
  );
const run = (results: Record<string, Result>) =>
  execFileSync("bash", ["-e", "-c", script], {
    env: { ...process.env, RESULTS: JSON.stringify(results) },
    stdio: "pipe"
  });

it("accepts the full run and the intentional skips of a docs-only run", () => {
  expect(() => run(full())).not.toThrow();
  const docs = full();
  for (const name of ["build", "static", "tests", "upgrade", "release", "images", "browser-shard"])
    docs[name] = { result: "skipped" };
  docs.paths = { result: "success", outputs: { browser: "false" } };
  expect(() => run(docs)).not.toThrow();
});

it("rejects every failed or cancelled check and every skipped required job", () => {
  for (const name of Object.keys(full())) {
    for (const status of ["failure", "cancelled"]) {
      const results = full();
      required(results[name]).result = status;
      expect(() => run(results), `${name}: ${status}`).toThrow();
    }
  }
  for (const name of ["paths", "changes", "docs"]) {
    const results = full();
    required(results[name]).result = "skipped";
    expect(() => run(results), name).toThrow();
  }
});

it("requires selected browser shards to pass and unselected shards to be skipped", () => {
  const missing = full();
  delete missing["browser-shard"];
  expect(() => run(missing)).toThrow();
  const skipped = full();
  skipped["browser-shard"] = { result: "skipped" };
  expect(() => run(skipped)).toThrow();
  const unselected = full();
  unselected.paths = { result: "success", outputs: { browser: "false" } };
  expect(() => run(unselected)).toThrow();
});
