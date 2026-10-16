#!/usr/bin/env node
// Packages a lockfile resolves from a URL tarball (SheetJS from cdn.sheetjs.com, a dependency
// of chat-ui and tool-execution) are verified only by the integrity the lockfile records. pnpm
// never computes one for them, and drops a recorded one when it re-resolves such a package, on
// `--lockfile-only` and on a full install alike. The kit restores the integrity it knows after
// every lockfile it writes, and its checks refuse a lockfile without it.
//
//   lock-integrity.mjs restore LOCKFILE [INPUT_LOCKFILE]   restore, then check
//   lock-integrity.mjs check LOCKFILE [INPUT_LOCKFILE]
//
// A check fails when LOCKFILE resolves a URL tarball without an integrity, or with one other
// than the kit knows or INPUT_LOCKFILE records for the same tarball.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pinned to core's pnpm-lock.yaml, where SEC-1 verified it against the upstream tarball. The
// kit's tests fail when the two differ.
export const KNOWN_INTEGRITY = new Map([
  [
    "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
    "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA=="
  ]
]);

// pnpm writes each resolution on one line: resolution: {integrity: sha512-..., tarball: https://...}
const RESOLUTION = /resolution: \{([^}]*)\}/gu;

function fields(resolution) {
  return Object.fromEntries(
    resolution.split(", ").map((field) => {
      const separator = field.indexOf(": ");
      return [field.slice(0, separator), field.slice(separator + 2)];
    })
  );
}

const isUrl = (tarball) => /^https?:\/\//u.test(tarball ?? "");

/** @returns {Map<string, string | undefined>} integrity by URL tarball */
export function urlTarballs(lockfile) {
  const tarballs = new Map();
  for (const [, resolution] of lockfile.matchAll(RESOLUTION)) {
    const { tarball, integrity } = fields(resolution);
    if (isUrl(tarball)) tarballs.set(tarball, integrity);
  }
  return tarballs;
}

/** The lockfile with the known integrity put back where pnpm left a known tarball without one. */
export function restoreIntegrity(lockfile) {
  return lockfile.replaceAll(RESOLUTION, (line, resolution) => {
    const { tarball, integrity } = fields(resolution);
    const known = KNOWN_INTEGRITY.get(tarball);
    return known && !integrity ? `resolution: {integrity: ${known}, ${resolution}}` : line;
  });
}

export function integrityProblems(lockfile, input = "") {
  const recorded = urlTarballs(input);
  const problems = [];
  for (const [tarball, integrity] of urlTarballs(lockfile)) {
    const expected = KNOWN_INTEGRITY.get(tarball) ?? recorded.get(tarball);
    if (!integrity) {
      problems.push(`${tarball} has no integrity in the lockfile`);
    } else if (expected && integrity !== expected) {
      problems.push(`${tarball} has the integrity ${integrity}, not ${expected}`);
    }
  }
  return problems;
}

// Node runs the real file of a linked script, as under node_modules, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, lockfile, input] = process.argv.slice(2);
  if (!["restore", "check"].includes(command) || !lockfile) {
    console.error("usage: lock-integrity.mjs restore|check LOCKFILE [INPUT_LOCKFILE]");
    process.exit(2);
  }
  let content = readFileSync(lockfile, "utf8");
  if (command === "restore") {
    content = restoreIntegrity(content);
    writeFileSync(lockfile, content);
  }
  const problems = integrityProblems(
    content,
    input && existsSync(input) ? readFileSync(input, "utf8") : ""
  );
  for (const problem of problems) console.error(`lock-integrity: ${problem}`);
  if (problems.length > 0) {
    console.error(
      `lock-integrity: ${lockfile} does not authenticate every URL tarball. Do not add an ` +
        "integrity by hand: fetch the tarball, verify it upstream, then pin it in the kit."
    );
    process.exit(1);
  }
}
