#!/usr/bin/env node
// Renames the package scope across one or more repo roots. Re-runnable: a second run finds
// nothing. Dry-run by default.
//
//   node scripts/release/rename-scope.mjs <root>...          report what would change
//   node scripts/release/rename-scope.mjs --write <root>...  apply
//   node scripts/release/rename-scope.mjs --check <root>...  exit 1 if anything is left
//
// Works on text, not on syntax: package names, dependency keys, import specifiers, --filter
// arguments, tsconfig paths, Dockerfiles, compose files, workflows, docs and Tailwind @source
// paths all carry the same literal. Lockfiles are skipped; regenerate them afterwards.
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Assembled so that this script never matches itself.
const OLD_SCOPE = ["@vivd", "catalyst"].join("-");
const NEW_PREFIX = "@work-shape/catalyst-";

// Private client and deployment packages. They are never published, so they do not take the
// product prefix by default. Every package outside packages/ must be listed here; an unknown
// one stops the run instead of getting a guessed name.
const ASSEMBLY_TARGETS = {
  [`${OLD_SCOPE}/demo`]: "@work-shape/catalyst-demo",
  [`${OLD_SCOPE}/musterbau`]: "@work-shape/deployment-musterbau",
  [`${OLD_SCOPE}/catalyst-deployment`]: "@work-shape/deployment-catalyst",
  [`${OLD_SCOPE}/exampletax`]: "@work-shape/deployment-exampletax"
};

// Package-name changes only; directory moves and package folds belong to step D.
const PACKAGE_TARGETS = {
  ...ASSEMBLY_TARGETS,
  [`${OLD_SCOPE}/chat-server`]: "@work-shape/catalyst-server"
};

const SKIPPED_DIRECTORIES = new Set([
  ".astro",
  ".claude",
  ".git",
  ".terraform",
  ".tmp",
  ".turbo",
  ".venv",
  ".vite",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results"
]);
// Lockfiles are regenerated. A changelog records the names that were true when it was written.
const SKIPPED_FILES = new Set([
  "CHANGELOG.md",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const NAME_END = "(?![A-Za-z0-9_-])";
const assemblyPattern = new RegExp(
  `(${Object.keys(PACKAGE_TARGETS).map(escapeRegExp).join("|")})${NAME_END}`,
  "gu"
);
// A package name, or the `*` of a glob such as a pnpm filter or a tsconfig path.
const namePattern = new RegExp(`${escapeRegExp(OLD_SCOPE)}/(?=[a-z0-9*])`, "gu");
const leftoverPattern = new RegExp(escapeRegExp(OLD_SCOPE), "u");
const unscopedPattern = new RegExp(`(?<!@)${escapeRegExp(OLD_SCOPE.slice(1))}`, "gu");

function rewrite(text) {
  let count = 0;
  const bump = (replacement) => {
    count += 1;
    return replacement;
  };
  const rewritten = text
    .replace(assemblyPattern, (match) => bump(PACKAGE_TARGETS[match]))
    .replace(namePattern, () => bump(NEW_PREFIX));
  return { rewritten, count };
}

function* walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        yield* walk(path);
      }
    } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name)) {
      yield path;
    }
  }
}

function readPackageName(text) {
  try {
    const { name } = JSON.parse(text);
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function scanRoot(root, write) {
  const result = { root, files: [], occurrences: 0, unhandled: [], packages: [], unscoped: 0 };

  for (const path of walk(root)) {
    const file = relative(root, path);
    if (leftoverPattern.test(file)) {
      result.unhandled.push(`${file}: file path carries the scope`);
    }
    if (lstatSync(path).size > MAX_FILE_BYTES) {
      continue;
    }
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8192).includes(0)) {
      continue;
    }
    const text = buffer.toString("utf8");
    result.unscoped += text.match(unscopedPattern)?.length ?? 0;
    if (!leftoverPattern.test(text)) {
      continue;
    }

    if (file.split(sep).at(-1) === "package.json") {
      const name = readPackageName(text);
      if (name?.startsWith(`${OLD_SCOPE}/`)) {
        const isLibrary = file.split(sep).at(-3) === "packages";
        result.packages.push({
          file,
          name,
          target: rewrite(name).rewritten,
          kind: isLibrary ? "library" : "assembly",
          known: isLibrary || name in ASSEMBLY_TARGETS
        });
      }
    }

    const { rewritten, count } = rewrite(text);
    if (count > 0) {
      result.files.push({ file, count });
      result.occurrences += count;
    }
    rewritten.split("\n").forEach((line, index) => {
      if (leftoverPattern.test(line)) {
        result.unhandled.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
    if (write && count > 0) {
      writeFileSync(path, rewritten);
    }
  }
  return result;
}

function printResult(result, mode) {
  console.log(`\n== ${result.root}`);
  for (const { file, count } of result.files) {
    console.log(`  ${String(count).padStart(4)}  ${file}`);
  }
  const verb = mode === "write" ? "rewrote" : "would rewrite";
  console.log(`  ${verb} ${result.occurrences} occurrence(s) in ${result.files.length} file(s)`);

  const assemblies = result.packages.filter((pkg) => pkg.kind === "assembly");
  if (assemblies.length > 0) {
    console.log("  client and deployment packages:");
    for (const pkg of assemblies) {
      const note = pkg.known ? "" : "  <- no target in ASSEMBLY_TARGETS";
      console.log(`    ${pkg.name} -> ${pkg.target}  (${pkg.file})${note}`);
    }
  }
  if (result.unhandled.length > 0) {
    console.log("  not handled, needs a decision:");
    for (const line of result.unhandled) {
      console.log(`    ${line}`);
    }
  }
  if (result.unscoped > 0) {
    console.log(
      `  left alone: ${result.unscoped} unscoped "${OLD_SCOPE.slice(1)}" mention(s) (product rename is separate)`
    );
  }
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const roots = args.filter((arg) => !arg.startsWith("--")).map((root) => resolve(root));
const unknownFlags = [...flags].filter((flag) => flag !== "--write" && flag !== "--check");
if (
  roots.length === 0 ||
  unknownFlags.length > 0 ||
  (flags.has("--write") && flags.has("--check"))
) {
  console.error("Usage: rename-scope.mjs [--write | --check] <repo-root>...");
  process.exit(2);
}
const mode = flags.has("--write") ? "write" : flags.has("--check") ? "check" : "dry-run";

// First pass never writes: an unknown assembly package must stop the run before any file changes.
const scans = roots.map((root) => scanRoot(root, false));
const unknownPackages = scans.flatMap((scan) => scan.packages.filter((pkg) => !pkg.known));
const applied =
  mode === "write" && unknownPackages.length === 0
    ? roots.map((root) => scanRoot(root, true))
    : scans;
for (const result of applied) {
  printResult(result, mode === "write" && unknownPackages.length === 0 ? "write" : "dry-run");
}

const occurrences = scans.reduce((sum, scan) => sum + scan.occurrences, 0);
const unhandled = scans.reduce((sum, scan) => sum + scan.unhandled.length, 0);
console.log(
  `\n${mode}: ${occurrences} rewritable occurrence(s), ${unhandled} unhandled, ` +
    `${unknownPackages.length} package(s) without a target`
);

if (unknownPackages.length > 0) {
  console.error("Add the packages marked above to ASSEMBLY_TARGETS. Nothing was written.");
  process.exit(1);
}
if (mode === "check" && occurrences + unhandled > 0) {
  process.exit(1);
}
if (mode === "write" && unhandled > 0) {
  process.exit(1);
}
