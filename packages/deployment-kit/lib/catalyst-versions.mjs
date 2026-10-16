#!/usr/bin/env node
// The Catalyst release a deployment runs: every @work-shape/catalyst-* dependency in its
// package.json at one exact release version, installed from the registry.
//
//   catalyst-versions.mjs check ROOT            exact, equal, no local specifier, no override
//   catalyst-versions.mjs version ROOT          prints that version
//   catalyst-versions.mjs installed ROOT        node_modules holds that version, not a link
//   catalyst-versions.mjs bump ROOT VERSION     pins VERSION, rewrites the lockfile, prints notes
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { integrityProblems, restoreIntegrity } from "./lock-integrity.mjs";

const CATALYST_PACKAGE = /^@work-shape\/catalyst-/u;
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// The versions the release workflows publish: vX.Y.Z and vX.Y.Z-rc.N tags.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u;
const LOCAL_SPECIFIER = /^(file|link|portal|workspace):/u;
// The repositories whose GitHub releases carry the changelog section of each version.
const RELEASE_REPOSITORIES = ["work-shape/catalyst-core", "work-shape/catalyst-capabilities"];

export function catalystDependencies(manifest) {
  return SECTIONS.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => CATALYST_PACKAGE.test(name))
      .map(([name, spec]) => ({ section, name, spec }))
  );
}

// An override key is a name, name@range or a parent>child chain.
function overriddenCatalystNames(overrides) {
  return Object.keys(overrides ?? {}).filter((key) =>
    key.split(">").some((part) => CATALYST_PACKAGE.test(part.replace(/(.)@.*$/u, "$1")))
  );
}

export function versionProblems(manifest) {
  const dependencies = catalystDependencies(manifest);
  if (dependencies.length === 0) {
    return ["package.json names no @work-shape/catalyst-* dependency"];
  }
  const problems = [];
  for (const { section, name, spec } of dependencies) {
    if (LOCAL_SPECIFIER.test(spec)) {
      problems.push(
        `${section}.${name} is ${spec}: a local package never reaches a release; pin a released version (catalyst-deploy bump)`
      );
    } else if (!RELEASE_VERSION.test(spec)) {
      problems.push(`${section}.${name} is ${spec}, not an exact release version such as 0.8.0`);
    }
  }
  const versions = [...new Set(dependencies.map(({ spec }) => spec))];
  if (versions.length > 1) {
    problems.push(
      `the catalyst packages name ${versions.length} versions (${versions.join(", ")}); all must be one release`
    );
  }
  for (const [field, overrides] of [
    ["pnpm.overrides", manifest.pnpm?.overrides],
    ["resolutions", manifest.resolutions]
  ]) {
    for (const key of overriddenCatalystNames(overrides)) {
      problems.push(`${field}.${key} replaces a pinned catalyst package`);
    }
  }
  return problems;
}

export function withVersion(manifest, version) {
  const next = structuredClone(manifest);
  for (const { section, name } of catalystDependencies(manifest)) {
    next[section][name] = version;
  }
  return next;
}

function parseVersion(version) {
  const match = RELEASE_VERSION.exec(version);
  if (!match) return undefined;
  const [, major, minor, patch, candidate] = match;
  return [major, minor, patch, candidate ?? Infinity].map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readManifest(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function fail(problems) {
  for (const problem of problems) console.error(`catalyst-deploy: ${problem}`);
  process.exit(1);
}

function pinnedVersion(root) {
  const manifest = readManifest(root);
  const problems = versionProblems(manifest);
  if (problems.length > 0) fail(problems);
  return { manifest, version: catalystDependencies(manifest)[0].spec };
}

function installedProblems(root, manifest, version) {
  const problems = [];
  for (const { name } of catalystDependencies(manifest)) {
    const directory = join(root, "node_modules", name);
    if (!existsSync(directory)) {
      problems.push(`${name} is not installed; run pnpm install --frozen-lockfile`);
      continue;
    }
    const real = realpathSync(directory);
    if (!real.includes(`${sep}node_modules${sep}.pnpm${sep}`)) {
      problems.push(
        `${name} links ${real}, not the released package; run the check on a standalone install (pnpm install --frozen-lockfile --ignore-workspace)`
      );
      continue;
    }
    const installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
    if (installed !== version) {
      problems.push(
        `${name} is installed at ${installed}, pinned at ${version}; run pnpm install --frozen-lockfile`
      );
    }
  }
  return problems;
}

async function missingFromRegistry(names, version) {
  const run = promisify(execFile);
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const { stdout } = await run("npm", ["view", `${name}@${version}`, "version", "--json"]);
        return stdout.trim() === "" ? `${name}@${version} is not on npm` : undefined;
      } catch (error) {
        const detail = String(error.stderr ?? error.message)
          .split("\n")
          .find((line) => line.trim() !== "");
        return `${name}@${version} is not on npm (${detail})`;
      }
    })
  );
  return results.filter((problem) => problem !== undefined);
}

function printReleaseNotes(from, to) {
  for (const repository of RELEASE_REPOSITORIES) {
    let tags;
    try {
      tags = JSON.parse(
        execFileSync(
          "gh",
          ["release", "list", "-R", repository, "--limit", "200", "--json", "tagName"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }
        )
      )
        .map(({ tagName }) => tagName.replace(/^v/u, ""))
        .filter((tag) => parseVersion(tag))
        .filter((tag) => compareVersions(tag, to) <= 0 && (!from || compareVersions(tag, from) > 0))
        .sort(compareVersions);
    } catch {
      console.log(`\nRelease notes: https://github.com/${repository}/releases`);
      continue;
    }
    for (const tag of tags) {
      const body = execFileSync(
        "gh",
        ["release", "view", `v${tag}`, "-R", repository, "--json", "body", "--jq", ".body"],
        { encoding: "utf8" }
      );
      console.log(`\n## ${repository} v${tag}\n\n${body.trim()}`);
    }
  }
}

async function bump(root, version) {
  if (!RELEASE_VERSION.test(version ?? "")) {
    fail([`bump takes a release version such as 0.8.0 or 0.8.0-rc.1, got ${version ?? "none"}`]);
  }
  const manifest = readManifest(root);
  const dependencies = catalystDependencies(manifest);
  if (dependencies.length === 0) fail(versionProblems(manifest));
  const names = [...new Set(dependencies.map(({ name }) => name))];
  const missing = await missingFromRegistry(names, version);
  if (missing.length > 0) {
    fail([...missing, "nothing changed; restricted packages need a read token (npm whoami)"]);
  }
  const previous = [...new Set(dependencies.map(({ spec }) => spec))];
  const manifestFile = join(root, "package.json");
  const lockFile = join(root, "pnpm-lock.yaml");
  const before = { manifest: readFileSync(manifestFile, "utf8"), lock: readText(lockFile) };
  writeFileSync(manifestFile, `${JSON.stringify(withVersion(manifest, version), null, 2)}\n`);
  // The deployment's own lockfile, resolved from the registry. A workspace around it (the
  // local development links) is not part of it.
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-workspace"], {
    cwd: root,
    stdio: "inherit"
  });
  // pnpm records no integrity for a URL tarball (SheetJS) it resolves afresh. Put back the one
  // the kit knows; a lockfile that still does not authenticate one is put back, with
  // package.json.
  const lock = restoreIntegrity(readText(lockFile));
  writeFileSync(lockFile, lock);
  const problems = integrityProblems(lock, before.lock);
  if (problems.length > 0) {
    writeFileSync(manifestFile, before.manifest);
    if (before.lock === "") rmSync(lockFile, { force: true });
    else writeFileSync(lockFile, before.lock);
    fail([
      ...problems,
      "nothing changed: the new lockfile does not authenticate every URL tarball"
    ]);
  }
  console.log(
    `\nPinned ${names.length} catalyst packages at ${version} (were ${previous.join(", ")}).`
  );
  const from = previous.length === 1 && parseVersion(previous[0]) ? previous[0] : undefined;
  printReleaseNotes(from, version);
  console.log("\nReview the diff of package.json and pnpm-lock.yaml and commit both together.");
}

// Node runs the real file of a linked script, as under node_modules, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, version] = process.argv.slice(2);
  if (!root) fail(["usage: catalyst-versions.mjs check|version|installed|bump ROOT [VERSION]"]);
  if (command === "check") {
    const { manifest, version: pinned } = pinnedVersion(root);
    console.log(
      `catalyst-deploy: ${catalystDependencies(manifest).length} catalyst packages pinned at ${pinned}`
    );
  } else if (command === "version") {
    console.log(pinnedVersion(root).version);
  } else if (command === "installed") {
    const { manifest, version: pinned } = pinnedVersion(root);
    const problems = installedProblems(root, manifest, pinned);
    if (problems.length > 0) fail(problems);
    console.log(`catalyst-deploy: node_modules holds the released ${pinned}`);
  } else if (command === "bump") {
    await bump(root, version);
  } else {
    fail([`unknown command: ${command}`]);
  }
}
