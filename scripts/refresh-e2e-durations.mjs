#!/usr/bin/env node
// gh run download RUN -p 'browser-durations-*' -D /tmp/browser-RUN
// node scripts/refresh-e2e-durations.mjs RUN /tmp/browser-RUN/browser-durations-*/browser-durations.json
// gh run download RUN -p 'vitest-durations-*' -D /tmp/vitest-RUN
// node scripts/refresh-e2e-durations.mjs --vitest RUN /tmp/vitest-RUN/vitest-durations-*/vitest-durations.json
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reportTests } from "./e2e-duration-shards.mjs";

const args = process.argv.slice(2);
const vitest = args[0] === "--vitest";
if (vitest) args.shift();
const [run, ...paths] = args;
if (!/^\d+$/u.test(run ?? "") || !paths.length) {
  throw new Error(
    "Usage: node scripts/refresh-e2e-durations.mjs [--vitest] MAIN_RUN_ID REPORT.json [...]"
  );
}
const samples = new Map();
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  if (report.errors?.length) throw new Error(`Reporter errors in ${path}`);
  if (vitest) {
    if (!report.success) throw new Error(`Unsuccessful Vitest report in ${path}`);
    for (const file of report.testResults) {
      // JSON reports carry runner-absolute paths; keep stable repository-relative keys.
      const key = file.name.replaceAll("\\", "/").match(/(?:^|\/)(tests\/.*\.test\.ts)$/u)?.[1];
      if (!key) throw new Error(`Unrecognized Vitest file: ${file.name}`);
      const duration = file.endTime - file.startTime;
      if (!Number.isFinite(duration) || duration < 0)
        throw new Error(`Invalid Vitest duration: ${file.name}`);
      const values = samples.get(key) ?? [];
      values.push(duration);
      samples.set(key, values);
    }
    continue;
  }
  for (const test of reportTests(report)) {
    // Measure the initial attempt, including expected failures, rather than a fast retry.
    const first = test.results.find((result) => result.retry === 0);
    if (!first || first.status === "skipped" || first.status === "interrupted") continue;
    const values = samples.get(test.key) ?? [];
    values.push(first.duration);
    samples.set(test.key, values);
  }
}
if (!samples.size) throw new Error("No executed tests in the supplied reports");
const tests = Object.fromEntries(
  [...samples]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [key, Math.max(1, Math.round(values[Math.floor(values.length / 2)]))];
    })
);
await writeFile(
  vitest ? resolve("tests/durations.json") : new URL("../e2e/durations.json", import.meta.url),
  `${JSON.stringify({ sourceRuns: [Number(run)], tests }, null, 2)}\n`
);
console.log(
  `Measured ${samples.size} ${vitest ? "Vitest files" : "browser titles"} from main run ${run}`
);
