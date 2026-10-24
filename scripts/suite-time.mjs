#!/usr/bin/env node
// The one time limit of the test suites: Vitest's `Duration` or Playwright's `passed (…)` time,
// read from a run's log, must stay within 15 minutes on a 16-core machine, scaled by 16 / cores
// on another. The nightly runs it after each suite; nothing is limited per test or per file.
//
//   node scripts/suite-time.mjs vitest|playwright LOG [CORES]
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export const LIMIT_SECONDS = 15 * 60;
export const REFERENCE_CORES = 16;

const units = { ms: 0.001, s: 1, m: 60, h: 3600 };
const colourCode = new RegExp(`${String.fromCharCode(27)}?\\[[0-9;]*m`, "gu");

/** The suite's wall time in seconds, from the summary line its runner prints last. */
export function suiteSeconds(kind, log) {
  // Colour codes, with their escape byte or, as a downloaded Actions log shows them, without.
  const text = log.replace(colourCode, "");
  const pattern =
    kind === "vitest"
      ? /^\s*Duration\s+([\d.]+)(ms|s|m|h)\b/gmu
      : /^\s*\d+ passed \(([\d.]+)(ms|s|m|h)\)/gmu;
  const found = [...text.matchAll(pattern)].at(-1);
  if (!found) return undefined;
  return Number(found[1]) * units[found[2]];
}

export function limitSeconds(cores) {
  return Math.round((LIMIT_SECONDS * REFERENCE_CORES) / cores);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, path, coresArgument] = process.argv.slice(2);
  if ((kind !== "vitest" && kind !== "playwright") || !path) {
    console.error("usage: suite-time.mjs vitest|playwright LOG [CORES]");
    process.exit(2);
  }
  const cores = Number(coresArgument ?? availableParallelism());
  const seconds = suiteSeconds(kind, readFileSync(path, "utf8"));
  const limit = limitSeconds(cores);
  if (seconds === undefined) {
    console.error(`suite-time: ${path} has no ${kind} summary line; did the suite finish?`);
    process.exit(1);
  }
  const line = `${kind} took ${Math.round(seconds)} s; the limit on ${cores} cores is ${limit} s`;
  if (seconds > limit) {
    console.error(
      `suite-time: ${line}. Make the slowest files faster or move volume to *.scale.test.ts.`
    );
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Suite time::${line}`);
    process.exit(1);
  }
  console.log(`suite-time: ${line}.`);
}
