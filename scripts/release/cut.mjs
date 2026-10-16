#!/usr/bin/env node
// Cut a lockstep release locally. This creates commits, never tags or publishes.
// pnpm release:cut 0.8.0 --root ../capabilities
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  foldChanges,
  main as changelog,
  readChanges,
  releaseHeading,
  repoRoot
} from "./changelog.mjs";

function run(command, args, root, stdio = "pipe") {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio });
}

export { checkCurrentVersion } from "./versions.mjs";
import { checkCurrentVersion, compareVersions, manifests, versionParts } from "./versions.mjs";

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (root, args) => ["git", "-C", root, ...args].map(quote).join(" ");
const undoCommands = (repositories) => [
  "Or undo the cut in BOTH repositories (discards the cut and any subsequent local edits):",
  ...repositories.map(({ root, before }) => command(root, ["reset", "--hard", before]))
];

function prepare(root, version, heading) {
  if (realpathSync(run("git", ["rev-parse", "--show-toplevel"], root).trim()) !== root)
    throw new Error(`${root} is not a repository root.`);
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], root).trim() !== "")
    throw new Error(`${root} is dirty; commit or stash all changes before cutting a release.`);
  try {
    run("git", ["symbolic-ref", "--quiet", "HEAD"], root);
  } catch {
    throw new Error(`${root} needs a release branch.`);
  }

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
  return {
    root,
    packages,
    changes,
    nextChangelog,
    before: run("git", ["rev-parse", "HEAD"], root).trim()
  };
}

export function cut(args, coreRoot = repoRoot) {
  const [version, ...options] = args;
  versionParts(version);
  if (!(
    options.length === 2 &&
    options[0] === "--root" &&
    options[1] &&
    !options[1].startsWith("--")
  ))
    throw new Error("Usage: pnpm release:cut <version> --root ../capabilities");
  const roots = [realpathSync(coreRoot), realpathSync(resolve(coreRoot, options[1]))];
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
  checkCurrentVersion(roots);
  try {
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
      run("git", ["diff", "--cached", "--check"], root);
    }
  } catch (error) {
    throw new Error(
      [
        `Release preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        ...repositories.map(({ root, before }) => {
          const head = run("git", ["rev-parse", "HEAD"], root).trim();
          const staged = run("git", ["diff", "--cached", "--name-only"], root).trim() !== "";
          const unstaged = run("git", ["diff", "--name-only"], root).trim() !== "";
          return `${root}: cut uncommitted, HEAD ${head === before ? "unchanged at" : "at"} ${head} (before ${before}; staged changes: ${staged ? "yes" : "no"}; unstaged changes: ${unstaged ? "yes" : "no"}).`;
        }),
        ...undoCommands(repositories)
      ].join("\n")
    );
  }
  const message = `chore(release): cut ${version}`;
  try {
    for (const { root, packages, changes } of repositories) {
      run("git", ["commit", "-m", message], root, "inherit");
      console.log(
        `${root}: cut ${version} at ${run("git", ["rev-parse", "HEAD"], root).trim()} (${packages.length} manifests, ${changes.length} change files).`
      );
    }
  } catch (error) {
    // Git commits across repositories cannot be atomic (hooks/signing can fail).
    // Both cuts are staged: report actual heads and commands that recover without rerunning cut.
    const states = repositories.map(({ root, before }) => ({
      root,
      before,
      head: run("git", ["rev-parse", "HEAD"], root).trim()
    }));
    throw new Error(
      [
        `Release commit failed: ${error instanceof Error ? error.message : String(error)}`,
        ...states.map(
          ({ root, head, before }) =>
            `${root}: ${head === before ? "cut staged, HEAD unchanged at" : "committed cut at"} ${head} (before ${before}).`
        ),
        "After fixing the commit failure and inspecting the staged cut, finish with (do not rerun release:cut):",
        ...states
          .filter(({ head, before }) => head === before)
          .map(({ root }) => command(root, ["commit", "-m", message])),
        ...undoCommands(states)
      ].join("\n")
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cut(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("No tags or packages were published.");
    process.exitCode = 1;
  }
}
