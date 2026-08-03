#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

const { rootDir, serviceNames } = parseArguments(process.argv.slice(2));
const projectName = readComposeProjectName();
const activeContainers = readActiveContainers();
const watchProcesses = readComposeWatchProcesses();

if (watchProcesses.length === 0) {
  process.exit(0);
}

const processList = watchProcesses
  .map((entry) => `PID ${entry.pid}: ${entry.command}`)
  .join("\n");
const activeServices = activeContainers
  .map((entry) => entry.Service || entry.Name || entry.Names)
  .filter(Boolean)
  .join(", ");

if (activeContainers.length > 0) {
  console.warn(`[dev] Replacing existing docker compose watch for project "${projectName}".`);
  console.warn(processList);
  console.warn(
    `[dev] Active Compose services remain running: ${activeServices || activeContainers.length}.`
  );
} else {
  console.warn(`[dev] Removing stale docker compose watch process for project "${projectName}".`);
  console.warn(processList);
}

await terminateProcesses(watchProcesses);

function parseArguments(args) {
  let root = "";
  let services = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      root = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (argument === "--services") {
      services = args.slice(index + 1);
      break;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: compose-watch-preflight.mjs --root DIR [--services SERVICE ...]"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!root) {
    throw new Error("--root is required");
  }
  return { rootDir: realpathSync(resolve(root)), serviceNames: services };
}

function readComposeProjectName() {
  try {
    const parsed = JSON.parse(runDockerCompose(["config", "--format", "json"]));
    return parsed.name || basename(rootDir);
  } catch {
    return basename(rootDir);
  }
}

function readActiveContainers() {
  try {
    return parseDockerJson(runDockerCompose(["ps", "--format", "json"])).filter((entry) => {
      const state = String(entry.State || "").toLowerCase();
      return state !== "exited" && state !== "dead" && state !== "created";
    });
  } catch {
    return [];
  }
}

function runDockerCompose(args) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function parseDockerJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  return trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
}

function readComposeWatchProcesses() {
  const rows = readProcessRows();
  const currentProcessPids = collectCurrentProcessPids(rows);
  return rows.filter((row) => {
    if (currentProcessPids.has(row.pid) || !isComposeWatchCommand(row.command)) return false;
    return readProcessCwd(row.pid) === rootDir;
  });
}

function collectCurrentProcessPids(rows) {
  const currentProcessPids = new Set([process.pid]);
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  let cursorPid = process.pid;
  while (true) {
    const row = rowsByPid.get(cursorPid);
    if (!row || row.ppid <= 0 || currentProcessPids.has(row.ppid)) return currentProcessPids;
    currentProcessPids.add(row.ppid);
    cursorPid = row.ppid;
  }
}

function readProcessRows() {
  const raw = execFileSync(
    "ps",
    ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "command="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  return raw
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      stat: match[4],
      command: match[5]
    }));
}

function isComposeWatchCommand(command) {
  const commandParts = command.trim().split(/\s+/);
  if (!isComposeWatchInvocation(commandParts)) return false;
  return serviceNames.length === 0 || serviceNames.every((name) => commandParts.includes(name));
}

function isComposeWatchInvocation(commandParts) {
  const [executableName, firstArgument, secondArgument] = commandParts;
  const executable = basename(executableName || "");
  return (
    (executable === "docker" && firstArgument === "compose" && secondArgument === "watch") ||
    (executable === "docker-compose" && firstArgument === "compose" && secondArgument === "watch") ||
    (executable === "docker-compose" && firstArgument === "watch")
  );
}

function readProcessCwd(pid) {
  const procCwd = `/proc/${pid}/cwd`;
  try {
    if (existsSync(procCwd)) return realpathSync(procCwd);
  } catch {
    return null;
  }
  try {
    const raw = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const cwdLine = raw.split(/\r?\n/).find((line) => line.startsWith("n"));
    return cwdLine ? realpathSync(cwdLine.slice(1)) : null;
  } catch {
    return null;
  }
}

async function terminateProcesses(processes) {
  for (const entry of processes) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // It may already have exited after a sibling Compose process stopped.
    }
  }
  if (await waitForExit(processes.map((entry) => entry.pid), 3000)) return;
  for (const entry of processes) {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      // Nothing else to do if it exits between checks.
    }
  }
  if (!(await waitForExit(processes.map((entry) => entry.pid), 1000))) {
    throw new Error("Could not stop the existing docker compose watch process");
  }
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
