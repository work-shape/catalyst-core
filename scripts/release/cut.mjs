#!/usr/bin/env node
// Cut a lockstep release locally. This creates commits, never tags or publishes.
// pnpm release:cut 0.8.0 [--root ../capabilities]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  foldChanges,
  main as changelog,
  readChanges,
  releaseHeading,
  repoRoot
} from "./changelog.mjs";

// Strict SemVer, including numeric prerelease identifiers without leading zeroes.
const NUMBER = "(?:0|[1-9][0-9]*)";
const IDENTIFIER = `(?:${NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u"
);

function versionParts(version) {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!match || match[0] !== version) throw new Error(`"${version}" is not a SemVer version.`);
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

/** SemVer precedence: build metadata does not affect the order. */
function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^[0-9]+$/u.test(x);
    const numericY = /^[0-9]+$/u.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function run(command, args, root, stdio = "pipe") {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function manifests(root) {
  const paths = [join(root, "package.json")];
  for (const folder of ["packages", "clients"]) {
    const parent = join(root, folder);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(path)) paths.push(path);
    }
  }
  return paths.map((path) => ({ path, manifest: readJson(path) }));
}

function prepare(root, version, heading) {
  if (realpathSync(run("git", ["rev-parse", "--show-toplevel"], root).trim()) !== root)
    throw new Error(`${root} is not a repository root.`);
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], root).trim() !== "")
    throw new Error(`${root} is dirty; commit or stash all changes before cutting a release.`);
  if (run("git", ["symbolic-ref", "--quiet", "HEAD"], root).trim() === "")
    throw new Error(`${root} needs a release branch.`);

  const packages = manifests(root);
  for (const { manifest } of packages) {
    if (manifest.version !== undefined && compareVersions(version, manifest.version) <= 0)
      throw new Error(`${manifest.name}: ${version} must be higher than ${manifest.version}.`);
  }
  const { changes, errors } = readChanges(root);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  if (text.split("\n").some((line) => line.startsWith(`## ${version} — `)))
    throw new Error(`${root}: ${version} already has a changelog section.`);
  // Allow an empty companion cut: both repositories always advance, even when only one changed.
  const nextChangelog = foldChanges(text, changes, heading).text;
  return { root, packages, changes, nextChangelog };
}

export function cut(args, coreRoot = repoRoot) {
  const [version, ...options] = args;
  versionParts(version);
  if (
    options.length !== 0 &&
    !(options.length === 2 && options[0] === "--root" && options[1] && !options[1].startsWith("--"))
  )
    throw new Error("Usage: pnpm release:cut <version> [--root ../capabilities]");
  const roots = [realpathSync(coreRoot)];
  if (options.length > 0) roots.push(realpathSync(resolve(coreRoot, options[1])));
  if (new Set(roots).size !== roots.length)
    throw new Error("--root must name a different repository.");
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  const heading = releaseHeading(version, date);
  // Finish every refusal check in both repositories before changing either tree.
  const repositories = roots.map((root) => prepare(root, version, heading));
  for (const repository of repositories) {
    const { root, packages, changes, nextChangelog } = repository;
    for (const { path, manifest } of packages)
      writeFileSync(path, serialize({ ...manifest, version }));
    // Use the existing changelog command, including its deletion of the folded change files.
    // An empty companion release still gets a section to record its lockstep cut.
    if (changes.length === 0) {
      writeFileSync(join(root, "CHANGELOG.md"), nextChangelog);
    } else if (changelog(["--release", version, "--date", date], root) !== 0) {
      throw new Error(`${root}: changelog fold failed.`);
    }
  }
  run("pnpm", ["generate:openapi"], roots[0], "inherit");
  run("pnpm", ["release:check"], roots[0], "inherit");
  for (const { root, packages, changes } of repositories) {
    const paths = [
      ...packages.map(({ path }) => path),
      join(root, "CHANGELOG.md"),
      ...changes.map(({ file }) => join(root, file))
    ];
    if (root === roots[0]) paths.push(join(root, "packages/api-contract/openapi.json"));
    run("git", ["add", "--", ...paths], root);
    run("git", ["commit", "-m", `chore(release): cut ${version}`], root, "inherit");
    console.log(
      `${root}: cut ${version} (${packages.length} manifests, ${changes.length} change files).`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cut(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "No tags or packages were published. If a gate failed, inspect the uncommitted cut before retrying from a clean tree."
    );
    process.exitCode = 1;
  }
}
