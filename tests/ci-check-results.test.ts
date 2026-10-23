import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { required } from "./support/assertions";

// Exercise the release Check's final gate as written in the workflow: every job it needs passed.
const workflow = readFileSync(".github/workflows/check.yml", "utf8");
const gate = required(workflow.split("      - name: Every check passed\n")[1]);
const script = required(gate.match(/        run: (.+)\n/u)?.[1]);
const needs = required(workflow.match(/\n  check:\n    needs: \[([^\]]+)\]/u)?.[1])
  .split(",")
  .map((name) => name.trim());

type Result = { result: string };
const full = (): Record<string, Result> =>
  Object.fromEntries(needs.map((name) => [name, { result: "success" }]));
const run = (results: Record<string, Result>) =>
  execFileSync("bash", ["-e", "-c", script], {
    env: { ...process.env, RESULTS: JSON.stringify(results) },
    stdio: "pipe"
  });

it("passes when every job of the release Check succeeded", () => {
  expect(needs).toContain("tests");
  expect(needs).toContain("browser-shard");
  expect(() => run(full())).not.toThrow();
});

it("fails on any failed, cancelled or skipped job", () => {
  for (const name of needs) {
    for (const status of ["failure", "cancelled", "skipped"]) {
      const results = full();
      required(results[name]).result = status;
      expect(() => run(results), `${name}: ${status}`).toThrow();
    }
  }
});
