#!/usr/bin/env node
// Release gate for the public command line tool, the one package anyone may install.
//
// It packs the tool and reads every file of the tarball. The tarball must stand on its own:
// third-party dependencies only, source from the public packages only, a licence file, and
// nothing that looks like a credential. Then it installs the tarball with npm in an empty
// directory, without overrides, and runs the bin.
//
//   node scripts/release/check-public-tarball.mjs              build, pack, inspect, install
//   node scripts/release/check-public-tarball.mjs --skip-build pack what is built
//   node scripts/release/check-public-tarball.mjs --no-install inspect only, no network
//   node scripts/release/check-public-tarball.mjs --dir <dir>  inspect an unpacked package
//
// Publishes nothing and needs no registry credentials.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./package-metadata.mjs";

/** The folder under packages/ of the public tool. */
export const PUBLIC_TOOL_DIR = "config-cli";
/**
 * The package folders whose source may be bundled into the public tool. The same three are
 * named in packages/config-cli/tsup.config.ts.
 */
export const BUNDLED_SOURCE_DIRS = ["asset-schemas", "api-contract", "api-client"];
/** Package scopes of this workspace. No file of the tarball may import from one. */
const WORKSPACE_SCOPES = [["@vivd", "catalyst/"].join("-"), "@work-shape/"];
/** What the tarball may hold besides package.json. */
const ALLOWED_FILES = /^(?:dist\/.+|skills\/[a-z0-9-]+\/SKILL\.md|LICENSE|README\.md)$/u;
const TEXT_FILES = /\.(?:[cm]?js|d\.[cm]?ts|json|md)$|^LICENSE$/u;

/** A secret would have one of these shapes. Each is a name and a pattern. */
const CREDENTIAL_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["instance API key", /\bcat\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{24,}/u],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/u],
  ["model provider key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/u],
  ["registry auth line", /_authToken\s*=/u],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u]
];
/** A file of one of these names holds secrets by its purpose. */
const CREDENTIAL_FILES =
  /(?:^|\/)(?:\.env[^/]*|\.npmrc|credentials\.json|[^/]+\.(?:pem|key|p12))$/u;

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(root, path)
      : [relative(root, path).split(sep).join("/")];
  });
}

/** The module specifiers a JavaScript or declaration file imports. */
function importSpecifiers(text) {
  const patterns = [
    /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Reads an unpacked package and returns what is wrong with it as sentences. An empty list
 * means the package may be published.
 */
export function inspectPublicPackage(root) {
  const problems = [];
  const files = listFiles(root);
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    return ["package.json is missing"];
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);

  if (manifest.private) problems.push("the manifest is marked private");
  if (manifest.license !== "MIT") problems.push(`the licence is ${manifest.license}, not MIT`);
  if (manifest.publishConfig?.access !== "public") {
    problems.push("publishConfig.access is not public");
  }
  if (manifestText.includes("workspace:")) {
    problems.push("the manifest contains a workspace: specifier");
  }
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies
  };
  for (const [name, range] of Object.entries(dependencies)) {
    if (WORKSPACE_SCOPES.some((scope) => name.startsWith(scope))) {
      problems.push(`the manifest depends on the workspace package ${name}`);
    } else if (/^(?:file|link|portal|workspace):/u.test(range)) {
      problems.push(`the dependency ${name} uses the local specifier ${range}`);
    }
  }
  if (manifest.bundledDependencies ?? manifest.bundleDependencies) {
    problems.push("the manifest bundles dependencies; node_modules must not be packed");
  }

  if (!files.includes("LICENSE")) {
    problems.push("the LICENSE file is missing");
  } else if (!readFileSync(join(root, "LICENSE"), "utf8").includes("MIT License")) {
    problems.push("the LICENSE file is not the MIT licence");
  }

  for (const file of files) {
    if (file === "package.json") continue;
    if (CREDENTIAL_FILES.test(file)) {
      problems.push(`${file}: a file of this name holds credentials`);
      continue;
    }
    if (!ALLOWED_FILES.test(file)) {
      problems.push(`${file}: only dist/, skills/, LICENSE and README.md are published`);
      continue;
    }
    if (!TEXT_FILES.test(file)) {
      problems.push(`${file}: not a text file this check can read`);
    }
  }

  const declared = new Set(Object.keys(dependencies));
  const builtins = new Set(builtinModules);
  for (const file of files.filter((path) => TEXT_FILES.test(path))) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [name, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) problems.push(`${file}: contains what looks like this: ${name}`);
    }
    for (const dir of privatePackageDirs()) {
      if (text.includes(`packages/${dir}/`)) {
        problems.push(`${file}: names a path of the private package ${dir}`);
      }
    }
    if (!/\.(?:[cm]?js|d\.[cm]?ts)$/u.test(file)) continue;

    // The bundler writes the source path of every module it bundled as a comment of its own.
    for (const [, modulePath] of text.matchAll(/^\/\/ (\S+\.[cm]?[jt]sx?)$/gmu)) {
      const fromPackage = posix.normalize(posix.join("packages", PUBLIC_TOOL_DIR, modulePath));
      const allowed = [PUBLIC_TOOL_DIR, ...BUNDLED_SOURCE_DIRS].some((dir) =>
        fromPackage.startsWith(`packages/${dir}/src/`)
      );
      if (!allowed) {
        problems.push(`${file}: bundles ${modulePath}, which is outside the public packages`);
      }
    }
    for (const specifier of new Set(importSpecifiers(text))) {
      if (specifier.startsWith(".")) continue;
      if (specifier.startsWith("node:") || builtins.has(packageNameOf(specifier))) continue;
      if (WORKSPACE_SCOPES.some((scope) => specifier.startsWith(scope))) {
        problems.push(`${file}: imports the workspace package ${specifier}`);
      } else if (!declared.has(packageNameOf(specifier))) {
        problems.push(`${file}: imports ${specifier}, which the manifest does not declare`);
      }
    }
  }
  return [...new Set(problems)];
}

/** Every package folder of the workspace that is not public source. */
function privatePackageDirs() {
  const packagesRoot = resolve(repoRoot, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => dir !== PUBLIC_TOOL_DIR && !BUNDLED_SOURCE_DIRS.includes(dir));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

/** Packs the public tool into `workDir` and returns the tarball and its unpacked folder. */
export function packPublicTool(workDir) {
  const destination = join(workDir, "tarball");
  mkdirSync(destination, { recursive: true });
  run("pnpm", ["pack", "--pack-destination", destination], {
    cwd: resolve(repoRoot, "packages", PUBLIC_TOOL_DIR),
    stdio: ["ignore", "ignore", "inherit"]
  });
  const tarball = join(destination, readdirSync(destination)[0]);
  const unpacked = join(workDir, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", tarball, "-C", unpacked]);
  return { tarball, root: join(unpacked, "package") };
}

/**
 * Installs the tarball with npm in an empty directory outside the workspace, with no
 * overrides and no registry credentials, and runs the bin. Returns what is wrong.
 */
export function checkInstall(tarball, workDir, toolName) {
  const problems = [];
  const consumer = join(workDir, "install");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    '{ "name": "public-tool-check", "private": true }\n'
  );
  // An empty user configuration: the install reads no token and no registry of this machine.
  const userConfig = join(workDir, "empty.npmrc");
  writeFileSync(userConfig, "");
  const env = { ...process.env, npm_config_userconfig: userConfig };
  for (const name of Object.keys(env)) {
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN)$/iu.test(name)) delete env[name];
  }
  const inConsumer = { cwd: consumer, env };
  run("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], {
    ...inConsumer,
    stdio: ["ignore", "ignore", "inherit"]
  });
  const tree = run("npm", ["ls", "--all", "--parseable", "--long"], inConsumer);
  const workspacePackages = tree
    .split("\n")
    .map((line) => line.split(":")[1] ?? "")
    .filter(
      (id) =>
        !id.startsWith(`${toolName}@`) && WORKSPACE_SCOPES.some((scope) => id.startsWith(scope))
    );
  for (const id of workspacePackages) {
    problems.push(`the install pulled in the workspace package ${id}`);
  }
  const help = run("npx", ["--no-install", "catalyst", "--help"], inConsumer);
  if (!help.includes("Usage: catalyst")) {
    problems.push("the catalyst bin printed no usage after an npm install");
  }
  return problems;
}

function main(argv) {
  const dirIndex = argv.indexOf("--dir");
  if (dirIndex !== -1) {
    const dir = argv[dirIndex + 1];
    if (!dir) {
      console.error("--dir needs the folder of an unpacked package");
      return 2;
    }
    return report(inspectPublicPackage(resolve(dir)));
  }
  if (!argv.includes("--skip-build")) {
    run("pnpm", ["--filter", `./packages/${PUBLIC_TOOL_DIR}...`, "build"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "inherit"]
    });
  }
  const workDir = mkdtempSync(join(tmpdir(), "catalyst-public-tarball-"));
  try {
    const { tarball, root } = packPublicTool(workDir);
    const problems = inspectPublicPackage(root);
    if (problems.length === 0 && !argv.includes("--no-install")) {
      const { name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      problems.push(...checkInstall(tarball, workDir, name));
    }
    return report(problems);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function report(problems) {
  if (problems.length > 0) {
    console.error(`check-public-tarball failed with ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("check-public-tarball passed");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
