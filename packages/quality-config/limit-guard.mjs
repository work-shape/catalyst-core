#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Fails a change that moves a check's limit (a size, length, baseline or timeout a check holds
// the code to) outside a pull request of its own. A limit is a line that ends with the comment
// marker check-limit, after `//` or `#`.
// Each limit is known by its file and its place in the configuration: the lines of smaller
// indentation that enclose it (the job, the object) and its own words (the key), each without
// numbers and punctuation. Its value is the numbers on the line, read without digit separators.
// Compared with the commit where the branch left its base, a limit moved when its value changed,
// it was added or removed, or its marker was dropped; a block that holds a limit is a table of
// limits, so a line with a number added to it is a new limit, marked or not. Marking an
// unchanged line, reformatting a number (500_000 and 500000) and moving a limit within its block
// are no move.
// A moved limit passes only in a pull request of its own that Felix approved: its title starts
// with "chore(limits)" (the hosted check passes the title), or, where no title is known (the
// landing lane), every commit of the branch has a subject that starts with "chore(limits)".
// Usage: catalyst-limit-guard <base commit> [<head commit> [<pull request title>]]

const prefix = "chore(limits)";
const marker = /\s*(?:\/\/|#)\s*check-limit\s*$/u;
const number = /\d[\d_]*(?:\.\d+)?/gu;
const [base, head = "HEAD", title = ""] = process.argv.slice(2);
if (!base)
  throw new Error(
    "Usage: catalyst-limit-guard <base commit> [<head commit> [<pull request title>]]"
  );

/**
 * @param {string[]} args
 * @param {number[]} [accepted]
 */
const git = (args, accepted = [0]) => {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status === null || !accepted.includes(result.status))
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result;
};

/** @param {string} line */
const indent = (line) => line.length - line.trimStart().length;
/**
 * A line's identity: its words with the numbers and the punctuation left out, so a trailing
 * comma that comes or goes when entries are reordered keeps the identity.
 * @param {string} text
 */
const shape = (text) =>
  text
    .replace(number, " ")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim();

/**
 * Every line with a number in a file at a commit, by its place: the enclosing lines and its own
 * text with the numbers left out. Several lines at one place keep their order.
 * @param {string} commit
 * @param {string} file
 * @returns {Map<string, { values: string; marked: boolean; text: string }[]>}
 */
function placesAt(commit, file) {
  /** @type {Map<string, { values: string; marked: boolean; text: string }[]>} */
  const places = new Map();
  const shown = git(["show", `${commit}:${file}`], [0, 128]);
  if (shown.status !== 0) return places;
  const lines = shown.stdout.split("\n");
  lines.forEach((line, index) => {
    const marked = marker.test(line);
    const text = line.replace(marker, "");
    const values = text.match(number);
    if (!values) return;
    const path = [shape(text)];
    let depth = indent(line);
    for (let above = index - 1; above >= 0 && depth > 0; above--) {
      const parent = lines[above] ?? "";
      const trimmed = parent.trim();
      if (!trimmed || /^(?:\/\/|#|\/?\*)/u.test(trimmed) || indent(parent) >= depth) continue;
      path.unshift(shape(parent.replace(marker, "")));
      depth = indent(parent);
    }
    const key = path.join(" > ");
    const entry = {
      values: values.map((value) => String(Number(value.replaceAll("_", "")))).join(" "),
      marked,
      text: text.trim()
    };
    places.set(key, [...(places.get(key) ?? []), entry]);
  });
  return places;
}

const mergeBase = git(["merge-base", base, head]).stdout.trim();
const files = git(["diff", "--name-only", "--no-renames", mergeBase, head])
  .stdout.split("\n")
  .filter(Boolean);

/** @type {string[]} */
const moved = [];
for (const file of files) {
  const before = placesAt(mergeBase, file);
  const after = placesAt(head, file);
  /** @param {string} key */
  const blockOf = (key) => key.split(" > ").slice(0, -1).join(" > ");
  // The blocks that hold a limit, before or after; the top of a file is no block.
  const tables = new Set(
    [...before, ...after]
      .filter(([key, entries]) => blockOf(key) && entries.some((entry) => entry.marked))
      .map(([key]) => blockOf(key))
  );
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key) ?? [];
    const now = after.get(key) ?? [];
    const count = Math.max(old.length, now.length);
    for (let index = 0; index < count; index++) {
      const was = old[index];
      const is = now[index];
      const added = !was && is !== undefined && tables.has(blockOf(key));
      if (!was?.marked && !is?.marked && !added) continue;
      // A marked limit must stay marked with the same value; marking an unchanged line is fine.
      if (was && is && was.values === is.values && (is.marked || !was.marked)) continue;
      const from = was ? `${was.text}${was.marked ? "" : " (unmarked)"}` : "(none)";
      const to = is ? `${is.text}${is.marked ? "" : " (unmarked)"}` : "(none)";
      moved.push(`  ${file}: ${blockOf(key) || "(top)"}: ${from} -> ${to}`);
    }
  }
}

if (!moved.length) {
  console.log(`No check limit moved since the merge base ${mergeBase}`);
} else {
  const listing = moved.join("\n");
  const subjects = git(["log", "--no-merges", "--format=%s", `${mergeBase}..${head}`])
    .stdout.split("\n")
    .filter(Boolean);
  const own = title
    ? title.startsWith(prefix)
    : subjects.length > 0 && subjects.every((subject) => subject.startsWith(prefix));
  if (own) {
    console.log(`Check limits moved in a ${prefix} change:\n${listing}`);
  } else {
    console.error(
      `A check limit moved outside a ${prefix} pull request:\n${listing}\n` +
        `A limit moves only in a pull request of its own, titled "${prefix}: ...", that Felix ` +
        `approved, and it lands alone. Take the change out of this branch, or fix what the ` +
        `check found instead.`
    );
    process.exitCode = 1;
  }
}
