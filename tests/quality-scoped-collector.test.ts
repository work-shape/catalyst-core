import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const quality = fileURLToPath(new URL("../packages/quality-config", import.meta.url));
const { NODE_PATH: _hoisted, ...env } = process.env;
let directory = "";
function write(path: string, value: unknown) {
  writeFileSync(join(directory, path), JSON.stringify(value));
}
function collect(target: string) {
  return spawnSync(
    process.execPath,
    [join(quality, "check.mjs"), target, `--scope-file=${join(directory, "scopes.json")}`],
    { cwd: directory, env, encoding: "utf8" }
  );
}

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-quality-scope-")));
  mkdirSync(join(directory, "node_modules/@work-shape"), { recursive: true });
  symlinkSync(quality, join(directory, "node_modules/@work-shape/catalyst-quality-config"), "dir");
  write("package.json", { name: "fixture", private: true, workspaces: ["packages/*"] });
  write("knip.json", {
    workspaces: {
      "packages/*": { entry: ["src/index.ts"], project: ["src/*.ts"], ignoreBinaries: ["tsc"] }
    }
  });
  write("quality-package-graph.json", { alpha: [], beta: [] });
  write("tsconfig.lint.json", {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: []
    },
    include: ["packages"]
  });
  writeFileSync(
    join(directory, "eslint.config.mjs"),
    'export { default } from "@work-shape/catalyst-quality-config";\n'
  );
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(directory, `packages/${name}/src`), { recursive: true });
    write(`packages/${name}/package.json`, {
      name,
      type: "module",
      main: "./src/index.ts",
      scripts: { typecheck: "tsc -p tsconfig.json" }
    });
    write(`packages/${name}/tsconfig.json`, {
      extends: "../../tsconfig.lint.json",
      include: ["src"]
    });
    writeFileSync(
      join(directory, `packages/${name}/src/index.ts`),
      "export const value: string = 1;\nconsole.log(value);\n"
    );
  }
  write("scopes.json", ["packages/alpha"]);
  write("quality-baseline.json", {
    version: 1,
    entries: [
      {
        target: "lint",
        rule: "catalyst/console-boundary",
        scope: "packages/alpha",
        count: 1,
        owner: "fixture"
      },
      {
        target: "lint",
        rule: "catalyst/console-boundary",
        scope: "packages/beta",
        count: 99,
        owner: "fixture"
      },
      {
        target: "types:packages",
        rule: "typescript/package-errors",
        scope: "packages/alpha",
        count: 1,
        owner: "fixture"
      },
      {
        target: "types:packages",
        rule: "typescript/package-errors",
        scope: "packages/beta",
        count: 99,
        owner: "fixture"
      }
    ]
  });
  expect(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status).toBe(0);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("compares exact compiler counts only for selected package scopes", () => {
  const result = collect("types:packages");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("retains selected lint findings and baseline counts across child processes", () => {
  const initial = collect("lint");
  expect(initial.stderr).toBe("");
  expect(initial.status).toBe(0);
  writeFileSync(
    join(directory, "packages/alpha/src/index.ts"),
    "export const value: string = 1;\nconsole.log(value);\nconsole.log(value);\n"
  );
  const result = collect("lint");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("packages/alpha: measured 2, baseline 1; repair the increase");
  expect(result.stderr).not.toContain("packages/beta");
});
