import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cut } from "../scripts/release/cut.mjs";

const scratch: string[] = [];
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture(version = "0.7.0", change = true, prefix = "catalyst-release-cut-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  // Real pnpm scripts, with no install or registry: verify the gate is called after the fold.
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "release-fixture",
      private: true,
      type: "module",
      scripts: { "generate:openapi": "node generate.mjs", "release:check": "node gate.mjs" }
    })
  );
  write(
    root,
    "generate.mjs",
    `import { readFileSync, writeFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('packages/api-contract/package.json', 'utf8'));
writeFileSync('packages/api-contract/openapi.json', JSON.stringify({ info: { version } }));
`
  );
  write(
    root,
    "gate.mjs",
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('packages/api-contract/package.json', 'utf8'));
const document = JSON.parse(readFileSync('packages/api-contract/openapi.json', 'utf8'));
if (document.info.version !== version || existsSync('changes/unreleased/test.md') ||
    !readFileSync('CHANGELOG.md', 'utf8').includes('## ' + version + ' — ')) process.exit(1);
writeFileSync('.git/gate-passed', version);
`
  );
  for (const directory of ["packages/api-contract", "packages/private", "clients/reference"]) {
    write(
      root,
      `${directory}/package.json`,
      JSON.stringify({
        name: `@fixture/${directory.replaceAll("/", "-")}`,
        version,
        private: true,
        dependencies: { "@fixture/packages-private": "workspace:*" }
      })
    );
  }
  write(root, "packages/api-contract/openapi.json", JSON.stringify({ info: { version } }));
  write(root, "CHANGELOG.md", "# Changelog\n\n## 0.6.0 — 2026-01-01\n\n- Old entry.\n");
  write(root, "changes/unreleased/.gitkeep", "");
  if (change)
    write(root, "changes/unreleased/test.md", "---\nsection: Added\n---\n\n- A new feature.\n");
  git(root, "init", "--initial-branch=scratch");
  git(root, "config", "user.name", "Release test");
  git(root, "config", "user.email", "release@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  git(root, "add", ".");
  git(root, "commit", "-m", "test: fixture");
  return root;
}

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release:cut", () => {
  it("cuts both repositories, preserves workspace dependencies and commits once after the gate", () => {
    const core = fixture();
    const companion = fixture();
    cut(["0.8.0", "--root", companion], core);
    for (const root of [core, companion]) {
      expect(JSON.parse(read(root, "package.json"))).toMatchObject({ version: "0.8.0" });
      for (const path of ["packages/api-contract", "packages/private", "clients/reference"]) {
        expect(JSON.parse(read(root, `${path}/package.json`))).toMatchObject({
          version: "0.8.0",
          dependencies: { "@fixture/packages-private": "workspace:*" }
        });
      }
      expect(read(root, "CHANGELOG.md")).toMatch(/## 0\.8\.0 — \d{4}-\d{2}-\d{2}/u);
      expect(read(root, "CHANGELOG.md")).toContain("- A new feature.");
      expect(read(root, "CHANGELOG.md")).toContain("## 0.6.0 — 2026-01-01");
      expect(existsSync(join(root, "changes/unreleased/test.md"))).toBe(false);
      expect(existsSync(join(root, "changes/unreleased/.gitkeep"))).toBe(true);
      expect(git(root, "rev-list", "--count", "HEAD")).toBe("2");
      expect(git(root, "log", "-1", "--format=%s")).toBe("chore(release): cut 0.8.0");
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(git(root, "tag")).toBe("");
    }
    expect(read(core, ".git/gate-passed")).toBe("0.8.0");
    expect(JSON.parse(read(core, "packages/api-contract/openapi.json"))).toEqual({
      info: { version: "0.8.0" }
    });
  });

  it.each(["0.8.0-rc.10", "0.8.0"])(
    "allows a version-only companion and prerelease progression to %s",
    (version) => {
      const core = fixture("0.8.0-rc.2");
      const companion = fixture("0.8.0-rc.2", false);
      cut([version, "--root", companion], core);
      expect(read(companion, "CHANGELOG.md")).toContain(`## ${version} — `);
      expect(git(companion, "status", "--porcelain")).toBe("");
    }
  );

  it("refuses non-SemVer, equal and lower versions without changing files", () => {
    const root = fixture("0.8.0-rc.10");
    const companion = fixture("0.8.0-rc.10");
    for (const version of [
      "latest",
      "v0.8.0",
      "0.8",
      "01.8.0",
      "0.8.0-01",
      "0.8.0-rc..1",
      "0.8.0+",
      "0.8.0+build.4",
      "0.8.0-rc.10+build.4",
      "0.8.0\n",
      "0.7.9",
      "0.8.0-rc.2",
      "0.8.0-alpha",
      "0.8.0-rc.10+other"
    ]) {
      expect(() => cut([version, "--root", companion], root)).toThrow();
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(git(root, "rev-list", "--count", "HEAD")).toBe("1");
    }
  });

  it.each(["untracked", "modified", "staged"])(
    "refuses a %s companion before touching core",
    (state) => {
      const core = fixture();
      const companion = fixture();
      const path = state === "untracked" ? "notes.txt" : "CHANGELOG.md";
      write(companion, path, "work in progress\n");
      if (state === "staged") git(companion, "add", path);
      expect(() => cut(["0.8.0", "--root", companion], core)).toThrow("dirty");
      expect(git(core, "status", "--porcelain")).toBe("");
      expect(git(core, "rev-list", "--count", "HEAD")).toBe("1");
      expect(read(companion, path)).toBe("work in progress\n");
    }
  );

  it("validates companion changes and versions before either repository is mutated", () => {
    const core = fixture();
    const companion = fixture("0.9.0");
    expect(() => cut(["0.8.0", "--root", companion], core)).toThrow("must be higher");
    write(companion, "changes/unreleased/bad.md", "bad change\n");
    git(companion, "add", ".");
    git(companion, "commit", "-m", "test: invalid change");
    expect(() => cut(["1.0.0", "--root", companion], core)).toThrow("front matter");
    expect(git(core, "status", "--porcelain")).toBe("");
    expect(git(companion, "status", "--porcelain")).toBe("");
    expect(() => cut(["1.0.0", "--root", core], core)).toThrow("different repository");
    expect(() => cut(["1.0.0", "--typo"], core)).toThrow("Usage:");
  });

  it("changes only the version line in pretty-printed real-shaped manifests", () => {
    const core = fixture();
    const companion = fixture();
    const path = "packages/private/package.json";
    const before =
      JSON.stringify(
        {
          name: "@fixture/private",
          version: "0.7.0",
          private: true,
          type: "module",
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
          files: ["dist"],
          scripts: { build: "tsup src/index.ts --format esm --dts" },
          dependencies: { "@fixture/core": "workspace:*" },
          config: { version: "0.7.0" }
        },
        null,
        2
      ) + "\n";
    for (const root of [core, companion]) {
      write(root, path, before);
      git(root, "add", path);
      git(root, "commit", "-m", "test: real-shaped manifest");
    }
    cut(["0.8.0", "--root", companion], core);
    for (const root of [core, companion])
      expect(read(root, path)).toBe(
        before.replace('  "version": "0.7.0",', '  "version": "0.8.0",')
      );
  });

  it("refuses a rerun after a successful cut", () => {
    const core = fixture();
    const companion = fixture();
    cut(["0.8.0", "--root", companion], core);
    const heads = [core, companion].map((root) => git(root, "rev-parse", "HEAD"));
    expect(() => cut(["0.8.0", "--root", companion], core)).toThrow("must be higher");
    expect([core, companion].map((root) => git(root, "rev-parse", "HEAD"))).toEqual(heads);
    for (const root of [core, companion]) expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("requires a companion and refuses current version drift before editing", () => {
    const core = fixture();
    const companion = fixture("0.6.0");
    expect(() => cut(["0.8.0"], core)).toThrow("--root");
    expect(() => cut(["0.8.0", "--root", companion], core)).toThrow(
      "must share one current version"
    );
    for (const root of [core, companion]) {
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(git(root, "rev-list", "--count", "HEAD")).toBe("1");
    }
  });

  it("explains a detached HEAD before changing either tree", () => {
    const core = fixture();
    const companion = fixture();
    git(companion, "checkout", "--detach");
    expect(() => cut(["0.8.0", "--root", companion], core)).toThrow(
      `${companion} needs a release branch.`
    );
    for (const root of [core, companion]) expect(git(root, "status", "--porcelain")).toBe("");
  });

  it.each(["finish", "undo"])(
    "reports actual SHAs and executable commands to %s a half-done cut",
    (recovery) => {
      const core = fixture("0.7.0", true, "catalyst-release cut's-");
      const companion = fixture("0.7.0", true, "catalyst-release cut's-");
      const roots = [core, companion];
      const before = roots.map((root) => git(root, "rev-parse", "HEAD"));
      // The first commit must already see the companion staged. The second then fails.
      write(
        core,
        ".git/hooks/pre-commit",
        `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
  cwd: ${JSON.stringify(companion)}, encoding: "utf8"
});
if (!staged.includes("package.json")) process.exit(1);
`
      );
      chmodSync(join(core, ".git/hooks/pre-commit"), 0o755);
      git(core, "config", "core.hooksPath", ".git/hooks");
      write(companion, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
      chmodSync(join(companion, ".git/hooks/pre-commit"), 0o755);
      git(companion, "config", "core.hooksPath", ".git/hooks");
      let report = "";
      try {
        cut(["0.8.0", "--root", companion], core);
      } catch (error) {
        report = error instanceof Error ? error.message : String(error);
      }
      expect(report).toContain(`${core}: committed cut at ${git(core, "rev-parse", "HEAD")}`);
      expect(report).toContain(`${companion}: cut staged, HEAD unchanged at ${before[1]}`);
      expect(report).toContain("do not rerun release:cut");
      expect(git(companion, "diff", "--cached", "--name-only")).toContain("package.json");
      expect(git(companion, "diff", "--name-only")).toBe("");
      git(companion, "config", "core.hooksPath", "/dev/null");
      const commands = report.split("\n").filter((line) => line.startsWith("'git'"));
      expect(commands).toHaveLength(3);
      for (const command of recovery === "finish" ? commands.slice(0, 1) : commands.slice(1))
        execFileSync("sh", ["-c", command]);
      for (const [index, root] of roots.entries()) {
        expect(git(root, "status", "--porcelain")).toBe("");
        if (recovery === "undo") expect(git(root, "rev-parse", "HEAD")).toBe(before[index]);
        else expect(git(root, "log", "-1", "--format=%s")).toBe("chore(release): cut 0.8.0");
      }
    }
  );

  it("leaves both cuts uncommitted when release:check fails", () => {
    const core = fixture();
    const companion = fixture();
    write(core, "gate.mjs", "process.exit(1);\n");
    git(core, "add", ".");
    git(core, "commit", "-m", "test: failing gate");
    const before = [core, companion].map((root) => git(root, "rev-parse", "HEAD"));
    expect(() => cut(["0.8.0", "--root", companion], core)).toThrow();
    expect([core, companion].map((root) => git(root, "rev-parse", "HEAD"))).toEqual(before);
    for (const root of [core, companion]) {
      expect(git(root, "diff", "--cached", "--name-only")).toBe("");
      expect(read(root, "CHANGELOG.md")).toContain("## 0.8.0 — ");
    }
  });
});
