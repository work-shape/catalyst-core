#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const rootDir = realpathSync(resolve(options.root));
const statePath = resolve(rootDir, options.state);
const fingerprint = fingerprintInputs();
const previousFingerprint = readPreviousFingerprint();
const missingServices = options.services.filter((service) => !hasServiceImage(service));

if (!options.force && previousFingerprint === fingerprint && missingServices.length === 0) {
  console.log("[dev] Compose development images are current.");
  process.exit(0);
}

const reason = options.force
  ? "explicit rebuild requested"
  : missingServices.length > 0
    ? `missing image for ${missingServices.join(", ")}`
    : "image inputs changed";
console.log(`[dev] Building Compose development images (${reason}).`);
runDockerCompose(["build", ...options.services], "inherit");
writeState();

function parseArguments(args) {
  const parsed = {
    root: "",
    state: ".cache/compose-dev-images.json",
    services: [],
    inputs: [],
    packageRoots: [],
    force: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root" || argument === "--state") {
      parsed[argument.slice(2)] = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (argument === "--services" || argument === "--inputs" || argument === "--package-roots") {
      const key = argument === "--package-roots" ? "packageRoots" : argument.slice(2);
      while (args[index + 1] && !args[index + 1].startsWith("--")) {
        parsed[key].push(args[index + 1]);
        index += 1;
      }
      continue;
    }
    if (argument === "--force") {
      parsed.force = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: ensure-compose-dev-images.mjs --root DIR --services SERVICE ... --inputs PATH ... [--package-roots DIR ...] [--state FILE] [--force]"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.root) throw new Error("--root is required");
  if (parsed.services.length === 0) throw new Error("--services requires at least one service");
  if (parsed.inputs.length === 0 && parsed.packageRoots.length === 0) {
    throw new Error("At least one --inputs or --package-roots path is required");
  }
  return parsed;
}

function fingerprintInputs() {
  const paths = new Set();
  for (const input of options.inputs) collectFiles(resolve(rootDir, input), paths);
  for (const packageRoot of options.packageRoots) {
    collectPackageManifests(resolve(rootDir, packageRoot), paths);
  }
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(relative(rootDir, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectFiles(path, paths) {
  const stat = lstatSync(path);
  if (stat.isFile()) {
    paths.add(path);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported image input: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (shouldIgnoreDirectory(entry)) continue;
    collectFiles(resolve(path, entry.name), paths);
  }
}

function collectPackageManifests(path, paths) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry)) collectPackageManifests(resolve(path, entry.name), paths);
    } else if (entry.isFile() && entry.name === "package.json") {
      paths.add(resolve(path, entry.name));
    }
  }
}

function shouldIgnoreDirectory(entry) {
  return (
    entry.isDirectory() && [".cache", ".git", ".venv", "dist", "node_modules"].includes(entry.name)
  );
}

function readPreviousFingerprint() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state.version === 1 ? state.fingerprint : null;
  } catch {
    return null;
  }
}

function hasServiceImage(service) {
  try {
    const image = runDockerCompose(["config", "--images", service], "pipe")
      .trim()
      .split(/\r?\n/, 1)[0];
    if (!image) return false;
    execFileSync("docker", ["image", "inspect", image], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function runDockerCompose(args, output) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "ignore"]
  });
}

function writeState() {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(
      {
        version: 1,
        fingerprint,
        services: options.services,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
  renameSync(temporaryPath, statePath);
}
