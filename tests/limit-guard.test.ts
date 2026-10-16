import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guard = fileURLToPath(new URL("../packages/quality-config/limit-guard.mjs", import.meta.url));
const mark = "// check-limit";

/**
 * Commits `onMain` as limits.mjs on main, then each of `commits` on a branch, moves main on, and
 * runs the guard from the branch against main.
 */
function guardBranch(
  onMain: string,
  commits: { content: string; subject: string }[],
  title?: string
) {
  const directory = mkdtempSync(join(tmpdir(), "catalyst-limit-guard-"));
  const git = (...args: string[]) => {
    const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test"];
    expect(spawnSync("git", [...identity, ...args], { cwd: directory }).status).toBe(0);
  };
  const commit = (file: string, content: string, subject: string) => {
    writeFileSync(join(directory, file), content);
    git("add", "--all");
    git("commit", "--quiet", "--message", subject);
  };
  try {
    git("init", "--quiet", "--initial-branch", "main");
    commit("limits.mjs", onMain, "main");
    git("checkout", "--quiet", "-b", "change");
    for (const { content, subject } of commits) commit("limits.mjs", content, subject);
    // Main moves on after the branch left it; the guard compares with the merge base.
    git("checkout", "--quiet", "main");
    commit("other.mjs", `export const later = 1; ${mark}\n`, "feat: a later limit on main");
    git("checkout", "--quiet", "change");
    const args = title === undefined ? [guard, "main"] : [guard, "main", "HEAD", title];
    return spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const limits = (bytes: number) =>
  `const other = 1;\nconst LIMITS = {\n  "chat-ui": ${bytes}, ${mark}\n  ui: 500\n};\n`;

describe("limit guard", () => {
  it("passes a branch that leaves every limit as it is, or only marks an unchanged line", () => {
    const untouched = guardBranch(limits(650), [
      { content: limits(650).replace("other = 1", "other = 2"), subject: "feat: other" }
    ]);
    expect(untouched.stderr).toBe("");
    expect(untouched.status).toBe(0);

    const marked = guardBranch(limits(650), [
      { content: limits(650).replace("ui: 500", `ui: 500 ${mark}`), subject: "chore: mark" }
    ]);
    expect(marked.stderr).toBe("");
    expect(marked.status).toBe(0);
  });

  it("fails a feature branch that moves a limit, removes one or drops its marker", () => {
    const raised = guardBranch(limits(650), [
      { content: limits(1300), subject: "feat(chat-ui): connection dialog" }
    ]);
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain("A check limit moved outside a chore(limits) pull request");
    expect(raised.stderr).toContain(
      'limits.mjs: const LIMITS: "chat-ui": 650, -> "chat-ui": 1300,'
    );

    const unmarked = guardBranch(limits(650), [
      { content: limits(650).replace(` ${mark}`, ""), subject: "feat: quiet" }
    ]);
    expect(unmarked.status).toBe(1);

    const removed = guardBranch(limits(650), [
      { content: "const other = 1;\n", subject: "refactor: drop the table" }
    ]);
    expect(removed.status).toBe(1);
  });

  it("knows each limit by its place: a swap of two values moves both, a reformat moves none", () => {
    const jobs = (first: number, second: number) =>
      `jobs:\n  images:\n    timeout-minutes: ${first} # check-limit\n` +
      `  browser-shard:\n    timeout-minutes: ${second} # check-limit\n`;
    const swapped = guardBranch(jobs(20, 30), [{ content: jobs(30, 20), subject: "ci: swap" }]);
    expect(swapped.status).toBe(1);
    expect(swapped.stderr).toContain("jobs > images: timeout-minutes: 20 -> timeout-minutes: 30");
    expect(swapped.stderr).toContain(
      "jobs > browser-shard: timeout-minutes: 30 -> timeout-minutes: 20"
    );

    const separators = guardBranch(limits(650_000).replace("650000", "650_000"), [
      { content: limits(650_000), subject: "style: digits" }
    ]);
    expect(separators.stderr).toBe("");
    expect(separators.status).toBe(0);

    const reordered = guardBranch(limits(650), [
      {
        content: `const other = 1;\nconst LIMITS = {\n  ui: 500,\n  "chat-ui": 650, ${mark}\n};\n`,
        subject: "refactor: order"
      }
    ]);
    expect(reordered.stderr).toBe("");
    expect(reordered.status).toBe(0);

    // The last two entries trade places, so their trailing commas move; the values stay.
    const table = (entries: string[]) =>
      `const LIMITS = {\n${entries.map((entry) => `  ${entry}`).join(",\n")}\n};\n`;
    const last = [`"chat-server": 2_700_000 ${mark}`, `"postgres-store": 850_000 ${mark}`];
    const commaLast = table([`"chat-ui": 650_000 ${mark}`, ...last]).replace(
      /(\d) (\/\/ check-limit),/gu,
      "$1, $2"
    );
    const commaSwapped = table([`"chat-ui": 650_000 ${mark}`, ...last.reverse()]).replace(
      /(\d) (\/\/ check-limit),/gu,
      "$1, $2"
    );
    const swappedLast = guardBranch(commaLast, [
      { content: commaSwapped, subject: "refactor: order" }
    ]);
    expect(swappedLast.stderr).toBe("");
    expect(swappedLast.status).toBe(0);
  });

  it("fails a new limit in a table of limits, marked or not, and passes one elsewhere", () => {
    const table = (extra: string) =>
      `const other = 1;\nconst LIMITS = {\n  "chat-ui": 650_000, ${mark}\n${extra}};\n`;
    const unmarked = guardBranch(table(""), [
      { content: table(`  "new-package": 9_000_000,\n`), subject: "feat: new package" }
    ]);
    expect(unmarked.status).toBe(1);
    expect(unmarked.stderr).toContain(
      'limits.mjs: const LIMITS: (none) -> "new-package": 9_000_000, (unmarked)'
    );

    const marked = guardBranch(table(""), [
      { content: table(`  "new-package": 9_000_000, ${mark}\n`), subject: "feat: new package" }
    ]);
    expect(marked.status).toBe(1);

    const elsewhere = guardBranch(table(""), [
      { content: `${table("")}const later = 2;\n`, subject: "feat: later" }
    ]);
    expect(elsewhere.stderr).toBe("");
    expect(elsewhere.status).toBe(0);
  });

  it("fails a moved limit hidden in one chore(limits) commit of a feature branch", () => {
    const result = guardBranch(limits(650), [
      { content: limits(650).replace("other = 1", "other = 2"), subject: "feat: other" },
      { content: limits(1300).replace("other = 1", "other = 2"), subject: "chore(limits): raise" }
    ]);
    expect(result.status).toBe(1);
  });

  it("checks workflow timeouts on dispatch without a PR title", () => {
    const workflow = (minutes: number) =>
      `jobs:\n  static:\n    timeout-minutes: ${minutes} # check-limit\n`;
    const feature = guardBranch(
      workflow(9),
      [{ content: workflow(18), subject: "ci: raise the static timeout" }],
      ""
    );
    expect(feature.status).toBe(1);
    expect(feature.stderr).toContain("jobs > static: timeout-minutes: 9 -> timeout-minutes: 18");

    const limitsOnly = guardBranch(
      workflow(9),
      [
        { content: workflow(12), subject: "chore(limits): adjust the static timeout" },
        { content: workflow(18), subject: "chore(limits): finish the timeout adjustment" }
      ],
      ""
    );
    expect(limitsOnly.stderr).toBe("");
    expect(limitsOnly.status).toBe(0);
  });

  it("passes a moved limit in a chore(limits) branch or pull request, and only there", () => {
    expect(
      guardBranch(limits(1300), [{ content: limits(650), subject: "chore(limits): lower" }]).status
    ).toBe(0);
    expect(
      guardBranch(
        limits(1300),
        [{ content: limits(650), subject: "fix: lower" }],
        "chore(limits): chat-ui back to 650 kB"
      ).status
    ).toBe(0);
    expect(
      guardBranch(
        limits(650),
        [{ content: limits(1300), subject: "chore(limits): raise" }],
        "feat(chat-ui): connection dialog"
      ).status
    ).toBe(1);
  });
});
