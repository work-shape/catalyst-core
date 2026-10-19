#!/usr/bin/env node
// Runs the steps of `pnpm check` in the current repository against a container of its own of the
// instance's Postgres image, the one docker/postgres/pinned-image names, run as scripts/test-postgres-server.mjs
// says: in memory and without durability.
// The container gets a unique name and a free local port, and is removed when the check
// ends, fails or is interrupted.
//
// The steps are read from the `check` script, so both run the same checks. The first step, the
// build, runs alone: the type checks and the tests read what it builds. Every later step runs
// beside the others, so none of them may depend on another. A step that only chains other root
// scripts, as `typecheck` does, runs as those scripts. Each step's lines carry its name. A failed
// build ends the check; any other failure lets the remaining steps finish, and the output of
// every failed step is repeated at the end without the name before each line.
//
// The test suite runs beside steps that keep one or more cores busy (the lint runs three
// processes, the type checks and the format one each), so it gets the machine's cores less four,
// and never less than half of them. CATALYST_TEST_WORKERS sets another number.
// CHECK_LOCAL_SERIAL=1 runs the steps one after another with their own output, as `pnpm check`
// does, but still runs every step after a failure.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  connectionsForWorkers,
  defaultTestWorkers,
  machineTestWorkers
} from "./test-postgres-capacity.mjs";
import { testPostgresDockerOptions, testPostgresServerArguments } from "./test-postgres-server.mjs";

const image = readFileSync(new URL("../docker/postgres/pinned-image", import.meta.url), "utf8")
  .split("\n")
  .find((line) => line.trim() !== "" && !line.startsWith("#"))
  ?.trim();
if (!image?.includes("@sha256:")) {
  process.stderr.write("docker/postgres/pinned-image names no image by digest.\n");
  process.exit(1);
}

/** @type {Record<string, string>} */
const scripts = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).scripts;
/** @param {string} script */
const chain = (script) => script.split(" && ").map((step) => step.trim());
/** @param {string} step */
const rootScript = (step) => {
  const name = step.match(/^pnpm ([\w:-]+)$/u)?.[1];
  return name && name in scripts ? name : undefined;
};
/**
 * @param {string} name
 * @returns {string[]}
 */
const expand = (name) => {
  const inner = chain(scripts[name] ?? "").map(rootScript);
  return inner.every((step) => step !== undefined) ? inner.flatMap(expand) : [name];
};
const steps = chain(scripts.check ?? "").map((step) => {
  const name = rootScript(step);
  if (!name) {
    process.stderr.write(`check:local runs root scripts only; the check script has "${step}".\n`);
    process.exit(1);
  }
  return name;
});
const [first, ...rest] = steps;
const later = rest.flatMap(expand);

const serial = !["", "0", undefined].includes(process.env.CHECK_LOCAL_SERIAL);
const machine = machineTestWorkers();
const suiteWorkers =
  serial || process.env.CATALYST_TEST_WORKERS
    ? defaultTestWorkers()
    : Math.max(machine - 4, Math.ceil(machine / 2), 1);
// Beside the suite, `test:upgrade` runs its one test file on one worker.
/** @type {Record<string, number>} */
const workersOf = serial ? {} : { test: suiteWorkers, "test:upgrade": 1 };

const user = "catalyst";
const password = "local-check";
const database = "catalyst_test";
const name = `catalyst-check-${process.pid}-${randomBytes(4).toString("hex")}`;
// Room for every test file the suite runs side by side on this machine. Postgres's default of
// 100 is less than that on more than three cores, and the suite then failed at random with
// "too many clients already".
const maxConnections = connectionsForWorkers(
  Math.max(machine, defaultTestWorkers(), serial ? 0 : suiteWorkers + 1)
);

function docker(...args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (docker("version", "--format", "{{.Server.Version}}").status !== 0)
  fail(
    "pnpm check:local needs a running Docker to start its Postgres; start Docker, or set POSTGRES_STORE_TEST_DATABASE_URL yourself and run pnpm check."
  );

let removed = false;
function remove() {
  if (removed) return;
  removed = true;
  docker("rm", "--force", "--volumes", name);
}

const started = docker(
  "run",
  "--detach",
  "--name",
  name,
  "--env",
  `POSTGRES_USER=${user}`,
  "--env",
  `POSTGRES_PASSWORD=${password}`,
  "--env",
  `POSTGRES_DB=${database}`,
  // An empty host port lets Docker choose a free one.
  "--publish",
  "127.0.0.1::5432",
  ...testPostgresDockerOptions(),
  image,
  "-c",
  `max_connections=${maxConnections}`,
  ...testPostgresServerArguments()
);
if (started.status !== 0) {
  remove();
  fail(`Docker could not start ${image}: ${started.stderr.trim()}`);
}

/** @type {Set<import("node:child_process").ChildProcess>} */
const running = new Set();
let interrupted = false;
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(signal, () => {
    interrupted = true;
    if (running.size === 0) {
      remove();
      process.exit(130);
    }
    // Each step runs in a process group of its own, so the signal reaches every process it
    // started. A step that ignores the signal is ended after five seconds, so the container goes.
    for (const child of running) {
      const group = (/** @type {NodeJS.Signals} */ kill) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, kill);
        } catch {
          // The group has ended.
        }
      };
      group(signal);
      setTimeout(() => group("SIGKILL"), 5000).unref();
    }
  });
}
process.on("exit", remove);

const published = docker("port", name, "5432/tcp").stdout.trim().split("\n")[0] ?? "";
const port = published.slice(published.lastIndexOf(":") + 1);
if (!/^\d+$/u.test(port)) {
  remove();
  fail(`Docker did not publish a port for ${name}.`);
}

// The image restarts Postgres once while it initialises. Asking over TCP only succeeds on
// the final server, because the first one listens on the socket alone.
const deadline = Date.now() + 60_000;
const isReady = () =>
  docker(
    "exec",
    name,
    "pg_isready",
    "--host",
    "127.0.0.1",
    "--username",
    user,
    "--dbname",
    database
  ).status === 0;
while (!isReady()) {
  if (interrupted) process.exit(130);
  if (Date.now() > deadline) {
    remove();
    fail(`Postgres in ${name} was not ready after 60 seconds.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

process.stdout.write(
  `check:local: Postgres of ${image} in ${name} on 127.0.0.1:${port}, max_connections ${maxConnections}\n`
);

const env = {
  ...process.env,
  POSTGRES_STORE_TEST_DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,
  // Output that goes through a pipe stays coloured when this check writes to a terminal.
  ...(process.stdout.isTTY && !process.env.NO_COLOR && !process.env.FORCE_COLOR
    ? { FORCE_COLOR: "1" }
    : {})
};
const width = Math.max(...later.map((step) => step.length));
// The lines of a failed step repeated at the end. The suite's failures are in its last lines.
const kept = 2000;
/** @typedef {{ step: string, status: number, seconds: number, lines: string[], cut: boolean }} Result */

/**
 * Runs one root script. With `relay`, its lines carry its name and the last of them are kept.
 * @param {string} step
 * @param {boolean} relay
 * @returns {Promise<Result>}
 */
const run = (step, relay) =>
  new Promise((done) => {
    const start = Date.now();
    const workers = workersOf[step];
    const child = spawn("pnpm", [step], {
      detached: true,
      stdio: relay ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      env: workers ? { ...env, CATALYST_TEST_WORKERS: String(workers) } : env
    });
    running.add(child);
    /** @type {string[]} */
    const lines = [];
    let cut = false;
    const prefix = `[${step.padEnd(width)}] `;
    /** @type {Promise<void>[]} */
    const drained = [];
    for (const [stream, out] of /** @type {const} */ ([
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ])) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      let partial = "";
      /** @param {string} line */
      const emit = (line) => {
        out.write(`${prefix}${line}\n`);
        lines.push(line);
        if (lines.length > 2 * kept) {
          lines.splice(0, lines.length - kept);
          cut = true;
        }
      };
      stream.on("data", (/** @type {string} */ chunk) => {
        const parts = (partial + chunk).split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) emit(line);
      });
      drained.push(
        new Promise((ended) =>
          stream.on("close", () => {
            if (partial) emit(partial);
            ended();
          })
        )
      );
    }
    /** @param {number} status */
    const finish = async (status) => {
      await Promise.all(drained);
      running.delete(child);
      const seconds = Math.round((Date.now() - start) / 1000);
      if (relay)
        process.stdout.write(
          `${prefix}${status === 0 ? "passed" : `failed with exit code ${status}`} after ${seconds} s\n`
        );
      done({ step, status, seconds, lines: lines.slice(-kept), cut: cut || lines.length > kept });
    };
    child.on("error", (error) => {
      process.stderr.write(`${prefix}pnpm ${step} could not start: ${error.message}\n`);
      void finish(1);
    });
    child.on("exit", (code) => void finish(code ?? 1));
  });

const begun = Date.now();
/** @type {Result[]} */
const results = [];
results.push(await run(first, false));
if (results[0]?.status === 0 && !interrupted) {
  if (serial) {
    for (const step of later) {
      if (interrupted) break;
      results.push(await run(step, false));
    }
  } else {
    process.stdout.write(
      `check:local: ${later.length} steps side by side, the suite on ${suiteWorkers} workers: ${later.join(", ")}\n`
    );
    results.push(...(await Promise.all(later.map((step) => run(step, true)))));
  }
}

remove();
const failed = results.filter((result) => result.status !== 0);
for (const result of serial || interrupted ? [] : failed) {
  process.stdout.write(
    `\ncheck:local: ${result.cut ? `the last ${kept} lines` : "the output"} of ${result.step}, which failed:\n${result.lines.join("\n")}\n`
  );
}
const seconds = Math.round((Date.now() - begun) / 1000);
process.stdout.write(
  `\ncheck:local: ${results.length} of ${1 + later.length} steps ran in ${seconds} s${serial ? ", one after another" : ""}\n` +
    results
      .map(
        (result) =>
          `check:local:   ${result.status === 0 ? "passed" : "FAILED"}  ${result.step.padEnd(width)}  ${result.seconds} s\n`
      )
      .join("") +
    (interrupted
      ? "check:local: interrupted\n"
      : failed.length
        ? `check:local: failed: ${failed.map((result) => result.step).join(", ")}\n`
        : "")
);
// Setting the exit code instead of exiting lets the output reach a pipe completely.
process.exitCode = interrupted ? 130 : (failed[0]?.status ?? 0);
