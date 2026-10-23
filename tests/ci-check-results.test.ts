import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { required } from "./support/assertions";

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string().optional(),
      needs: z.union([z.string().transform((name) => [name]), z.array(z.string())]).optional(),
      "runs-on": z.unknown().optional(),
      steps: z
        .array(z.object({ name: z.string().optional(), run: z.string().optional() }))
        .optional()
    })
  )
});
type Result = { result: string };
const workflow = (name: string) =>
  workflowSchema.parse(parse(readFileSync(`.github/workflows/${name}`, "utf8")));

// Execute both gates as written: success requires every dependency to have succeeded.
for (const name of ["check.yml", "pr.yml"]) {
  const jobs = workflow(name).jobs;
  const gate = required(jobs.check);
  const needs = required(gate.needs);
  const script = required(gate.steps?.find((step) => step.name === "Every check passed")?.run);
  const full = (): Record<string, Result> =>
    Object.fromEntries(needs.map((job) => [job, { result: "success" }]));
  const run = (results: Record<string, Result>) =>
    execFileSync("bash", ["-e", "-c", script], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
      stdio: "pipe"
    });

  it(`${name} passes when every required job succeeded`, () => {
    expect(needs).toContain("tests");
    if (name === "check.yml") expect(needs).toContain("browser-shard");
    else {
      expect(needs).toEqual(["static", "tests"]);
      expect(Object.keys(jobs).sort()).toEqual(["check", "static", "tests"]);
      expect(gate.if).toBe("always()");
    }
    expect(() => run(full())).not.toThrow();
  });

  it(`${name} fails on any failed, cancelled or skipped job`, () => {
    for (const job of needs) {
      for (const status of ["failure", "cancelled", "skipped"]) {
        const results = full();
        required(results[job]).result = status;
        expect(() => run(results), `${job}: ${status}`).toThrow();
      }
    }
  });
}

it("every workflow uses hosted runners and never names the private runner labels", () => {
  const files = readdirSync(".github/workflows").filter((file) => /\.ya?ml$/u.test(file));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(`.github/workflows/${file}`, "utf8");
    expect(text, file).not.toMatch(/self-hosted|catalyst-mini|catalyst-check/iu);
    for (const [name, job] of Object.entries(workflow(file).jobs)) {
      // Reusable workflow calls have no runner. Require literal hosted labels for other jobs,
      // so a group or expression cannot hide a private runner selection.
      if (job["runs-on"] === undefined) continue;
      expect(job["runs-on"], `${file}: ${name}`).toBeTypeOf("string");
      expect(job["runs-on"], `${file}: ${name}`).toMatch(/^(ubuntu|windows|macos|blacksmith)-/u);
    }
  }
});
