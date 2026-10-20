#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import ts from "typescript";
import {
  affectedPackages,
  affectedTests,
  isGlobalChange,
  packageDirectory,
  qualityScopes
} from "./affected-selection.mjs";
import { testImportGraph } from "./affected-graph.mjs";
import {
  connectionsForWorkers,
  defaultTestWorkers,
  workersForConnections
} from "./test-postgres-capacity.mjs";

const started = Date.now();
const root = process.cwd();
const resolves = (ref) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root })
    .status === 0;
// Lane worktrees on the Mac Mini name the remote `github`, not `origin`.
const defaultBase = () => {
  const remotes = spawnSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: root,
    encoding: "utf8"
  })
    .stdout.split("\n")
    .map(
      (line) => line.match(/^remote\.(.+)\.url \S*work-shape\/catalyst-core(?:\.git)?\/?$/u)?.[1]
    )
    .filter(Boolean)
    .map((remote) => `${remote}/main`);
  const candidates = [...new Set(["origin/main", "github/main", ...remotes])];
  const found = candidates.find(resolves);
  if (found) return found;
  console.error(
    `check:affected: no base branch found; tried ${candidates.join(", ")}. Fetch main from work-shape/catalyst-core or set AFFECTED_BASE.`
  );
  process.exit(2);
};
const base = process.env.AFFECTED_BASE || defaultBase();
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
const tests = files.filter((file) => /^tests\/.*\.test\.ts$/u.test(file));
const dependencies = testImportGraph({
  root,
  tests,
  packageDirs: packages.map((pkg) => pkg.dir),
  options: parsed.options
});
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
// A test Postgres with too few connections makes Vitest run fewer test files at once, down to
// two on Postgres's default of 100, and a run of many files then takes hours. Refuse it before
// anything is built, with the command that starts one of the right size.
const testUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
if (testsToRun.length && testUrl) {
  const wanted = Math.min(defaultTestWorkers(), testsToRun.length);
  const sql = postgres(testUrl, { max: 1, connect_timeout: 5, onnotice() {} });
  const maxConnections = await sql`select setting from pg_settings where name = 'max_connections'`
    .then(([row]) => Number(row?.setting))
    // A server that cannot be asked fails the tests, which say why.
    .catch(() => Number.NaN)
    .finally(() => sql.end({ timeout: 5 }).catch(() => undefined));
  const room = workersForConnections(maxConnections);
  if (Number.isInteger(maxConnections) && room < wanted) {
    const image = readFileSync("docker/postgres/pinned-image", "utf8")
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("#"))
      ?.trim();
    console.error(
      `check:affected: the test Postgres has max_connections ${maxConnections}, room for ${room} of the ${wanted} test files this run starts at once. ` +
        `Start it with max_connections ${connectionsForWorkers(wanted)}:\n` +
        `  docker run --detach --publish 127.0.0.1::5432 --env POSTGRES_USER=catalyst --env POSTGRES_PASSWORD=local-check --env POSTGRES_DB=catalyst_test ${image} -c max_connections=${connectionsForWorkers(wanted)}\n` +
        `or run pnpm check:local, which starts one of that size, or set CATALYST_TEST_WORKERS=${room} to run fewer at once.`
    );
    process.exit(1);
  }
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
