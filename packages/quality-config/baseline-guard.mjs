#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { baselineRises } from "./baseline.mjs";

// Fails a pull request that raises a count in quality-baseline.json or adds an entry to it,
// compared with the commit where the pull request left its base branch.
// Usage: catalyst-quality-baseline-guard <base commit> [<head commit>]

const file = "quality-baseline.json";
const [base, head = "HEAD"] = process.argv.slice(2);
if (!base) throw new Error("Usage: catalyst-quality-baseline-guard <base commit> [<head commit>]");

/**
 * @param {string[]} args
 * @param {number[]} accepted
 */
const git = (args, accepted) => {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status === null || !accepted.includes(result.status))
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result;
};

const mergeBase = git(["merge-base", base, head], [0]).stdout.trim();
// A base without a baseline has nothing to hold the counts to.
if (git(["cat-file", "-e", `${mergeBase}:./${file}`], [0, 1, 128]).status !== 0) {
  console.log(`${file} does not exist on the merge base ${mergeBase}; nothing to compare`);
} else {
  const rises = baselineRises(
    JSON.parse(git(["show", `${mergeBase}:./${file}`], [0]).stdout),
    JSON.parse(readFileSync(file, "utf8"))
  );
  if (rises.length) {
    console.error(
      `${file} was raised compared with the merge base ${mergeBase}. Counts may only fall: repair the new findings instead of recording them.\n${rises.join("\n")}`
    );
    process.exitCode = 1;
  } else console.log(`${file}: no count is higher than on the merge base ${mergeBase}`);
}
