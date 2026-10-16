#!/usr/bin/env node
// gh run download RUN -p 'browser-durations-*' -D /tmp/browser-RUN
// node scripts/refresh-e2e-durations.mjs RUN /tmp/browser-RUN/browser-durations-*/browser-durations.json
import { readFile, writeFile } from "node:fs/promises";
import { reportTests } from "./e2e-duration-shards.mjs";

const [run, ...paths] = process.argv.slice(2);
if (!/^\d+$/u.test(run ?? "") || !paths.length) {
  throw new Error("Usage: node scripts/refresh-e2e-durations.mjs MAIN_RUN_ID REPORT.json [...]");
}
const samples = new Map();
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  if (report.errors?.length) throw new Error(`Reporter errors in ${path}`);
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
  new URL("../e2e/durations.json", import.meta.url),
  `${JSON.stringify({ sourceRuns: [Number(run)], tests }, null, 2)}\n`
);
console.log(`Measured ${samples.size} browser titles from main run ${run}`);
