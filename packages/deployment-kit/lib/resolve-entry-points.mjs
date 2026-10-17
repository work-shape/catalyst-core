#!/usr/bin/env node
// Starts every built process entry point of a deployment once per release config with the
// argument `--resolve-only`: the process loads the config, resolves its modules against the
// build it was assembled from, makes the checks that need only the two and ends before it
// opens a store or a provider. A config the schema refuses, or a process that would stop on
// one of those checks, fails here and not on the host.
//
// Usage: resolve-entry-points.mjs DEPLOYMENT_ROOT
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** The processes of an instance, under the entry names the Compose checks in `verify/` hold. */
const PROCESS_ENTRY_POINTS = [
  "server.js",
  "agent-run-worker.js",
  "knowledge-worker.js",
  "workspace-command-worker.js",
  "artifact-preview-worker.js"
];
/** A bound on a hang: a resolve-only run ends in seconds, a process that serves never does. */
const RUN_TIMEOUT_MS = 120_000;
/** What a process prints before it ends a resolve-only run, as client-assembly words it. */
const RESOLVE_ONLY_MARKER = "resolve-only: this process starts with this config";

const [rootArgument] = process.argv.slice(2);
if (!rootArgument) throw new Error("Usage: resolve-entry-points.mjs DEPLOYMENT_ROOT");
const deploymentRoot = resolve(rootArgument);

/** The configs a release starts from: every `app*.yaml` that no other one extends. */
async function releaseConfigs(configDir) {
  const candidates = (await readdir(configDir))
    .filter((name) => /^app(?:\..+)?\.yaml$/u.test(name))
    .sort();
  const extended = new Set();
  for (const name of candidates) {
    const contents = await readFile(join(configDir, name), "utf8");
    const match = contents.match(/^\s*extends:\s*["']?([^"'#\s]+)["']?/mu);
    if (match) extended.add(basename(resolve(configDir, match[1])));
  }
  return candidates.filter((name) => !extended.has(name));
}

const configDir = join(deploymentRoot, "config");
const configs = await releaseConfigs(configDir);
if (configs.length === 0) throw new Error("No release config entrypoints found");
const entryPoints = PROCESS_ENTRY_POINTS.filter((name) =>
  existsSync(join(deploymentRoot, "dist", name))
);
if (entryPoints.length === 0) throw new Error("No built process entry point found under dist/");
const notBuilt = PROCESS_ENTRY_POINTS.filter((name) => !entryPoints.includes(name));
console.log(`entry points run: ${entryPoints.join(", ")}`);
console.log(`entry points this deployment does not build: ${notBuilt.join(", ") || "none"}`);

const failures = [];
for (const config of configs) {
  for (const entryPoint of entryPoints) {
    // `env` adds the config path to the environment the process inherits from the gate.
    const run = spawnSync(
      "env",
      [
        `CLIENT_CONFIG_PATH=${join(configDir, config)}`,
        process.execPath,
        join(deploymentRoot, "dist", entryPoint),
        "--resolve-only"
      ],
      {
        cwd: deploymentRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: RUN_TIMEOUT_MS,
        killSignal: "SIGKILL"
      }
    );
    if (run.error?.code === "ETIMEDOUT") {
      failures.push(
        `${entryPoint} with ${config}: still running after ${RUN_TIMEOUT_MS / 1000} seconds. The entry point does not start its process through 'defineClientInstance'`
      );
    } else if (run.status !== 0) {
      failures.push(`${entryPoint} with ${config}: stopped, see its message above`);
    } else if (!run.stdout.includes(RESOLVE_ONLY_MARKER)) {
      failures.push(
        `${entryPoint} with ${config}: ended with code 0 and resolved nothing. The entry point does not start its process through 'defineClientInstance'`
      );
    } else {
      console.log(`resolved ${entryPoint} with ${config}`);
    }
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`check-release: ${failure}`);
  process.exit(1);
}
