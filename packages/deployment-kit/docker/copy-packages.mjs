#!/usr/bin/env node
// Copies installed packages out of a pnpm install, each with exactly the packages it depends
// on, directly or through another. docker/deployment.Dockerfile builds the runner and the
// document worker images from these copies, so neither carries the rest of the deployment's
// install. The versions are the ones the deployment's lockfile pinned.
//
//   node copy-packages.mjs --from DIR --to DIR [--commands FILE] NAME...
//
// --from is the folder whose node_modules holds the install, --to receives node_modules with
// the packages under their names. --commands writes one line per command the named packages
// declare as a bin: the command, a tab, the file it runs.
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`copy-packages: ${message}`);
  process.exit(1);
}

// The package names in a node_modules folder, scoped ones as @scope/name.
function packageNames(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => !entry.startsWith("."))
    .flatMap((entry) =>
      entry.startsWith("@")
        ? readdirSync(join(directory, entry)).map((name) => `${entry}/${name}`)
        : [entry]
    );
}

function isPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// In pnpm's store, node_modules/.pnpm/<key>/node_modules/<name> is the package itself and
// every other entry beside it is a link to a package it depends on.
function storeKey(store, name) {
  const keys = readdirSync(store).filter(
    (key) => key !== "node_modules" && isDirectory(join(store, key, "node_modules", name))
  );
  if (keys.length !== 1) {
    throw new Error(
      keys.length === 0
        ? `${name} is not installed in ${store}`
        : `${name} is installed more than once: ${keys.join(", ")}`
    );
  }
  return keys[0];
}

function dependencyKeys(store, key) {
  const directory = join(store, key, "node_modules");
  return packageNames(directory)
    .filter((name) => lstatSync(join(directory, name)).isSymbolicLink())
    .map((name) => {
      const target = realpathSync(join(directory, name));
      const path = relative(realpathSync(store), target);
      if (path.startsWith("..")) {
        throw new Error(`${name}, a dependency in ${key}, links outside the install: ${target}`);
      }
      return path.split(sep)[0];
    });
}

export function copyPackages({ from, to, names }) {
  const store = join(from, "node_modules", ".pnpm");
  if (!isDirectory(store)) throw new Error(`${from} has no pnpm install (node_modules/.pnpm)`);
  const roots = names.map((name) => ({ name, key: storeKey(store, name) }));
  const keys = new Set();
  const pending = roots.map(({ key }) => key);
  while (pending.length > 0) {
    const key = pending.pop();
    if (keys.has(key)) continue;
    keys.add(key);
    pending.push(...dependencyKeys(store, key));
  }

  const target = join(to, "node_modules", ".pnpm");
  mkdirSync(target, { recursive: true });
  for (const key of keys) {
    // The links inside the store are relative, so they hold in the copy as they are.
    cpSync(join(store, key), join(target, key), { recursive: true, verbatimSymlinks: true });
  }
  // pnpm also links every package of the store into .pnpm/node_modules, where Node finds a
  // dependency a package uses without declaring it. The copy does the same for its packages.
  const hoisted = join(target, "node_modules");
  for (const key of keys) {
    const directory = join(target, key, "node_modules");
    for (const name of packageNames(directory)) {
      const link = join(hoisted, name);
      if (isPresent(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      const source = realpathSync(join(directory, name));
      symlinkSync(relative(realpathSync(dirname(link)), source), link);
    }
  }

  const commands = [];
  for (const { name, key } of roots) {
    const link = join(to, "node_modules", name);
    const packageDir = join(target, key, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), packageDir), link);
    const { bin } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const declared = typeof bin === "string" ? { [basename(name)]: bin } : (bin ?? {});
    for (const [command, file] of Object.entries(declared)) {
      const path = join(packageDir, file);
      chmodSync(path, 0o755);
      commands.push([command, path]);
    }
  }
  return { packageCount: keys.size, commands };
}

// Node runs the real file of a linked script, as under node_modules, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { names: [] };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--from" || arg === "--to" || arg === "--commands") {
      const value = args.shift();
      if (!value) fail(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      fail(`unknown argument: ${arg}`);
    } else {
      options.names.push(arg);
    }
  }
  if (!options.from || !options.to || options.names.length === 0) {
    fail("usage: copy-packages.mjs --from DIR --to DIR [--commands FILE] NAME...");
  }
  try {
    const { packageCount, commands } = copyPackages(options);
    if (options.commands) {
      writeFileSync(
        options.commands,
        commands.map(([command, path]) => `${command}\t${path}\n`).join("")
      );
    }
    console.log(
      `copy-packages: ${options.names.join(", ")}: ${packageCount} packages to ${options.to}, ` +
        `${commands.length} commands`
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
