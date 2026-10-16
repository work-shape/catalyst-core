import { afterEach, expect, it, vi } from "vitest";
import CiReporter from "../e2e/ci-reporter";

afterEach(() => vi.restoreAllMocks());

function report(expectedStatus: "passed" | "failed", status: "passed" | "failed") {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const reporter = new CiReporter();
  reporter.onTestEnd(
    {
      tags: ["@known-open"],
      expectedStatus,
      titlePath: () => ["chromium", "WebRTC"],
      outcome: () => "expected"
    },
    { status, duration: 1000, retry: 0, errors: [{ message: "the assertion failed" }] }
  );
  return { log, error };
}

it("names a known expected failure without a failure marker or stack", () => {
  const { log, error } = report("failed", "failed");
  expect(log).toHaveBeenCalledWith("KNOWN OPEN chromium › WebRTC (1.0s) (expected failure)");
  expect(error).not.toHaveBeenCalled();
});

it("still reports a failure before test.fail is reached, even on a known-open test", () => {
  const { log, error } = report("passed", "failed");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("✘"));
  expect(error).toHaveBeenCalledWith("the assertion failed");
});

it("reports an unexpected pass so a closed WebRTC hole cannot silently stay marked open", () => {
  const { log, error } = report("failed", "passed");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("✘"));
  expect(error).toHaveBeenCalledWith("Unexpected pass: remove the expected-failure annotation.");
});
