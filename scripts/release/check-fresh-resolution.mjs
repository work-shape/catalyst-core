#!/usr/bin/env node
// Build the reference assembly as a deployment consuming this release's tarballs. Only
// Catalyst dependencies are substituted; third-party ranges resolve without core's lock or
// overrides. The hosted job supplies an isolated test Postgres for the signed-in smoke.
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
import { freePort, smokeConsumer, step } from "./fresh-consumer-smoke.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runCommand = (command, args, options) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

export async function checkFreshResolution(
  root = repoRoot,
  run = runCommand,
  smoke = smokeConsumer,
  proveAuthDrift = false
) {
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

    await step("Fresh install: no core lockfile, workspace links or third-party overrides", () =>
      run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: consumer })
    );
    await step("Require one host React for chat-ui and ui", () =>
      run(
        process.execPath,
        [resolve(repoRoot, "scripts/release/check-react-peers.mjs"), consumer],
        {
          cwd: consumer
        }
      )
    );
    await step("Require core's tested chat runtime versions", () =>
      run(
        process.execPath,
        [resolve(repoRoot, "scripts/release/check-runtime-pins.mjs"), consumer, root],
        { cwd: consumer }
      )
    );
    // The UI is built against the port the smoke's server will listen on, as a deployment
    // builds against its API's address.
    const apiPort = await freePort();
    for (const target of ["server", "ui"]) {
      await step(`Build deployment ${target} from installed release tarballs`, () =>
        run("pnpm", ["run", `build:${target}`], {
          cwd: consumer,
          env: { ...process.env, VITE_CHAT_API_URL: `http://127.0.0.1:${apiPort}` }
        })
      );
    }
    // The same artifacts required by catalyst-deploy check and the kit's Dockerfile.
    await step("Require the deployment build artifacts", () => {
      for (const artifact of ["dist/server.js", "dist/client/index.html"]) {
        const path = join(consumer, artifact);
        if (!existsSync(path) || statSync(path).size === 0) {
          throw new Error(`fresh-resolution: missing or empty build artifact: ${artifact}`);
        }
      }
    });
    await smoke(consumer, { apiPort });
    console.log(
      "\nfresh-resolution: builds, sign-in, authenticated /api/v1/me and composer typing passed"
    );

    if (proveAuthDrift) {
      // Reproduce the rc.1 deployment resolution through the same tarballs and HTTP probe.
      // A build failure is not proof: only the runtime's sign-in 500 satisfies the mutation.
      const path = join(consumer, "package.json");
      const mutated = JSON.parse(readFileSync(path, "utf8"));
      Object.assign(mutated.pnpm.overrides, { "better-auth": "1.7.10", zod: "4.4.3" });
      writeFileSync(path, `${JSON.stringify(mutated, null, 2)}\n`);
      run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], { cwd: consumer });
      run("pnpm", ["run", "build:server"], { cwd: consumer });
      try {
        await smoke(consumer, { apiPort });
      } catch (error) {
        if (error.message === "fresh-resolution: sign-in returned 500 (expected 200)") {
          console.log("fresh-resolution: rejected better-auth 1.7.10 + zod 4.4.3 at sign-in (500)");
          return;
        }
        throw error;
      }
      throw new Error("fresh-resolution: auth drift mutation unexpectedly passed");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkFreshResolution(
      repoRoot,
      runCommand,
      smokeConsumer,
      process.argv.includes("--prove-auth-drift")
    );
  } catch (error) {
    const failed = error?.step ?? "outside a named step";
    const message = (error?.message ?? String(error))
      .split("\n")[0]
      .replace(/^fresh-resolution: /u, "");
    console.error(`\nfresh-resolution: FAILED at "${failed}": ${message}`);
    // On a hosted runner the line is also an annotation on the run's summary page.
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=Fresh consumer gate failed at: ${failed}::${message}`);
    }
    process.exitCode = 1;
  }
}
