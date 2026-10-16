import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

type ReportedTest = Pick<TestCase, "tags" | "expectedStatus" | "titlePath" | "outcome">;
type ReportedResult = Pick<TestResult, "status" | "duration" | "retry" | "errors">;

/** Keep known expected failures visible without making them look like new failures in triage. */
export default class CiReporter implements Reporter {
  private tests = new Set<ReportedTest>();

  onTestEnd(test: ReportedTest, result: ReportedResult) {
    this.tests.add(test);
    const title = test.titlePath().filter(Boolean).join(" › ");
    const elapsed = `(${(result.duration / 1000).toFixed(1)}s)`;
    if (
      test.tags.includes("@known-open") &&
      test.expectedStatus === "failed" &&
      result.status === "failed"
    ) {
      console.log(`KNOWN OPEN ${title} ${elapsed} (expected failure)`);
      return;
    }
    const expected = result.status === test.expectedStatus;
    const marker = result.status === "skipped" ? "-" : expected ? "✓" : "✘";
    console.log(
      `  ${marker} ${title} ${elapsed}${result.retry ? ` (retry #${result.retry})` : ""}`
    );
    if (!expected) {
      for (const error of result.errors)
        console.error(error.stack ?? error.message ?? String(error));
      if (result.status === "passed")
        console.error("Unexpected pass: remove the expected-failure annotation.");
    }
  }

  onError(error: { message?: string; stack?: string }) {
    console.error(error.stack ?? error.message);
  }

  onEnd(result: FullResult) {
    const tests = [...this.tests];
    const unexpected = tests.filter((test) => test.outcome() === "unexpected");
    const flaky = tests.filter((test) => test.outcome() === "flaky");
    console.log(
      `${tests.length} tests: ${result.status}; ${unexpected.length} failed; ${flaky.length} flaky`
    );
    for (const test of [...unexpected, ...flaky])
      console.log(`${test.outcome()}: ${test.titlePath().filter(Boolean).join(" › ")}`);
  }
}
