// Real pnpm proof; run after installing core, through the heavy lane.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { mirror } from "./mirror.mjs";
import { PUBLIC_PACKAGE_DIRS, repoRoot } from "./package-metadata.mjs";

const run = (cwd, ...args) =>
  execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
const readLock = (root) => parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));

test("public mirror has only reachable resolutions, matches core, installs frozen, builds and dry-runs publication", () => {
  const destination = mkdtempSync(join(tmpdir(), "catalyst-mirror-proof-"));
  try {
    mirror(repoRoot, destination);
    run(destination, "install", "--lockfile-only", "--ignore-scripts");
    const core = readLock(repoRoot);
    const mirrored = readLock(destination);
    assert.deepEqual(
      Object.keys(mirrored.importers).sort(),
      [".", ...PUBLIC_PACKAGE_DIRS.map((dir) => `packages/${dir}`)].sort()
    );
    const pending = [];
    for (const dir of PUBLIC_PACKAGE_DIRS) {
      const key = `packages/${dir}`;
      const manifest = JSON.parse(readFileSync(join(destination, key, "package.json"), "utf8"));
      assert.deepEqual(mirrored.importers[key], core.importers[key]);
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        assert.deepEqual(
          Object.keys(mirrored.importers[key][section] ?? {}).sort(),
          Object.keys(manifest[section] ?? {}).sort()
        );
        for (const [name, ref] of Object.entries(mirrored.importers[key][section] ?? {}))
          pending.push([name, ref.version]);
      }
    }
    const snapshots = new Set();
    const packages = new Set();
    while (pending.length) {
      const [name, version] = pending.pop();
      if (version.startsWith("link:")) continue;
      const key = Object.hasOwn(mirrored.snapshots, `${name}@${version}`)
        ? `${name}@${version}`
        : version;
      if (snapshots.has(key)) continue;
      const snapshot = mirrored.snapshots[key];
      assert.ok(snapshot, `Missing snapshot ${key}`);
      assert.deepEqual(snapshot, core.snapshots[key], `Changed core snapshot ${key}`);
      snapshots.add(key);
      packages.add(key.split("(")[0]);
      for (const section of ["dependencies", "optionalDependencies"])
        pending.push(...Object.entries(snapshot[section] ?? {}));
    }
    assert.deepEqual(
      Object.keys(mirrored.snapshots).sort(),
      [...snapshots].sort(),
      "Unreachable snapshot in public lock"
    );
    assert.deepEqual(
      Object.keys(mirrored.packages).sort(),
      [...packages].sort(),
      "Unreachable package in public lock"
    );
    for (const key of packages) assert.deepEqual(mirrored.packages[key], core.packages[key]);
    run(destination, "install", "--frozen-lockfile");
    // Compare the actual installed graphs, including dev/optional dependencies. Flatten pnpm's
    // deduped tree to edges so a different traversal order cannot hide or invent a version.
    const graph = (workspace, name) => {
      const [tree] = JSON.parse(
        run(workspace, "--filter", name, "ls", "--depth", "Infinity", "--json")
      );
      assert.ok(
        tree?.dependencies || tree?.devDependencies,
        "pnpm ls returned no installed dependencies"
      );
      const edges = new Set();
      const visit = (node, identity) => {
        for (const section of ["dependencies", "devDependencies", "optionalDependencies"])
          for (const [dependency, child] of Object.entries(node[section] ?? {})) {
            const id = `${dependency}@${child.version}`;
            edges.add(`${identity}:${section}:${id}`);
            visit(child, id);
          }
      };
      visit(tree, name);
      return [...edges].sort();
    };
    for (const dir of PUBLIC_PACKAGE_DIRS) {
      const { name } = JSON.parse(
        readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf8")
      );
      assert.deepEqual(
        graph(destination, name),
        graph(resolve(process.env.CORE_WORKSPACE_ROOT ?? repoRoot), name),
        `Installed resolutions changed for ${name}`
      );
    }
    run(destination, "build");
    run(destination, "release:publish", "--dry-run");
    console.log(
      `Mirror proof: ${Object.keys(mirrored.packages).length} reachable packages, ${Object.keys(mirrored.snapshots).length} snapshots, ${readFileSync(join(destination, "pnpm-lock.yaml"), "utf8").split("\n").length - 1} lock lines; four installed graphs identical`
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
