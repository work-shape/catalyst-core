#!/usr/bin/env node
// Build the reference assembly as a deployment consuming this release's tarballs. Only
// Catalyst dependencies are substituted; third-party ranges resolve without core's lock or
// overrides. No registry credentials, database, Docker engine or running server are needed.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localManifest, packPackages } from "../../packages/deployment-kit/lib/pack-local.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runCommand = (command, args, options) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

export function checkFreshResolution(root = repoRoot, run = runCommand) {
  const scratch = mkdtempSync(join(tmpdir(), "catalyst-fresh-resolution-"));
  try {
    const consumer = join(scratch, "consumer");
    const tarballsDir = join(consumer, ".local-packages");
    mkdirSync(consumer);
    // The hosted job already built from the frozen core lock. Reuse pack-local's exact
    // packing and substitution path, including overrides for transitive Catalyst packages.
    const tarballs = packPackages([root], tarballsDir, true);
    const demo = join(root, "clients/demo");
    for (const file of [
      "src",
      "tools",
      "widgets",
      "sample-mcp",
      "public",
      "index.html",
      "vite.config.ts"
    ]) {
      cpSync(join(demo, file), join(consumer, file), { recursive: true });
    }
    const manifest = JSON.parse(readFileSync(join(demo, "package.json"), "utf8"));
    const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(localManifest(manifest, tarballs, packageManager), null, 2)}\n`
    );
    // tsup reads the assembly's tsconfig too. Keep normal compiler settings, never the
    // development source aliases that could bypass the installed tarballs.
    const { compilerOptions } = JSON.parse(readFileSync(join(root, "tsconfig.base.json"), "utf8"));
    delete compilerOptions.paths;
    delete compilerOptions.baseUrl;
    writeFileSync(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions }, null, 2)}\n`
    );

    console.log("\n==> Fresh install: no core lockfile, workspace links or third-party overrides");
    run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: consumer });
    for (const target of ["server", "ui"]) {
      console.log(`\n==> Build deployment ${target} from installed release tarballs`);
      run("pnpm", ["run", `build:${target}`], { cwd: consumer });
    }
    // The same artifacts required by catalyst-deploy check and the kit's Dockerfile.
    for (const artifact of ["dist/server.js", "dist/client/index.html"]) {
      const path = join(consumer, artifact);
      if (!existsSync(path) || statSync(path).size === 0) {
        throw new Error(`fresh-resolution: missing or empty build artifact: ${artifact}`);
      }
    }
    console.log("\nfresh-resolution: server and UI built successfully");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkFreshResolution();
}
