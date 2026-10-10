#!/usr/bin/env node
// Release gate for the publishable platform packages: build, pack, inspect every tarball,
// then install a minimal consumer set outside the workspace and import it.
// Publishes nothing and needs no registry credentials.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findMetadataDrift, listPackages, repoRoot, UNPUBLISHED } from "./package-metadata.mjs";

// Installed together in the scratch consumer. Their workspace dependencies come along.
const CONSUMER_SET = ["core", "config-schema", "api-contract", "api-client", "config-cli"];
// Installed next to them for its bin only; it has no module entry to import.
const DEPLOYMENT_KIT = "deployment-kit";
const MAX_TARBALL_BYTES = 300_000;
// chat-ui and ui ship src/ next to dist/ for Tailwind scanning. chat-server ships the pinned
// view runtime it serves, about 230 kB packed. postgres-store ships its migrations with one
// schema snapshot each, about 9 kB packed per migration.
const MAX_TARBALL_BYTES_BY_DIR = {
  "chat-ui": 1_000_000,
  ui: 500_000,
  "chat-server": 600_000,
  "postgres-store": 400_000
};
const FORBIDDEN_FILES = [
  [/\.map$/u, "source map"],
  [/\.(test|spec)\.[cm]?[jt]sx?$/u, "test file"],
  [/(^|\/)(__tests__|__fixtures__|fixtures|tests|node_modules)\//u, "test or dependency directory"],
  [/(^|\/)tsconfig[^/]*\.json$|\.tsbuildinfo$/u, "TypeScript project file"],
  [/(^|\/)\.env/u, "environment file"]
];

const skipBuild = process.argv.includes("--skip-build");
const problems = [];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

function step(title) {
  console.log(`\n==> ${title}`);
}

function exportTargets(exports) {
  if (typeof exports === "string") {
    return [exports];
  }
  return Object.values(exports ?? {}).flatMap(exportTargets);
}

function hasCondition(exports, condition) {
  if (typeof exports !== "object" || exports === null) {
    return false;
  }
  return Object.entries(exports).some(
    ([key, value]) => key === condition || hasCondition(value, condition)
  );
}

function inspectTarball(pkg, tarball, lockstepVersion, publishedNames) {
  const report = (message) => problems.push(`${pkg.dir}: ${message}`);
  const files = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//u, ""));
  const has = (target) => files.includes(target.replace(/^\.\//u, ""));
  const manifestText = run("tar", ["-xzOf", tarball, "package/package.json"]);
  const manifest = JSON.parse(manifestText);

  if (manifestText.includes("workspace:")) {
    report("packed manifest still contains a workspace: specifier");
  }
  if (Boolean(manifest.private) !== pkg.heldBack) {
    report(pkg.heldBack ? "held back but not marked private" : "packed manifest is private");
  }
  if (manifest.version !== lockstepVersion) {
    report(`version ${manifest.version} is not the lockstep version ${lockstepVersion}`);
  }
  if (!manifest.license) {
    report("license is missing");
  }
  if (manifest.publishConfig?.access !== "restricted") {
    report("publishConfig.access is not restricted");
  }
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (publishedNames.has(name) && range !== lockstepVersion) {
        report(`${section}.${name} is ${range}, expected exactly ${lockstepVersion}`);
      } else if (/^(file|link|portal):/u.test(range)) {
        report(`${section}.${name} uses a local specifier ${range}`);
      }
    }
  }

  if (hasCondition(manifest.exports, "development")) {
    report("packed exports keep the development condition");
  }
  const entryTargets = [
    manifest.main,
    manifest.types,
    ...Object.values(
      typeof manifest.bin === "string" ? { bin: manifest.bin } : (manifest.bin ?? {})
    ),
    ...exportTargets(manifest.exports)
  ].filter(Boolean);
  for (const target of new Set(entryTargets)) {
    if (!has(target)) {
      report(`entry ${target} is not in the tarball`);
    }
  }
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === "object" && !entry.types) {
      report(`export ${subpath} has no types`);
    }
  }
  if (!pkg.assetsOnly && !files.some((file) => /^dist\/.+\.js$/u.test(file))) {
    report("dist has no JavaScript");
  }
  if (!pkg.assetsOnly && !files.some((file) => /^dist\/.+\.d\.ts$/u.test(file))) {
    report("dist has no type declarations");
  }
  for (const declared of manifest.files ?? []) {
    if (!files.some((file) => file === declared || file.startsWith(`${declared}/`))) {
      report(`declared files entry "${declared}" is empty or missing`);
    }
  }
  for (const file of files) {
    const forbidden = FORBIDDEN_FILES.find(([pattern]) => pattern.test(file));
    if (forbidden) {
      report(`contains ${forbidden[1]}: ${file}`);
    }
  }

  const bytes = statSync(tarball).size;
  const limit = MAX_TARBALL_BYTES_BY_DIR[pkg.dir] ?? MAX_TARBALL_BYTES;
  if (bytes > limit) {
    report(`tarball is ${bytes} bytes, over the ${limit} byte limit`);
  }
  return { name: manifest.name, bytes, fileCount: files.length };
}

function checkConsumer(tarballs, workDir) {
  const consumerDir = join(workDir, "consumer");
  mkdirSync(consumerDir);
  const names = CONSUMER_SET.map((dir) => tarballs.get(dir).name);
  const kitName = tarballs.get(DEPLOYMENT_KIT).name;
  const fileSpecifiers = Object.fromEntries(
    [...tarballs.values()].map(({ name, tarball }) => [name, `file:${tarball}`])
  );

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "release-check-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          [...names, kitName].map((name) => [name, fileSpecifiers[name]])
        ),
        // Workspace dependencies of the consumer set resolve to the packed tarballs too,
        // so nothing has to exist on a registry yet.
        pnpm: { overrides: fileSpecifiers }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(consumerDir, "check.mjs"),
    [
      `const names = ${JSON.stringify(names)};`,
      "for (const name of names) {",
      "  const resolved = import.meta.resolve(name);",
      '  if (!resolved.includes("/node_modules/")) {',
      "    throw new Error(`${name} resolved outside node_modules: ${resolved}`);",
      "  }",
      "  const exported = Object.keys(await import(name));",
      "  if (exported.length === 0) {",
      "    throw new Error(`${name} has no exports`);",
      "  }",
      "  console.log(`${name}: ${exported.length} exports`);",
      "}",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(consumerDir, "check.ts"),
    `${names.map((name, index) => `import * as m${index} from "${name}";`).join("\n")}\n` +
      `export const modules = [${names.map((_, index) => `m${index}`).join(", ")}];\n`
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: []
        },
        files: ["check.ts"]
      },
      null,
      2
    )}\n`
  );

  const inConsumer = { cwd: consumerDir };
  run("pnpm", ["install", "--ignore-workspace", "--ignore-scripts", "--prefer-offline"], {
    ...inConsumer,
    stdio: ["ignore", "ignore", "inherit"]
  });
  process.stdout.write(run("node", ["check.mjs"], inConsumer));
  run("node", [resolve(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    ...inConsumer,
    stdio: "inherit"
  });
  console.log("types resolve under NodeNext");
  const help = run("pnpm", ["exec", "catalyst", "--help"], inConsumer);
  if (!help.includes("Usage: catalyst")) {
    throw new Error("the catalyst bin printed no usage when run from node_modules/.bin");
  }
  console.log("catalyst bin runs from node_modules/.bin");
  const deployHelp = run("pnpm", ["exec", "catalyst-deploy", "--help"], inConsumer);
  if (!deployHelp.includes("Usage: catalyst-deploy")) {
    throw new Error("the catalyst-deploy bin printed no usage when run from node_modules/.bin");
  }
  console.log("catalyst-deploy bin runs from node_modules/.bin");
}

const packages = listPackages();
const publishable = packages.filter((pkg) => pkg.publishable);

step("Package metadata");
const drifted = findMetadataDrift();
if (drifted.length > 0) {
  problems.push(`metadata out of date in ${drifted.join(", ")}; run pnpm release:metadata`);
}
for (const pkg of packages) {
  if (!pkg.publishable && pkg.dir !== "registry-canary" && pkg.manifest.private !== true) {
    problems.push(`${pkg.dir}: listed as unpublished but not marked private`);
  }
}
console.log(
  `${publishable.length} publishable, ${packages.length - publishable.length} not published`
);

if (!skipBuild) {
  step("Build");
  const exclusions = Object.keys(UNPUBLISHED).flatMap((dir) => ["--filter", `!./packages/${dir}`]);
  run("pnpm", ["-r", "--filter", "./packages/*", ...exclusions, "build"], {
    stdio: ["ignore", "ignore", "inherit"]
  });
}

const workDir = mkdtempSync(join(tmpdir(), "catalyst-release-check-"));
try {
  step("Pack and inspect");
  const lockstepVersion = publishable[0].manifest.version;
  const publishedNames = new Set(publishable.map((pkg) => pkg.manifest.name));
  const tarballs = new Map();
  for (const pkg of publishable) {
    const destination = join(workDir, "tarballs", pkg.dir);
    mkdirSync(destination, { recursive: true });
    run("pnpm", ["pack", "--pack-destination", destination], {
      cwd: pkg.root,
      stdio: ["ignore", "ignore", "inherit"]
    });
    const tarball = join(destination, readdirSync(destination)[0]);
    tarballs.set(pkg.dir, {
      tarball,
      ...inspectTarball(pkg, tarball, lockstepVersion, publishedNames)
    });
  }
  for (const { name, bytes, fileCount } of tarballs.values()) {
    const size = `${(bytes / 1024).toFixed(1)} kB`;
    console.log(`${name.padEnd(40)} ${size.padStart(10)} ${String(fileCount).padStart(5)} files`);
  }

  if (problems.length === 0) {
    step(`Scratch consumer in ${workDir}`);
    checkConsumer(tarballs, workDir);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\nrelease:check failed with ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log("\nrelease:check passed");
