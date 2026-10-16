#!/usr/bin/env node
// Release-only, one-way mirror. Copy only tracked files from the four approved folders;
// public-facing docs, examples and the workflow come from approved release assets.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLIC_PACKAGE_DIRS, repoRoot } from "./package-metadata.mjs";
import { assertReleaseContext } from "./context.mjs";
import { guard } from "./guard.mjs";
import { publicLockfile } from "./mirror-lock.mjs";

export function mirror(source, destination) {
  guard([source]);
  const assets = join(source, "scripts/release/public");
  rmSync(join(destination, "examples"), { recursive: true, force: true });
  rmSync(join(destination, ".github/workflows"), { recursive: true, force: true });
  for (const file of ["README.md", "LICENSE", "SECURITY.md", "examples"])
    cpSync(join(assets, file), join(destination, file), { recursive: true });
  mkdirSync(join(destination, ".github/workflows"), { recursive: true });
  cpSync(join(assets, "publish.yml"), join(destination, ".github/workflows/publish.yml"));
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...PUBLIC_PACKAGE_DIRS.map((dir) => `packages/${dir}`)],
    { cwd: source, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
  // Remove the previous package snapshot, including any package removed from the allowlist.
  rmSync(join(destination, "packages"), { recursive: true, force: true });
  for (const file of tracked) {
    const from = join(source, file);
    // Symlinks could disclose files outside the public folders on a later build/pack.
    const stat = execFileSync("git", ["ls-files", "-s", "--", file], {
      cwd: source,
      encoding: "utf8"
    });
    if (stat.startsWith("120000")) throw new Error(`Mirror refuses symlink ${file}`);
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(from, join(destination, file));
  }
  const core = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  writeFileSync(
    join(destination, "package.json"),
    JSON.stringify(
      {
        name: "catalyst-public",
        version: core.version,
        private: true,
        type: "module",
        packageManager: core.packageManager,
        scripts: {
          build: "pnpm -r build",
          "release:publish": "node scripts/release/publish.mjs --group public"
        }
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(
    join(destination, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\noverrides:\n  zod: 4.4.3\n'
  );
  // Seed pnpm with only the reachable public graph, preserving core's exact resolutions.
  const lock = publicLockfile(readFileSync(join(source, "pnpm-lock.yaml"), "utf8"));
  writeFileSync(join(destination, ".npmrc"), `auto-install-peers=${lock.autoInstallPeers}\n`);
  writeFileSync(join(destination, "pnpm-lock.yaml"), lock.content);
  const config = JSON.parse(readFileSync(join(source, "tsconfig.base.json"), "utf8"));
  config.compilerOptions.paths = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).filter(([name]) =>
      PUBLIC_PACKAGE_DIRS.some(
        (dir) =>
          JSON.parse(readFileSync(join(source, "packages", dir, "package.json"), "utf8")).name ===
          name
      )
    )
  );
  writeFileSync(join(destination, "tsconfig.base.json"), JSON.stringify(config, null, 2) + "\n");
  // Replace previous helpers and discard workflow-only bootstrap change files.
  rmSync(join(destination, "scripts/release"), { recursive: true, force: true });
  rmSync(join(destination, "changes"), { recursive: true, force: true });
  mkdirSync(join(destination, "scripts/release"), { recursive: true });
  cpSync(
    join(assets, "package-metadata.mjs"),
    join(destination, "scripts/release/package-metadata.mjs")
  );
  for (const file of ["context.mjs", "registry.mjs", "publish.mjs", "guard.mjs", "versions.mjs"])
    cpSync(join(source, "scripts/release", file), join(destination, "scripts/release", file));
  writeFileSync(join(destination, ".gitignore"), "node_modules/\ndist/\n*.tsbuildinfo\n*.tgz\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = resolve(process.argv[2] ?? "");
  if (!existsSync(join(destination, ".git")))
    throw new Error("Mirror destination must be a checkout");
  const dryRun = process.argv.includes("--dry-run");
  const version = dryRun
    ? JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
    : assertReleaseContext(repoRoot);
  const git = (...args) => execFileSync("git", args, { cwd: destination, encoding: "utf8" }).trim();
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
  let branch = "main";
  if (!dryRun) {
    if (git("remote", "get-url", "origin") !== "git@github.com:work-shape/catalyst.git")
      throw new Error("Mirror writes only to work-shape/catalyst with its dedicated deploy key");
    if (git("status", "--porcelain")) throw new Error("Mirror checkout must be clean");
    // A rerun must not move a tag, or publish a different snapshot under the same version.
    const tags = git("tag", "--list", `v${version}`);
    if (tags) {
      if (!git("show", "-s", "--format=%B", `v${version}`).includes(`Core-Commit: ${sourceCommit}`))
        throw new Error(`Public tag v${version} belongs to a different core commit`);
      console.log(`Public mirror already tagged v${version}`);
      process.exit(0);
    }
  }
  if (!dryRun) {
    const branches = execFileSync(
      "git",
      ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    if (!branches.split("\n").includes("origin/main")) {
      branch = `release/${version.split(".").slice(0, 2).join(".")}.x`;
      const existing = git(
        "branch",
        "-r",
        "--list",
        `origin/${branch}`,
        "--format=%(refname:short)"
      );
      git("checkout", "-B", branch, existing || "HEAD");
    }
  }
  mirror(repoRoot, destination);
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: destination,
    stdio: "inherit"
  });
  if (!dryRun) {
    git("config", "user.name", "Workshape release");
    git("config", "user.email", "release@workshape.ai");
    git(
      "add",
      "--",
      "packages",
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
      ".gitignore",
      ".npmrc",
      "scripts/release",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "examples",
      ".github/workflows/publish.yml"
    );
    if (git("ls-files", "changes")) git("add", "-u", "--", "changes");
    git("commit", "-m", `chore(release): mirror v${version}`, "-m", `Core-Commit: ${sourceCommit}`);
    git("tag", `v${version}`);
    git("push", "--atomic", "origin", `HEAD:${branch}`, `refs/tags/v${version}`);
  }
}
