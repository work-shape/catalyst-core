#!/usr/bin/env node
// Refuses a change that names a customer or an accounting vendor: in its commit messages,
// the lines and file paths it adds and, for a pull request, its title and body. Core is
// public, so the names are kept only as SHA-256 digests (tests/support/name-hashes.ts), and
// a finding is reported by place, never by the word, so a CI log does not repeat it.
//
//   node scripts/check-names.mjs --range <base>..<head> [--event <GitHub event file>]
//   node scripts/check-names.mjs --text <file>
// The digests are read from the base revision (`--hashes-from`, default: the range's base), so
// a change cannot pass by removing a digest. `--hashes <file>` reads them from a file instead.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIGEST = /\b[0-9a-f]{64}\b/gu;
const HASH_FILE = "tests/support/name-hashes.ts";

export function readDigests(file) {
  return new Set(readFileSync(file, "utf8").match(DIGEST) ?? []);
}

/** The same words and word pairs as `deniedNames` in tests/support/name-hashes.ts. */
export function namesIn(text, digests) {
  const lower = text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase();
  const words = [...lower.matchAll(/[a-z]+|[0-9]+/gu)];
  const found = new Set();
  const check = (candidate) => {
    if (digests.has(createHash("sha256").update(candidate).digest("hex"))) found.add(candidate);
  };
  for (const [index, word] of words.entries()) {
    check(word[0]);
    const next = words[index + 1];
    if (next && /^[\s_-]*$/u.test(lower.slice(word.index + word[0].length, next.index))) {
      check(word[0] + next[0]);
    }
  }
  return found.size;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });

/** Every place a range adds text: commit messages, added lines and new paths. */
export function rangePlaces(cwd, range) {
  const places = [];
  const [base, head] = range.split("..");
  const from = git(cwd, ["merge-base", base, head]).trim();
  for (const record of git(cwd, ["log", "--format=%H%x00%B%x1e", `${from}..${head}`]).split(
    "\x1e"
  )) {
    const [sha, message] = record.replace(/^\n/u, "").split("\0");
    if (sha) places.push({ where: `commit ${sha.slice(0, 9)} message`, text: message ?? "" });
  }
  let file = "";
  let line = 0;
  for (const row of git(cwd, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    `${from}..${head}`
  ]).split("\n")) {
    if (row.startsWith("+++ ")) {
      file = row.slice(4).replace(/^b\//u, "");
      if (file !== "/dev/null") places.push({ where: `path ${file}`, text: file });
    } else if (row.startsWith("@@")) {
      line = Number(/\+(\d+)/u.exec(row)?.[1] ?? 0);
    } else if (row.startsWith("+")) {
      places.push({ where: `${file}:${line}`, text: row.slice(1) });
      line += 1;
    }
  }
  return places;
}

export function eventPlaces(file) {
  const pull = JSON.parse(readFileSync(file, "utf8")).pull_request;
  if (!pull) return [];
  return [
    { where: "pull request title", text: pull.title ?? "" },
    { where: "pull request body", text: pull.body ?? "" },
    { where: "pull request branch", text: pull.head?.ref ?? "" }
  ];
}

function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = fileURLToPath(new URL("..", import.meta.url));
  const range = option("--range");
  const revision = option("--hashes-from") ?? range?.split("..")[0];
  const digests = option("--hashes")
    ? readDigests(option("--hashes"))
    : revision
      ? new Set(git(process.cwd(), ["show", `${revision}:${HASH_FILE}`]).match(DIGEST) ?? [])
      : readDigests(`${root}${HASH_FILE}`);
  if (digests.size === 0) throw new Error("check-names: no name digests found");
  const places = [];
  if (range) places.push(...rangePlaces(process.cwd(), range));
  if (option("--event")) places.push(...eventPlaces(option("--event")));
  if (option("--text"))
    places.push({ where: option("--text"), text: readFileSync(option("--text"), "utf8") });
  const found = places.filter((place) => namesIn(place.text, digests) > 0);
  for (const place of found) {
    console.error(`::error::check-names: a customer or vendor name in ${place.where}`);
  }
  if (found.length > 0) {
    console.error(
      "check-names: use a neutral name (Musterbau, Example Tax, ExampleData) or a ticket id. " +
        "Rewrite the commit (git commit --amend / git rebase -i) before pushing."
    );
    return 1;
  }
  console.log(`check-names: ${places.length} places checked, no names`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
