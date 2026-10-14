#!/usr/bin/env node
// Runs `pnpm check` in the current repository against a container of its own of the instance's
// Postgres image, the one docker/postgres/pinned-image names.
// The container gets a unique name and a free local port, and is removed when the check
// ends, fails or is interrupted.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connectionsForWorkers, defaultTestWorkers } from "./test-postgres-capacity.mjs";

const image = readFileSync(new URL("../docker/postgres/pinned-image", import.meta.url), "utf8")
  .split("\n")
  .find((line) => line.trim() !== "" && !line.startsWith("#"))
  ?.trim();
if (!image?.includes("@sha256:")) {
  process.stderr.write("docker/postgres/pinned-image names no image by digest.\n");
  process.exit(1);
}
const user = "catalyst";
const password = "local-check";
const database = "catalyst_test";
const name = `catalyst-check-${process.pid}-${randomBytes(4).toString("hex")}`;
// Room for every test file the suite runs side by side on this machine. Postgres's default of
// 100 is less than that on more than three cores, and the suite then failed at random with
// "too many clients already".
const maxConnections = connectionsForWorkers(defaultTestWorkers());

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
  image,
  "-c",
  `max_connections=${maxConnections}`
);
if (started.status !== 0) {
  remove();
  fail(`Docker could not start ${image}: ${started.stderr.trim()}`);
}

let check;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    if (check) {
      check.kill(signal);
      // A check that ignores the signal is ended after five seconds, so the container goes.
      setTimeout(() => check.kill("SIGKILL"), 5000).unref();
    } else {
      remove();
      process.exit(130);
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
check = spawn("pnpm", ["check"], {
  stdio: "inherit",
  env: {
    ...process.env,
    POSTGRES_STORE_TEST_DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`
  }
});
check.on("error", (error) => {
  remove();
  fail(`pnpm check could not start: ${error.message}`);
});
check.on("exit", (code) => {
  remove();
  process.exit(interrupted ? 130 : (code ?? 1));
});
