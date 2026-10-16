import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { checkFreshResolution } from "./check-fresh-resolution.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fresh-resolution-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", { private: true, packageManager: "pnpm@10.29.3" });
  write("packages/core/package.json", {
    name: "@work-shape/catalyst-core",
    version: "0.8.0",
    files: ["index.js"]
  });
  write("packages/core/index.js", "export const value = 1;\n");
  write("pnpm-lock.yaml", "poison: core-lock\n");
  write("pnpm-workspace.yaml", "overrides:\n  zod: 4.4.3\n");
  write("tsconfig.base.json", {
    compilerOptions: { strict: true, paths: { hidden: ["packages/core/index.js"] }, baseUrl: "." }
  });
  for (const dir of ["src", "tools", "widgets", "sample-mcp", "public"])
    write(`clients/demo/${dir}/example.ts`, "export {};\n");
  write("clients/demo/index.html", "<html></html>\n");
  write("clients/demo/vite.config.ts", "export default {};\n");
  write("clients/demo/pnpm-lock.yaml", "poison: consumer-lock\n");
  write("clients/demo/package.json", {
    name: "test-consumer",
    dependencies: { "@work-shape/catalyst-core": "workspace:*", zod: "^4.4.3" },
    scripts: { "build:server": "tsup src/server.ts", "build:ui": "vite build" }
  });
  return root;
}

const artifact = (cwd, path) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), "built\n");
};

test("packs the local release and installs a lock-free consumer before both deployment builds", async (t) => {
  const root = fixture(t);
  const calls = [];
  let consumer;
  await checkFreshResolution(
    root,
    (command, args, { cwd }) => {
      consumer = cwd;
      calls.push([command, ...args]);
      if (args[0] === "install") {
        assert.equal(existsSync(join(cwd, "pnpm-lock.yaml")), false);
        assert.equal(existsSync(join(cwd, "pnpm-workspace.yaml")), false);
        assert.equal(existsSync(join(cwd, ".npmrc")), false);
        assert.equal(existsSync(join(cwd, "node_modules")), false);
        const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
        assert.equal(manifest.dependencies.zod, "^4.4.3");
        assert.deepEqual(Object.keys(manifest.pnpm.overrides), ["@work-shape/catalyst-core"]);
        const specifier = manifest.dependencies["@work-shape/catalyst-core"];
        assert.match(specifier, /^file:\.local-packages\/.+\.tgz$/u);
        assert.equal(existsSync(join(cwd, specifier.slice(5))), true);
        assert.deepEqual(JSON.parse(readFileSync(join(cwd, "tsconfig.json"), "utf8")), {
          compilerOptions: { strict: true }
        });
        assert.equal(readFileSync(join(cwd, "src/example.ts"), "utf8"), "export {};\n");
      }
      if (args[1] === "build:server") artifact(cwd, "dist/server.js");
      if (args[1] === "build:ui") artifact(cwd, "dist/client/index.html");
    },
    async () => {
      calls.push(["smoke"]);
    }
  );
  assert.deepEqual(calls, [
    ["pnpm", "install", "--ignore-workspace", "--no-frozen-lockfile"],
    ["pnpm", "run", "build:server"],
    ["pnpm", "run", "build:ui"],
    ["smoke"]
  ]);
  assert.equal(existsSync(consumer), false, "scratch consumer is removed");
});

test("install and either build failure fail the gate and clean up", async (t) => {
  const root = fixture(t);
  for (const failure of ["install", "build:server", "build:ui"]) {
    let consumer;
    await assert.rejects(
      () =>
        checkFreshResolution(
          root,
          (_command, args, { cwd }) => {
            consumer = cwd;
            if (args.includes(failure)) throw new Error(`broken ${failure}`);
          },
          async () => {}
        ),
      new RegExp(`broken ${failure}`, "u")
    );
    assert.equal(existsSync(consumer), false);
  }
});

test("a successful command without either required artifact still fails the gate", async (t) => {
  const root = fixture(t);
  for (const missing of ["dist/server.js", "dist/client/index.html"]) {
    await assert.rejects(
      () =>
        checkFreshResolution(
          root,
          (_command, args, { cwd }) => {
            if (args[1] === "build:ui") {
              for (const path of ["dist/server.js", "dist/client/index.html"]) {
                if (path !== missing) artifact(cwd, path);
              }
            }
          },
          async () => {}
        ),
      new RegExp(`missing or empty build artifact: ${missing.replaceAll(".", "\\.")}`, "u")
    );
  }
});

test("a runtime smoke failure fails the gate and removes the built consumer", async (t) => {
  const root = fixture(t);
  let consumer;
  await assert.rejects(
    checkFreshResolution(
      root,
      (_command, args, { cwd }) => {
        consumer = cwd;
        if (args[1] === "build:server") artifact(cwd, "dist/server.js");
        if (args[1] === "build:ui") artifact(cwd, "dist/client/index.html");
      },
      async () => {
        throw new Error("sign-in returned 500");
      }
    ),
    /sign-in returned 500/u
  );
  assert.equal(existsSync(consumer), false);
});

test("auth drift proof requires a good smoke first and the overridden runtime's sign-in 500", async (t) => {
  const root = fixture(t);
  for (const outcome of ["500", "startup failure", "unexpected success"]) {
    let probes = 0;
    let installs = 0;
    const proof = checkFreshResolution(
      root,
      (_command, args, { cwd }) => {
        if (args[0] === "install" && ++installs === 2) {
          const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
          assert.equal(manifest.pnpm.overrides["better-auth"], "1.7.10");
          assert.equal(manifest.pnpm.overrides.zod, "4.4.3");
        }
        if (args[1] === "build:server") artifact(cwd, "dist/server.js");
        if (args[1] === "build:ui") artifact(cwd, "dist/client/index.html");
      },
      async () => {
        if (++probes === 1) return;
        if (outcome === "500")
          throw new Error("fresh-resolution: sign-in returned 500 (expected 200)");
        if (outcome === "startup failure") throw new Error("startup failure");
      },
      true
    );
    if (outcome === "500") await proof;
    else
      await assert.rejects(
        proof,
        outcome === "startup failure" ? /startup failure/u : /unexpectedly passed/u
      );
    assert.equal(probes, 2);
    assert.equal(installs, 2);
  }
});

test("release publication waits for fresh resolution; dispatch only proves the gate", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")
  );
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.jobs.release.needs, "fresh-resolution");
  assert.equal(
    workflow.jobs.release.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
  );
  assert.match(
    workflow.concurrency.group,
    /github\.event_name == 'workflow_dispatch'.*github\.run_id/u
  );
  const gate = workflow.jobs["fresh-resolution"];
  assert.equal(gate.if, undefined, "gate runs on tags and dispatches");
  assert.ok(
    gate.steps.some(({ run }) => run === "node scripts/release/check-fresh-resolution.mjs")
  );
  assert.ok(
    gate.steps.some(
      ({ run }) =>
        run === ".github/scripts/start-postgres.sh catalyst local-check catalyst_test 5432"
    )
  );
  assert.ok(
    gate.steps.some(
      ({ run, if: condition }) =>
        run === "node scripts/release/check-fresh-resolution.mjs --prove-auth-drift" &&
        condition === "github.event_name == 'workflow_dispatch'"
    )
  );
  assert.equal(JSON.stringify(gate).includes("secrets."), false);
});
