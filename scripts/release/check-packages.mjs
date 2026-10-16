#!/usr/bin/env node
// Release gate for the publishable platform packages: build, pack, inspect every tarball,
// then install a minimal consumer set outside the workspace and import it.
// Publishes nothing and needs no registry credentials.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guard } from "./guard.mjs";
import { inspectPublicPackage, PUBLIC_TOOL_DIR } from "./check-public-tarball.mjs";
import { findMetadataDrift, listPackages, repoRoot, UNPUBLISHED } from "./package-metadata.mjs";

// Installed together in the scratch consumer. Their workspace dependencies come along.
const CONSUMER_SET = [
  "asset-schemas",
  "core",
  "config-schema",
  "api-contract",
  "api-client",
  "config-cli"
];
// Installed next to them for its bin only; it has no module entry to import.
const DEPLOYMENT_KIT = "deployment-kit";
const MAX_TARBALL_BYTES = 300_000; // check-limit
// ui ships src/ next to dist/ for Tailwind scanning; chat-ui scans dist/ and ships only its
// unbuilt stylesheet and Vite helpers beside it. server ships the pinned
// view runtime it serves, about 230 kB packed, its own code, about 150 kB packed, and every
// released App Kit version, about 385 kB packed each, most of it the chart engine; 1.3.0 is about
// 450 kB, because the library it bundles gained the flow canvas, and 1.4.0, which drops the
// kit's `connections.call`, about 485 kB. Five versions are released; the limit moved for the
// fifth and has room for none more. A version repeats the chart engine and
// React byte for byte, about 258 kB packed, so sharing those between versions is the way to
// stop the growth before the limit moves again. postgres-store ships its migrations with one
// schema snapshot each, about 9 kB packed per migration; 69 migrations are 620 kB, 82 are 814 kB
// (2026-10-14, the Knowledge Base migration).
// chat-ui dropped its duplicate TypeScript source on 2026-10-15; Tailwind scans the compiled
// components in published packages and the original source during workspace development. It
// packs to about 540 kB since; its limit went back to 650 kB on 2026-10-15 (Felix approved).
const MAX_TARBALL_BYTES_BY_DIR = {
  // First capability publication: 32 standalone helper command bundles plus shipped skills
  // pack to 5.9 MB (2026-10-16). Keep that existing build shape within a measured budget.
  "artifact-helpers": 6_500_000, // check-limit
  "chat-ui": 650_000, // check-limit
  // Packed site was 1.55 MB.
  docs: 2_000_000, // check-limit
  ui: 500_000, // check-limit
  // Raised on 2026-10-14 for App Kit 1.4.0 and the guardrail assets of EW-6a. Follow-up
  // KIT-SHARE-1: vendored App Kit versions share React and the chart engine; then lower the
  // limit again.
  server: 2_700_000, // check-limit
  "postgres-store": 850_000 // check-limit
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
  if (manifest.private) report("packed manifest is private");
  if (manifest.version !== lockstepVersion) {
    report(`version ${manifest.version} is not the lockstep version ${lockstepVersion}`);
  }
  if (manifest.license !== pkg.group.license) {
    report(`license is ${manifest.license}, expected ${pkg.group.license}`);
  }
  if (pkg.group.license === "MIT" && !has("LICENSE")) {
    report("MIT package ships no LICENSE file");
  }
  if (manifest.publishConfig?.access !== pkg.group.access) {
    report(`publishConfig.access is not ${pkg.group.access}`);
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
  const names = [
    ...CONSUMER_SET.map((dir) => tarballs.get(dir).name),
    ...[...tarballs.values()].filter((pkg) => pkg.companion).map((pkg) => pkg.name)
  ];
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

const rootIndex = process.argv.indexOf("--root");
const companionRoot = rootIndex === -1 ? undefined : resolve(process.argv[rootIndex + 1]);
guard([repoRoot, ...(companionRoot ? [companionRoot] : [])]);
run(process.execPath, ["--test", "scripts/release/release.test.mjs"], { stdio: "inherit" });
const packages = [
  ...listPackages(),
  ...(companionRoot ? listPackages(companionRoot).map((pkg) => ({ ...pkg, companion: true })) : [])
];
const publishable = packages.filter((pkg) => pkg.publishable);

step("Package metadata");
const drifted = [
  ...findMetadataDrift(),
  ...(companionRoot ? findMetadataDrift({ root: companionRoot }) : [])
];
if (drifted.length > 0) {
  problems.push(`metadata out of date in ${drifted.join(", ")}; run pnpm release:metadata`);
}
for (const pkg of packages) {
  if (!pkg.publishable && pkg.manifest.private !== true) {
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
  if (companionRoot)
    run("pnpm", ["build"], { cwd: companionRoot, stdio: ["ignore", "ignore", "inherit"] });
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
      companion: pkg.companion,
      ...inspectTarball(pkg, tarball, lockstepVersion, publishedNames)
    });
  }
  for (const { name, bytes, fileCount } of tarballs.values()) {
    const size = `${(bytes / 1024).toFixed(1)} kB`;
    console.log(`${name.padEnd(40)} ${size.padStart(10)} ${String(fileCount).padStart(5)} files`);
  }

  step("Public tool tarball");
  const unpacked = join(workDir, "public-tool");
  mkdirSync(unpacked);
  run("tar", ["-xzf", tarballs.get(PUBLIC_TOOL_DIR).tarball, "-C", unpacked]);
  const publicProblems = inspectPublicPackage(join(unpacked, "package"));
  problems.push(...publicProblems.map((problem) => `${PUBLIC_TOOL_DIR}: ${problem}`));
  console.log(
    publicProblems.length === 0
      ? "third-party dependencies only, public source only, licence present, no credential"
      : `${publicProblems.length} problem(s)`
  );

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
