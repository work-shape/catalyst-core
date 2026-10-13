#!/usr/bin/env node
// Every workspace package a package imports must be declared in its own package.json.
// An undeclared import resolves by accident from the workspace root and breaks where the
// install is filtered, such as the UI image of an assembly.
//
// Source files need the package in dependencies or peerDependencies; tests, scripts and
// config files may also take it from devDependencies.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const groups = ["packages", "clients"];
const sourceFile = /\.(?:[cm]?[jt]sx?|astro|mdx)$/;
const testFile =
  /(?:\.(?:test|spec|stories)\.[cm]?[jt]sx?$)|(?:^|\/)(?:tests?|__tests__|e2e|scripts|test-support)\//;
const skipDirectories = new Set(["node_modules", "dist", ".astro", ".vite", ".turbo", "coverage"]);
const specifier =
  /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](@[\w.-]+\/[\w.-]+)(?:\/[^"']*)?["']/g;

function packageDirectories() {
  const found = [];
  for (const group of groups) {
    for (const entry of readdirSync(join(root, group))) {
      const directory = join(root, group, entry);
      try {
        statSync(join(directory, "package.json"));
        found.push(directory);
      } catch {
        // not a package
      }
    }
  }
  return found;
}

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) yield* files(join(directory, entry.name));
    } else if (sourceFile.test(entry.name)) {
      yield join(directory, entry.name);
    }
  }
}

const packages = packageDirectories().map((directory) => ({
  directory,
  manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
}));
const workspaceNames = new Set(packages.map((entry) => entry.manifest.name));
// Packages that bundle their workspace imports into dist and so declare them as devDependencies.
const bundling = new Set(["@work-shape/catalyst-cli"]); // see packages/config-cli/tsup.config.ts
const faults = [];

for (const { directory, manifest } of packages) {
  const runtime = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ]);
  const development = new Set(Object.keys(manifest.devDependencies ?? {}));
  const seen = new Set();
  for (const file of files(directory)) {
    const path = relative(directory, file);
    const inSource = path.startsWith("src/") && !testFile.test(path);
    for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
      const name = match[1];
      if (!workspaceNames.has(name) || name === manifest.name) continue;
      const devIsEnough = !inSource || bundling.has(manifest.name);
      if (runtime.has(name) || (devIsEnough && development.has(name))) continue;
      const need = inSource ? "dependencies" : "devDependencies";
      const key = `${name} ${need}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const wrongPlace = inSource && development.has(name) ? " (only in devDependencies)" : "";
      faults.push(
        `${manifest.name}: ${name} missing from ${need}${wrongPlace}, first import in ${relative(root, file)}`
      );
    }
  }
}

if (faults.length > 0) {
  console.error(`Undeclared workspace imports (${faults.length}):`);
  for (const fault of faults.sort()) console.error(`  ${fault}`);
  process.exit(1);
}
console.log(`Workspace imports are declared in ${packages.length} packages.`);
