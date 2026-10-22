import type { Reporter } from "vitest/reporters";
import {
  durationViolations,
  reportBudgetViolations,
  type DurationSample
} from "./test-duration-budget";

type TimedTest = { fullName: string; diagnostic(): { duration: number } | undefined };
type TimedModule = {
  relativeModuleId: string;
  diagnostic(): { duration: number };
  children: { allTests(): Iterable<TimedTest> };
};

export default class VitestBudgetReporter implements Reporter {
  onTestRunEnd(modules: readonly TimedModule[]) {
    const samples: DurationSample[] = [];
    for (const module of modules) {
      const file = module.relativeModuleId.replaceAll("\\", "/");
      // The opt-in live/probe/upgrade configs inherit the ordinary suite's reporters.
      if (!file.endsWith(".test.ts")) continue;
      samples.push({ file, durationMs: module.diagnostic().duration });
      for (const test of module.children.allTests()) {
        samples.push({ file, test: test.fullName, durationMs: test.diagnostic()?.duration ?? 0 });
      }
    }
    if (reportBudgetViolations(durationViolations("vitest", samples))) process.exitCode = 1;
  }
}
