import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `dependency-filters` of docker/vivd-client.Dockerfile, run against a workspace laid out like
// the local workspace root: the client pins a released version of a workspace package, and an
// override of the root links it to local source.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "docker/vivd-client.Dockerfile"), "utf8");
const helper =
  /^COPY --chmod=755 <<'EOF' \/usr\/local\/bin\/dependency-filters\n([\s\S]*?)^EOF$/mu.exec(
    dockerfile
  )?.[1];

let workspace = "";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: workspace, encoding: "utf8", timeout: 60_000 });
}

function selected(filters: string[]): string[] {
  const listed = run("pnpm", [...filters, "list", "--depth", "-1", "--parseable"]);
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(workspace.length + 1))
    .sort();
}

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "client-image-dependency-filters-")));
  writeFileSync(join(workspace, "dependency-filters"), helper ?? "");
  writeJson(join(workspace, "package.json"), { name: "fixture-root", private: true });
  writeFileSync(
    join(workspace, "pnpm-workspace.yaml"),
    'packages:\n  - "client"\n  - "packages/*"\noverrides:\n  "@fixture/assembly": "workspace:*"\n'
  );
  writeJson(join(workspace, "client/package.json"), {
    name: "@fixture/client",
    version: "0.1.0",
    dependencies: { "@fixture/assembly": "1.0.0", react: "19.2.7" },
    devDependencies: { typescript: "6.0.3" }
  });
  writeJson(join(workspace, "packages/assembly/package.json"), {
    name: "@fixture/assembly",
    version: "2.0.0-dev",
    dependencies: { "@fixture/core": "workspace:*" }
  });
  writeJson(join(workspace, "packages/core/package.json"), {
    name: "@fixture/core",
    version: "2.0.0-dev"
  });
  writeJson(join(workspace, "packages/unused/package.json"), {
    name: "@fixture/unused",
    version: "2.0.0-dev",
    dependencies: { react: "19.2.7" }
  });
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("dependency-filters in the client image", () => {
  it("is defined in the Dockerfile", () => {
    expect(helper).toBeDefined();
  });

  it("selects a dependency linked only by an override, with its own dependencies", () => {
    // What the image built before: pnpm's own filter follows the pinned manifest, not the
    // override, and selects no package at all.
    expect(selected(["--filter", "@fixture/client^..."])).toEqual([]);

    const result = run("sh", ["dependency-filters", "@fixture/client"]);
    expect(result.status, result.stderr).toBe(0);
    const filters = result.stdout.split("\n").filter(Boolean);
    expect(filters).toEqual(["--filter=@fixture/assembly..."]);
    expect(selected(filters)).toEqual(["packages/assembly", "packages/core"]);
  });

  it("refuses a name that is no workspace project instead of printing no filter", () => {
    const result = run("sh", ["dependency-filters", "@fixture/client", "@fixture/missing"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no workspace project is named @fixture/missing");
    expect(result.stdout).toBe("");
  });

  it("refuses a package without workspace dependencies instead of printing no filter", () => {
    const result = run("sh", ["dependency-filters", "@fixture/unused"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@fixture/unused depend on no workspace project");
  });
});
