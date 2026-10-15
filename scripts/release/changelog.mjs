#!/usr/bin/env node
// The changelog from one file per change. A pull request adds `changes/unreleased/<slug>.md` and
// leaves CHANGELOG.md alone, so two pull requests never edit the same lines. The release folds
// the files into CHANGELOG.md.
//
//   node scripts/release/changelog.mjs                  print the Unreleased section as the
//                                                       release will write it
//   node scripts/release/changelog.mjs --check          exit 1 when a change file is malformed
//   node scripts/release/changelog.mjs --root ../capabilities --check
//                                                       validate another repository's files
//   node scripts/release/changelog.mjs --release 0.7.0 [--date 2026-10-20]
//                                                       fold the change files into CHANGELOG.md
//                                                       under that version and delete them
//
// A change file is front matter naming its section, then the entry as Markdown list items:
//
//   ---
//   section: Fixed
//   ---
//
//   - **Chat:** ...
//
// Entries written into the Unreleased section of CHANGELOG.md before change files existed stay
// there; the release puts each change file's entry after them, files in name order.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const changesPath = "changes/unreleased";

/** The sections of a release, in the order the changelog lists them. */
export const SECTIONS = ["Added", "Changed", "Fixed", "Database"];

const UNRELEASED = "## Unreleased";

/**
 * @typedef {{ file: string, section: string, body: string }} Change
 * @typedef {{ changes: Change[], errors: string[] }} ChangeFiles
 */

/**
 * Reads one change file. Returns the change, or the reasons it cannot be released.
 * @param {string} file
 * @param {string} text
 * @returns {Change | { file: string, errors: string[] }}
 */
export function parseChange(file, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match)
    return { file, errors: [`starts with front matter: "---", "section: <section>", "---"`] };
  const [, frontMatter = "", rest = ""] = match;
  /** @type {string[]} */
  const errors = [];
  /** @type {string | undefined} */
  let section;
  for (const line of frontMatter.split(/\r?\n/u).filter((line) => line.trim() !== "")) {
    const field = /^(\w+):\s*(.*?)\s*$/u.exec(line);
    if (field?.[1] === "section") section = field[2];
    else errors.push(`front matter holds only "section", not "${line.trim()}"`);
  }
  if (section === undefined) errors.push(`front matter names no section`);
  else if (!SECTIONS.includes(section))
    errors.push(`section "${section}" is none of ${SECTIONS.join(", ")}`);
  const body = rest.replace(/\s+$/u, "").replace(/^\s*\n/u, "");
  if (body === "") errors.push("holds no entry after the front matter");
  else if (!body.startsWith("- "))
    errors.push(`the entry is a Markdown list item: "- **Area:** …"`);
  if (body.split("\n").some((line) => line.startsWith("#")))
    errors.push("holds no heading; the release writes the version and the section headings");
  return errors.length > 0 || section === undefined ? { file, errors } : { file, section, body };
}

/**
 * Every change file of a repository, in name order.
 * @param {string} [root]
 * @returns {ChangeFiles}
 */
export function readChanges(root = repoRoot) {
  const directory = join(root, changesPath);
  if (!existsSync(directory)) return { changes: [], errors: [] };
  /** @type {ChangeFiles} */
  const result = { changes: [], errors: [] };
  const files = readdirSync(directory)
    .filter((file) => !file.startsWith("."))
    .sort();
  for (const file of files) {
    const path = `${changesPath}/${file}`;
    if (!file.endsWith(".md")) {
      result.errors.push(`${path}: a change file ends in .md`);
      continue;
    }
    const change = parseChange(path, readFileSync(join(directory, file), "utf8"));
    if ("errors" in change)
      result.errors.push(...change.errors.map((error) => `${path}: ${error}`));
    else result.changes.push(change);
  }
  return result;
}

/** @param {string[]} lines */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * CHANGELOG.md with the change files folded into its Unreleased section, under `heading`. A
 * changelog without an Unreleased section gets the section before its newest release.
 * @param {string} changelog
 * @param {Change[]} changes
 * @param {string} [heading]
 * @returns {{ text: string, section: string }}
 */
export function foldChanges(changelog, changes, heading = UNRELEASED) {
  const lines = changelog.split("\n");
  const firstRelease = lines.findIndex((line) => line.startsWith("## "));
  const start = firstRelease < 0 ? lines.length : firstRelease;
  const hasUnreleased = lines[start]?.trim() === UNRELEASED;
  let end = start;
  if (hasUnreleased) {
    end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    if (end < 0) end = lines.length;
  }

  /** @type {Map<string, string[]>} */
  const sections = new Map();
  /** @type {string[]} */
  const preface = [];
  let current = preface;
  for (const line of hasUnreleased ? lines.slice(start + 1, end) : []) {
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      current = sections.get(name) ?? [];
      sections.set(name, current);
    } else current.push(line);
  }
  for (const change of changes) {
    const entries = sections.get(change.section) ?? [];
    sections.set(change.section, [...trimBlankLines(entries), ...change.body.split("\n")]);
  }

  const order = [
    ...SECTIONS.filter((name) => sections.has(name)),
    ...[...sections.keys()].filter((name) => !SECTIONS.includes(name))
  ];
  const rendered = [heading, ""];
  const intro = trimBlankLines(preface);
  if (intro.length > 0) rendered.push(...intro, "");
  for (const name of order) {
    const entries = trimBlankLines(sections.get(name) ?? []);
    if (entries.length > 0) rendered.push(`### ${name}`, "", ...entries, "");
  }
  const section = rendered.join("\n");
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const text = [...before, ...rendered, ...after].join("\n");
  return { text, section: section.replace(/\n+$/u, "\n") };
}

/** @param {string} root */
function readChangelog(root) {
  return readFileSync(join(root, "CHANGELOG.md"), "utf8");
}

/** @param {string} version @param {string} date */
export function releaseHeading(version, date) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(`"${version}" is not a version such as 0.7.0`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    throw new Error(`"${date}" is not a date such as 2026-10-20`);
  return `## ${version} — ${date}`;
}

/** @param {Date} now */
function localDate(now) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** @param {string[]} args @param {string} name */
function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/**
 * @param {string[]} args
 * @param {string} [root]
 * @returns {number} the exit code
 */
export function main(args, root = repoRoot) {
  // Parse the whole command before reading files so typos cannot produce a false green check.
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--check") continue;
    if (!["--root", "--release", "--date"].includes(flag)) {
      console.error(`Unknown argument: ${flag}`);
      return 1;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`${flag} takes a value.`);
      return 1;
    }
    index += 1;
  }
  const target = option(args, "--root");
  if (args.includes("--root")) {
    if (target === undefined || target.startsWith("--")) {
      console.error("--root takes a repository directory.");
      return 1;
    }
    root = resolve(target);
  }
  const { changes, errors } = readChanges(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(
      `\n${errors.length} problem(s) in ${changesPath}. See the Changelog section of README.md.`
    );
    return 1;
  }
  if (args.includes("--check")) {
    console.log(`${changes.length} change file(s) in ${changesPath} are ready for the release.`);
    return 0;
  }
  const version = option(args, "--release");
  if (args.includes("--release") && (version === undefined || version.startsWith("--"))) {
    console.error("--release takes the version, such as --release 0.7.0.");
    return 1;
  }
  if (version === undefined) {
    process.stdout.write(foldChanges(readChangelog(root), changes).section);
    return 0;
  }
  const changelog = readChangelog(root);
  if (changes.length === 0 && !changelog.split("\n").some((line) => line.trim() === UNRELEASED)) {
    console.error(
      `Nothing to release: ${changesPath} is empty and CHANGELOG.md has no Unreleased section.`
    );
    return 1;
  }
  let heading;
  try {
    heading = releaseHeading(version, option(args, "--date") ?? localDate(new Date()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  writeFileSync(join(root, "CHANGELOG.md"), foldChanges(changelog, changes, heading).text);
  for (const change of changes) rmSync(join(root, change.file));
  console.log(
    `CHANGELOG.md: "${heading}" with ${changes.length} change file(s), which are deleted.`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `pnpm changelog | head` closes the pipe early; that is not a failure.
  process.stdout.on("error", (error) => {
    if (!("code" in error) || error.code !== "EPIPE") throw error;
  });
  process.exitCode = main(process.argv.slice(2));
}
