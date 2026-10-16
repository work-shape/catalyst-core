#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  affectedPackages,
  affectedTests,
  isGlobalChange,
  packageDirectory,
  qualityScopes
} from "./affected-selection.mjs";

const started = Date.now();
const root = process.cwd();
const base = process.env.AFFECTED_BASE ?? "origin/main";
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status})${result.stderr ? `\n${result.stderr.trim()}` : ""}`
    );
  return result.stdout ?? "";
};
const gitFiles = (...args) => run("git", args, true).split("\0").filter(Boolean);
const files = gitFiles("ls-files", "-co", "--exclude-standard", "-z").filter((file) =>
  existsSync(file)
);
// Include both the branch diff and builders' uncommitted edits, including renames/deletions.
const changed = [
  ...new Set([
    ...gitFiles("diff", "--name-only", "-z", `${base}...HEAD`),
    ...gitFiles("diff", "--name-only", "-z", "HEAD"),
    ...gitFiles("ls-files", "--others", "--exclude-standard", "-z")
  ])
];
const packages = files
  .filter((file) => /^(?:packages|clients)\/[^/]+\/package\.json$/u.test(file))
  .map((file) => ({ dir: packageDirectory(file), ...JSON.parse(readFileSync(file, "utf8")) }));
const graph = {};
// Manifests are the source of the package graph.
for (const pkg of packages)
  graph[pkg.name] = [
    ...new Set([
      ...["dependencies", "devDependencies", "peerDependencies"].flatMap((key) =>
        Object.entries(pkg[key] ?? {})
          .filter(([, version]) => String(version).startsWith("workspace:"))
          .map(([name]) => name)
      )
    ])
  ];
const selected = affectedPackages(graph, packages, changed);
const scopes = qualityScopes(packages, selected);
const config = ts.readConfigFile("tsconfig.tests.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const dependencies = new Map();
const visit = (file) => {
  if (file.endsWith("/") || dependencies.has(file) || !existsSync(file)) return;
  const source = readFileSync(file, "utf8");
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  const edges = imports.flatMap(({ fileName }) => {
    const found = ts.resolveModuleName(
      fileName,
      resolve(file),
      parsed.options,
      ts.sys
    ).resolvedModule;
    if (!found) return [];
    const path = relative(root, found.resolvedFileName).replaceAll("\\", "/");
    return path.startsWith("../") || path.includes("node_modules/") ? [] : [path];
  });
  // Some contract tests read scripts/assets with fs or spawn a CLI instead of importing it.
  // Package paths in their source are conservative dependency edges too.
  for (const match of source.matchAll(/\b(?:packages|clients)\/[A-Za-z0-9._-]+/gu))
    if (packages.some((pkg) => pkg.dir === match[0])) edges.push(`${match[0]}/`);
  dependencies.set(file, edges);
  for (const edge of edges) visit(edge);
};
const tests = files.filter((file) => /^tests\/.*\.test\.ts$/u.test(file));
for (const file of tests) visit(file);
const globalChange = changed.some((file) => isGlobalChange(file, packages));
const testsToRun = globalChange ? tests : affectedTests(tests, dependencies, scopes, changed);
console.log(
  `check:affected vs ${base}: ${selected.length} packages, ${testsToRun.length} test files`
);
console.log(selected.join("\n") || "No affected packages");
if (process.argv.includes("--list")) {
  console.log(testsToRun.join("\n"));
  process.exit(0);
}
const temp = mkdtempSync(join(tmpdir(), "catalyst-affected-"));
try {
  if (selected.length) {
    // Build dependencies as prerequisites: package exports and tests can load dist files.
    run("pnpm", [
      "-r",
      ...selected.flatMap((name) => ["--filter", `${name}...`]),
      "--if-present",
      "build"
    ]);
    const scopeFile = join(temp, "scopes.json");
    writeFileSync(scopeFile, JSON.stringify(scopes));
    for (const target of ["types:packages", "lint"])
      run("pnpm", [
        "exec",
        "catalyst-quality",
        target,
        ...(globalChange ? [] : [`--scope-file=${scopeFile}`])
      ]);
    for (const pkg of packages.filter((pkg) => selected.includes(pkg.name)))
      if (pkg.scripts?.typecheck && !pkg.scripts.typecheck.startsWith("tsc "))
        run("pnpm", ["--filter", pkg.name, "typecheck"]);
    if (scopes.includes("packages/deployment-kit")) run("pnpm", ["test:deployment-kit"]);
  }
  // Vitest strips types; changed package exports can break otherwise passing root tests.
  // Keep the whole test type scope so baseline counts stay exact.
  if (
    selected.length ||
    testsToRun.length ||
    globalChange ||
    changed.some((file) => /^(tests|e2e)\//u.test(file))
  )
    run("pnpm", ["typecheck:tests"]);
  if (testsToRun.length) run("pnpm", ["exec", "vitest", "run", ...testsToRun]);
  if (globalChange) run(process.execPath, ["--test", "scripts/check-affected.test.mjs"]);
  console.log(`check:affected passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
