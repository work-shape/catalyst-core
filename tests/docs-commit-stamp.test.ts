import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../packages/docs/scripts/write-commit.mjs", import.meta.url));
const given = "0123456789abcdef0123456789abcdef01234567";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Lays out a platform tree at `<outer>/<platform>` with the stamp script and a built site, and
 * returns the paths. Git searches no further up than `outer`, so no repository around the test
 * run is found.
 */
function layout(platform: string) {
  const outer = mkdtempSync(join(tmpdir(), "catalyst-docs-stamp-"));
  directories.push(outer);
  const root = join(outer, platform);
  mkdirSync(join(root, "packages/docs/scripts"), { recursive: true });
  mkdirSync(join(root, "packages/docs/dist/catalyst"), { recursive: true });
  const copy = join(root, "packages/docs/scripts/write-commit.mjs");
  copyFileSync(script, copy);
  writeFileSync(
    join(root, "packages/docs/package.json"),
    JSON.stringify({ version: "0.8.0-rc.1" })
  );
  return { outer, root, copy, stamp: join(root, "packages/docs/dist/catalyst/commit.json") };
}

function git(cwd: string, ...args: string[]) {
  const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test"];
  const run = spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

/** Makes `cwd` a repository with one commit and returns that commit. */
function repository(cwd: string) {
  git(cwd, "init", "--quiet");
  git(cwd, "commit", "--quiet", "--allow-empty", "--message", "init");
  return git(cwd, "rev-parse", "HEAD");
}

function stamp(paths: ReturnType<typeof layout>, ...args: string[]) {
  return spawnSync(process.execPath, [paths.copy, ...args], {
    cwd: paths.root,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(paths.outer) }
  });
}

const written = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

describe("docs commit stamp", () => {
  it("stamps the HEAD of the platform checkout", () => {
    const paths = layout("platform");
    const head = repository(paths.root);
    const run = stamp(paths, "");
    expect(run.status).toBe(0);
    expect(written(paths.stamp)).toEqual({ commit: head });
    expect(written(join(dirname(paths.stamp), "release.json"))).toEqual({
      version: "0.8.0-rc.1",
      coreCommit: head
    });
  });

  it("stamps a given commit, also without Git metadata", () => {
    const paths = layout("platform");
    const run = stamp(paths, given.toUpperCase());
    expect(run.status).toBe(0);
    expect(written(paths.stamp)).toEqual({ commit: given });
    expect(written(join(dirname(paths.stamp), "release.json"))).toEqual({
      version: "0.8.0-rc.1",
      coreCommit: given
    });
  });

  it("fails on a given value that is not a commit", () => {
    const paths = layout("platform");
    repository(paths.root);
    for (const value of ["main", given.slice(0, 12), `${given}0`, "$(true)"]) {
      const run = stamp(paths, value);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("is not a 40-character commit");
      expect(existsSync(paths.stamp)).toBe(false);
      expect(existsSync(join(dirname(paths.stamp), "release.json"))).toBe(false);
    }
  });

  it("skips with a warning without Git metadata or a given commit", () => {
    const paths = layout("platform");
    const run = stamp(paths, "");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("no platform commit");
    expect(existsSync(paths.stamp)).toBe(false);
    expect(existsSync(join(dirname(paths.stamp), "release.json"))).toBe(false);
  });

  it("does not stamp the commit of another repository the platform tree sits in", () => {
    const paths = layout("export/platform");
    repository(paths.outer);
    const run = stamp(paths);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("no platform commit");
    expect(existsSync(paths.stamp)).toBe(false);
    expect(existsSync(join(dirname(paths.stamp), "release.json"))).toBe(false);
  });
});
