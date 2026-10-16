// Writes the package version and core commit to dist/catalyst/release.json for deployment
// provenance. Also keeps the platform commit in dist/catalyst/commit.json, as
// {"commit": "<sha>"}, so a reader (the hand-over check) can tell which commit the published docs
// show. Every publish builds with this script, so the file cannot fall out of step with the site.
//
//   node scripts/write-commit.mjs [<platform commit>]
//
// The commit is the argument when one is given, else the HEAD of the platform checkout this
// package sits in. The build passes CATALYST_PLATFORM_COMMIT as the argument, so a build without
// Git metadata sets that variable; a value that is not 40 hexadecimal characters fails the build.
// A checkout whose root is not the platform root (a source export inside another repository) is
// not asked: its HEAD is another repository's. Without either the site is built without the file
// and the script says so; release:check refuses a site without release provenance.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const platformRoot = realpathSync(resolve(here, "../../.."));
const target = resolve(here, "../dist/catalyst/commit.json");
const sha = /^[0-9a-f]{40}$/u;

/** The HEAD of the platform checkout, or undefined when this package is not in one. */
function platformHead() {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  try {
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== platformRoot) return undefined;
    return git(["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

const given = process.argv[2]?.trim().toLowerCase();
if (given !== undefined && given !== "" && !sha.test(given)) {
  process.stderr.write(`write-commit: "${given}" is not a 40-character commit\n`);
  process.exit(1);
}
const commit = given || platformHead();
if (commit && sha.test(commit)) {
  const { version } = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
  writeFileSync(target, `${JSON.stringify({ commit })}\n`);
  writeFileSync(
    resolve(here, "../dist/catalyst/release.json"),
    `${JSON.stringify({ version, coreCommit: commit })}\n`
  );
} else {
  process.stderr.write(
    "write-commit: no platform commit (no argument, and this package is not in a platform Git checkout); catalyst/commit.json and catalyst/release.json are not written\n"
  );
}
