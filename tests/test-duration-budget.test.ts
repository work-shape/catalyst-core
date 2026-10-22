import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  durationViolations,
  readBudgetAllowlist,
  type BudgetAllowlist
} from "../scripts/test-duration-budget";
import VitestBudgetReporter from "../scripts/vitest-budget-reporter";
import PlaywrightBudgetReporter from "../scripts/playwright-budget-reporter";

const empty: BudgetAllowlist = {
  measuredAt: "2026-10-22",
  source: "fixture",
  notes: "fixture",
  vitestFiles: {},
  vitestTests: {},
  browserFiles: {}
};
afterEach(() => vi.restoreAllMocks());

it("accepts the boundaries and refuses each over-budget file or test", () => {
  expect(
    durationViolations(
      "vitest",
      [
        { file: "tests/fast.test.ts", durationMs: 20_000 },
        { file: "tests/fast.test.ts", test: "nested > fast", durationMs: 5_000 }
      ],
      empty
    )
  ).toEqual([]);
  expect(
    durationViolations("browser", [{ file: "e2e/fast.spec.ts", durationMs: 60_000 }], empty)
  ).toEqual([]);
  expect(
    durationViolations(
      "vitest",
      [
        { file: "tests/slow.test.ts", durationMs: 20_001 },
        { file: "tests/slow.test.ts", test: "nested > slow", durationMs: 5_001 }
      ],
      empty
    )
  ).toEqual([
    "tests/slow.test.ts: 20.001 s exceeds 20 s",
    "tests/slow.test.ts > nested > slow: 5.001 s exceeds 5 s"
  ]);
  expect(
    durationViolations("browser", [{ file: "e2e/slow.spec.ts", durationMs: 60_001 }], empty)
  ).toHaveLength(1);
});

it("requires exact independent exceptions and exempts scale files and their tests", () => {
  const exception = { measuredMs: 25_000, reason: "real process restart" };
  const allowed = {
    ...empty,
    vitestFiles: { "tests/slow.test.ts": exception },
    vitestTests: { "tests/slow.test.ts > nested > allowed": exception },
    browserFiles: { "e2e/slow.spec.ts": exception }
  };
  expect(
    durationViolations(
      "vitest",
      [
        { file: "tests/slow.test.ts", durationMs: 25_000 },
        { file: "tests/slow.test.ts", test: "nested > allowed", durationMs: 6_000 },
        { file: "tests/volume.scale.test.ts", durationMs: 900_000 },
        { file: "tests/volume.scale.test.ts", test: "large", durationMs: 900_000 }
      ],
      allowed
    )
  ).toEqual([]);
  expect(
    durationViolations(
      "vitest",
      [{ file: "tests/slow.test.ts", test: "new", durationMs: 6_000 }],
      allowed
    )
  ).toHaveLength(1);
  expect(
    durationViolations("browser", [{ file: "e2e/slow.spec.ts", durationMs: 90_000 }], allowed)
  ).toEqual([]);
  expect(
    durationViolations("browser", [{ file: "e2e/new.spec.ts", durationMs: 90_000 }], allowed)
  ).toHaveLength(1);
  // The checked-in schema refuses missing/blank reasons and unmeasured exceptions at load.
  expect(readBudgetAllowlist().source.trim()).not.toBe("");
});

it("checks nested Vitest tests independently of the file and sets a failing exit code", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const priorExit = process.exitCode;
  try {
    process.exitCode = 0;
    new VitestBudgetReporter().onTestRunEnd([
      {
        relativeModuleId: "tests/new-budget-fixture.test.ts",
        diagnostic: () => ({ duration: 6_000 }),
        children: {
          allTests: () => [{ fullName: "nested > slow", diagnostic: () => ({ duration: 5_001 }) }]
        }
      }
    ]);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("tests/new-budget-fixture.test.ts > nested > slow")
    );
  } finally {
    process.exitCode = priorExit;
  }
});

it("adds browser work across tests and retry attempts without counting gaps between specs", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reporter = new PlaywrightBudgetReporter();
  const test = {
    location: { file: resolve("e2e/new-budget-fixture.spec.ts"), line: 1, column: 1 }
  };
  reporter.onTestEnd(test, { duration: 30_000 });
  reporter.onTestEnd(
    { location: { ...test.location, file: resolve("e2e/other-budget-fixture.spec.ts") } },
    { duration: 30_000 }
  );
  await expect(reporter.onEnd()).resolves.toBeUndefined();
  reporter.onTestEnd(test, { duration: 30_001 });
  await expect(reporter.onEnd()).resolves.toEqual({ status: "failed" });
});

function fixture() {
  mkdirSync(resolve(".tmp"), { recursive: true });
  return mkdtempSync(resolve(".tmp/test-budget-"));
}
function run(tool: "vitest" | "playwright", config: string) {
  return spawnSync(
    process.execPath,
    [
      resolve(
        tool === "vitest"
          ? "node_modules/vitest/vitest.mjs"
          : "node_modules/@playwright/test/cli.js"
      ),
      tool === "vitest" ? "run" : "test",
      "--config",
      config
    ],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }
  );
}

it("fails the real Vitest CLI when all assertions pass but reported work exceeds the budget", () => {
  const dir = fixture();
  try {
    writeFileSync(
      resolve(dir, "slow.test.ts"),
      'import { it } from "vitest"; it("slow", () => {});'
    );
    writeFileSync(
      resolve(dir, "inflate.mjs"),
      `export default class { onTestModuleEnd(module) {
      module.diagnostic = () => ({ duration: 20001 });
    } }`
    );
    const config = resolve(dir, "vitest.config.mjs");
    writeFileSync(
      config,
      `export default { test: { include: [${JSON.stringify(`${dir}/*.test.ts`)}],
      maxWorkers: 1, reporters: [${JSON.stringify(resolve(dir, "inflate.mjs"))},
      ${JSON.stringify(resolve("scripts/vitest-budget-reporter.ts"))}] } };`
    );
    const result = run("vitest", config);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("TEST TIME BUDGET exceeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("fails the real Playwright CLI when two passing tests exceed their spec budget together", () => {
  const dir = fixture();
  try {
    writeFileSync(
      resolve(dir, "slow.spec.ts"),
      'import { test } from "@playwright/test"; test("one", () => {}); test("two", () => {});'
    );
    writeFileSync(
      resolve(dir, "inflate.cjs"),
      "module.exports = class { onTestEnd(test, result) { result.duration = 30001; } };"
    );
    const config = resolve(dir, "playwright.config.cjs");
    writeFileSync(
      config,
      `module.exports = { testDir: ${JSON.stringify(dir)}, workers: 1,
      reporter: [[${JSON.stringify(resolve(dir, "inflate.cjs"))}],
      [${JSON.stringify(resolve("scripts/playwright-budget-reporter.ts"))}]] };`
    );
    const result = run("playwright", config);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("TEST TIME BUDGET exceeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps budget reporters in both default runner configurations", () => {
  expect(readFileSync("vitest.config.ts", "utf8")).toContain(
    'reporters: ["default", "./scripts/vitest-budget-reporter.ts"]'
  );
  expect(readFileSync("playwright.config.ts", "utf8")).toContain(
    '["./scripts/playwright-budget-reporter.ts"]'
  );
});
