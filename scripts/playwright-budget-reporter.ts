import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { durationViolations, reportBudgetViolations } from "./test-duration-budget";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export default class PlaywrightBudgetReporter implements Reporter {
  private durations = new Map<string, number>();

  onTestEnd(test: Pick<TestCase, "location">, result: Pick<TestResult, "duration">) {
    const file = relative(root, test.location.file).replaceAll("\\", "/");
    // Sum reported work, including retries, rather than gaps or time spent in other files.
    this.durations.set(file, (this.durations.get(file) ?? 0) + result.duration);
  }

  async onEnd() {
    const samples = [...this.durations].map(([file, durationMs]) => ({ file, durationMs }));
    // A warning, not a failure: on a shared runner a test's time follows the machine's load.
    reportBudgetViolations(durationViolations("browser", samples));
  }
}
