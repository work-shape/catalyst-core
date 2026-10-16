#!/usr/bin/env node
// catalyst-deploy pack-local: builds a deployment's release images from the platform and
// capabilities packages of the local workspace instead of the registry, for a change that is
// not released yet.
//
// It builds and packs every published package of ../platform and ../capabilities into
// <deployment>/.local-packages/, copies the deployment's files (what Git tracks or would track)
// to a scratch folder, points every catalyst package there at its tarball (file: specifiers and
// overrides, a lockfile written for them), and runs the deployment's deploy/docker-bake.hcl in
// that folder with the images loaded into the local engine. The deployment's own files do not
// change; `catalyst-deploy check` refuses file: specifiers, so such a manifest never reaches a
// release.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalystDependencies } from "./catalyst-versions.mjs";
import { integrityProblems, restoreIntegrity } from "./lock-integrity.mjs";

const kitDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DIR = ".local-packages";

function fail(message) {
  console.error(`pack-local: ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n==> ${title}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
}

export function workspacePackages(repositoryRoot) {
  const packagesDir = join(repositoryRoot, "packages");
  return readdirSync(packagesDir)
    .map((entry) => join(packagesDir, entry))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
    .filter(({ manifest }) => manifest.private !== true && /^@work-shape\//u.test(manifest.name));
}

// The deployment's manifest with every catalyst package taken from its tarball: its own
// dependencies by file: specifier, and every other one through an override, so a package that
// depends on another resolves the local one too.
export function localManifest(manifest, tarballs, packageManager) {
  const next = structuredClone(manifest);
  const fileSpecifier = (name) => `file:${LOCAL_DIR}/${tarballs.get(name)}`;
  for (const { section, name } of catalystDependencies(manifest)) {
    if (!tarballs.has(name)) {
      throw new Error(`the workspace has no package ${name}, which package.json names`);
    }
    next[section][name] = fileSpecifier(name);
  }
  next.pnpm = {
    ...next.pnpm,
    overrides: {
      ...next.pnpm?.overrides,
      ...Object.fromEntries([...tarballs.keys()].map((name) => [name, fileSpecifier(name)]))
    }
  };
  if (!next.packageManager && packageManager) next.packageManager = packageManager;
  return next;
}

function parseArgs(argv) {
  const options = {
    deploymentRoot: undefined,
    releaseTag: "pack-local",
    workspace: undefined,
    skipBuild: false,
    keep: false,
    targets: []
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--deployment-root" || arg === "--release-tag") {
      const value = args.shift();
      if (!value) fail(`${arg} requires a value`);
      options[arg === "--deployment-root" ? "deploymentRoot" : "releaseTag"] = value;
    } else if (arg === "--workspace") {
      options.workspace = args.shift();
      if (!options.workspace) fail("--workspace requires a value");
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg.startsWith("-")) {
      fail(`unknown argument: ${arg}`);
    } else {
      options.targets.push(arg);
    }
  }
  return options;
}

function copyDeploymentFiles(root, destination) {
  const files = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  )
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith(`${LOCAL_DIR}/`));
  for (const file of files) {
    const source = join(root, file);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue; // deleted in the working tree
    }
    if (stat.isDirectory()) continue;
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(source, join(destination, file), { verbatimSymlinks: true });
  }
}

function packPackages(repositories, outDir, skipBuild) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The folder ignores itself, so the deployment needs no .gitignore entry for it.
  writeFileSync(join(outDir, ".gitignore"), "*\n");
  const tarballs = new Map();
  for (const repository of repositories) {
    const packages = workspacePackages(repository);
    if (!skipBuild) {
      step(`Build ${packages.length} packages of ${repository}`);
      const filters = packages.flatMap(({ manifest }) => ["--filter", manifest.name]);
      run("pnpm", ["-r", ...filters, "build"], { cwd: repository });
    }
    step(`Pack ${packages.length} packages of ${repository}`);
    for (const { dir, manifest } of packages) {
      const before = new Set(readdirSync(outDir));
      run("pnpm", ["pack", "--pack-destination", outDir], {
        cwd: dir,
        stdio: ["ignore", "ignore", "inherit"]
      });
      const created = readdirSync(outDir).filter((file) => !before.has(file));
      if (created.length !== 1) fail(`pnpm pack of ${manifest.name} wrote ${created.length} files`);
      tarballs.set(manifest.name, created[0]);
      console.log(`${manifest.name.padEnd(48)} ${created[0]}`);
    }
  }
  return tarballs;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.deploymentRoot;
  if (!root) fail("--deployment-root is required; run this as catalyst-deploy pack-local");
  const workspace = resolve(options.workspace ?? join(root, ".."));
  const repositories = ["platform", "capabilities"].map((name) => join(workspace, name));
  for (const repository of repositories) {
    if (!existsSync(join(repository, "packages"))) {
      fail(`no ${repository}/packages; pass --workspace DIR, the folder with both checkouts`);
    }
  }
  const bakeFile = join(root, "deploy", "docker-bake.hcl");
  if (!existsSync(bakeFile) || !readFileSync(bakeFile, "utf8").includes("deployment.Dockerfile")) {
    fail(
      "deploy/docker-bake.hcl does not build docker/deployment.Dockerfile of the kit; see the kit README"
    );
  }

  const tarballs = packPackages(repositories, join(root, LOCAL_DIR), options.skipBuild);

  const context = mkdtempSync(join(tmpdir(), "catalyst-pack-local-"));
  try {
    step(`Throwaway build context ${context}`);
    copyDeploymentFiles(root, context);
    cpSync(join(root, LOCAL_DIR), join(context, LOCAL_DIR), { recursive: true });
    const platformManifest = JSON.parse(
      readFileSync(join(repositories[0], "package.json"), "utf8")
    );
    const manifest = JSON.parse(readFileSync(join(context, "package.json"), "utf8"));
    writeFileSync(
      join(context, "package.json"),
      `${JSON.stringify(localManifest(manifest, tarballs, platformManifest.packageManager), null, 2)}\n`
    );
    run("pnpm", ["install", "--lockfile-only", "--ignore-workspace"], { cwd: context });
    // pnpm records no integrity for a URL tarball (SheetJS); the build's fetch verifies the one
    // the kit knows.
    const lockFile = join(context, "pnpm-lock.yaml");
    const lock = restoreIntegrity(readFileSync(lockFile, "utf8"));
    writeFileSync(lockFile, lock);
    const problems = integrityProblems(lock);
    if (problems.length > 0) fail(problems.join("; "));

    step("Build the images");
    // catalyst-deploy sets the bake file's variables: CATALYST_KIT, NPMRC, PUSH, RELEASE_TAG.
    // The kit's Dockerfile lies outside the build context, which bake reads only when allowed.
    const bake = ["buildx", "bake", `--allow=fs.read=${join(kitDir, "docker")}`];
    // The images go to the local engine. --load would not replace the bake file's own output.
    const load = "--set=*.output=type=docker";
    run("docker", [...bake, "--file", "deploy/docker-bake.hcl", load, ...options.targets], {
      cwd: context
    });
    console.log(
      `\npack-local: images tagged ${options.releaseTag} from the packages in ${join(root, LOCAL_DIR)}`
    );
  } finally {
    if (options.keep) {
      console.log(`pack-local: kept the build context ${context}`);
    } else {
      rmSync(context, { recursive: true, force: true });
    }
  }
}

// Node runs the real file of a linked script, as under node_modules, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
