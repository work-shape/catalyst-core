import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceAliases, syncSourcePaths } from "@work-shape/catalyst-quality-config/source-aliases";
import { publishedExports } from "../scripts/release/package-metadata.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
function fixture(files: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "catalyst-aliases-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("derives development and direct source exports with subpaths before package prefixes", () => {
  const root = fixture({
    "packages/ui/package.json": {
      name: "@work-shape/catalyst-ui",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          development: "./src/index.ts",
          import: "./dist/index.js"
        },
        "./internal": { development: "./src/internal.ts" },
        "./vite": { types: "./src/vite.d.ts", import: "./src/vite.js" },
        "./styles.css": "./src/styles.css",
        "./built": { import: "./dist/built.js" }
      }
    },
    "clients/example/package.json": {
      name: "@work-shape/catalyst-example",
      exports: { "./seed": "./src/seed.ts" }
    }
  });
  const aliases = sourceAliases(root);
  expect(sourceAliases(root, true)["@work-shape/catalyst-ui/vite"]).toBe(
    resolve(root, "packages/ui/src/vite.d.ts")
  );
  expect(aliases).toEqual({
    "@work-shape/catalyst-example/seed": resolve(root, "clients/example/src/seed.ts"),
    "@work-shape/catalyst-ui/internal": resolve(root, "packages/ui/src/internal.ts"),
    "@work-shape/catalyst-ui/styles.css": resolve(root, "packages/ui/src/styles.css"),
    "@work-shape/catalyst-ui/vite": resolve(root, "packages/ui/src/vite.js"),
    "@work-shape/catalyst-ui": resolve(root, "packages/ui/src/index.ts")
  });
  expect(Object.keys(aliases).indexOf("@work-shape/catalyst-ui/internal")).toBeLessThan(
    Object.keys(aliases).indexOf("@work-shape/catalyst-ui")
  );
});

it("generates TypeScript paths, detects stale entries and preserves the test-support seam", async () => {
  const root = fixture({
    "capabilities/tsconfig.base.json": {
      compilerOptions: {
        paths: {
          "@work-shape/stale": ["gone.ts"],
          "#platform-test-support/*": ["../platform/tests/support/*"]
        }
      }
    },
    "platform/packages/core/package.json": {
      name: "@work-shape/catalyst-core",
      exports: { ".": { development: "./src/index.ts" } }
    },
    "capabilities/packages/private/package.json": {
      name: "@work-shape/catalyst-private",
      exports: { ".": "./src/index.ts" }
    }
  });
  const capabilities = join(root, "capabilities");
  expect(await syncSourcePaths(capabilities)).toBe(false);
  await syncSourcePaths(capabilities, true);
  expect(await syncSourcePaths(capabilities)).toBe(true);
  expect(JSON.parse(readFileSync(join(capabilities, "tsconfig.base.json"), "utf8"))).toEqual({
    compilerOptions: {
      paths: {
        "#platform-test-support/*": ["../platform/tests/support/*"],
        "@work-shape/catalyst-core": ["../platform/packages/core/src/index.ts"],
        "@work-shape/catalyst-private": ["packages/private/src/index.ts"]
      }
    }
  });
});

it("keeps the repository cache in sync with its package exports", async () => {
  expect(await syncSourcePaths(process.cwd())).toBe(true);
  expect(sourceAliases(process.cwd())["@work-shape/catalyst-chat-ui/tool-call"]).toBe(
    resolve("packages/chat-ui/src/chat/tools/tool-call.tsx")
  );
});

it("omits development-only subpaths without changing the published export surface", () => {
  expect(
    publishedExports({
      ".": { types: "./dist/index.d.ts", development: "./src/index.ts", import: "./dist/index.js" },
      "./internal": { development: "./src/internal.ts" },
      "./styles.css": "./src/styles.css"
    })
  ).toEqual({
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./styles.css": "./src/styles.css"
  });
});

it("refuses stale paths through the CLI and repairs them with its documented write command", async () => {
  const root = fixture({
    "tsconfig.base.json": { compilerOptions: { paths: {} } },
    "quality-baseline.json": { version: 1, entries: [] },
    "scopes.json": [],
    "packages/example/package.json": {
      name: "@work-shape/catalyst-example",
      exports: { ".": "./src/index.ts" }
    }
  });
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  const command = fileURLToPath(new URL("../packages/quality-config/check.mjs", import.meta.url));
  const stale = spawnSync(process.execPath, [command, "aliases"], { cwd: root, encoding: "utf8" });
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain("run catalyst-quality aliases --write");
  const scopedLint = spawnSync(
    process.execPath,
    [command, "lint", `--scope-file=${join(root, "scopes.json")}`],
    { cwd: root, encoding: "utf8" }
  );
  expect(scopedLint.status).toBe(1);
  expect(scopedLint.stderr).toContain("run catalyst-quality aliases --write");
  const repair = spawnSync(process.execPath, [command, "aliases", "--write"], { cwd: root });
  expect(repair.status).toBe(0);
  expect(await syncSourcePaths(root)).toBe(true);
});
