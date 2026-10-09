import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baselineRises, compareBaseline } from "@vivd-catalyst/quality-config/baseline";

const entry = {
  target: "lint",
  rule: "test/rule",
  scope: "packages/example",
  count: 2,
  owner: "CB-2"
};
const baseline = { version: 1, entries: [entry] };
const finding = { target: entry.target, rule: entry.rule, scope: entry.scope };

describe("quality baseline", () => {
  it("accepts the measured count and rejects an increase", () => {
    expect(compareBaseline([finding, finding], baseline, "lint")).toEqual([]);
    expect(compareBaseline([finding, finding, finding], baseline, "lint")).toEqual([
      expect.stringContaining("repair the increase")
    ]);
  });

  it("rejects a stale higher baseline, including a completely removed rule", () => {
    expect(compareBaseline([finding], baseline, "lint")).toEqual([
      expect.stringContaining("lower the baseline")
    ]);
    expect(compareBaseline([], baseline, "lint")).toEqual([
      expect.stringContaining("measured 0, baseline 2")
    ]);
    expect(
      compareBaseline([finding], { version: 1, entries: [{ ...entry, count: 1 }] }, "lint")
    ).toEqual([]);
  });

  it("rejects unbaselined rules and counts independently per package and target", () => {
    expect(
      compareBaseline([{ ...finding, scope: "packages/other" }], baseline, "lint")
    ).toHaveLength(2);
    expect(compareBaseline([{ ...finding, target: "format" }], baseline, "format")).toHaveLength(1);
    expect(compareBaseline([], baseline, "format")).toEqual([]);
  });

  it("requires positive counts, owners and unique entries", () => {
    for (const entries of [[{ ...entry, owner: "" }], [{ ...entry, count: 0 }], [entry, entry]]) {
      expect(() => compareBaseline([], { version: 1, entries }, "lint")).toThrow();
    }
  });

  it("names the invalid entry", () => {
    const invalid = { ...entry, rule: "test/unowned", owner: "" };
    expect(() => compareBaseline([], { version: 1, entries: [entry, invalid] }, "lint")).toThrow(
      `Invalid baseline entry: ${JSON.stringify(invalid)}`
    );
  });

  it("names the files that hold the findings of a raised count, the first ten", () => {
    const inFile = (file: string) => ({ ...finding, file });
    expect(
      compareBaseline(
        [inFile("src/b.ts"), inFile("src/a.ts"), inFile("src/b.ts")],
        baseline,
        "lint"
      )
    ).toEqual([
      "lint|test/rule|packages/example: measured 3, baseline 2; repair the increase. Findings are in src/a.ts (1), src/b.ts (2)"
    ]);
    const many = Array.from({ length: 12 }, (_, index) => inFile(`src/${index + 10}.ts`));
    const [error] = compareBaseline(many, baseline, "lint");
    expect(error).toContain("src/19.ts (1) and 2 more");
    expect(error).not.toContain("src/20.ts");
  });

  it("reports baseline counts that were raised and entries that were added", () => {
    const other = { ...entry, scope: "packages/other" };
    expect(baselineRises(baseline, baseline)).toEqual([]);
    expect(baselineRises(baseline, { version: 1, entries: [{ ...entry, count: 1 }] })).toEqual([]);
    expect(baselineRises({ version: 1, entries: [entry, other] }, baseline)).toEqual([]);
    expect(
      baselineRises(baseline, { version: 1, entries: [{ ...entry, count: 3 }, other] })
    ).toEqual([
      "lint|test/rule|packages/example: count raised from 2 to 3",
      "lint|test/rule|packages/other: entry added with count 2"
    ]);
  });

  describe("guard for pull requests", () => {
    const guard = fileURLToPath(
      new URL("../packages/quality-config/baseline-guard.mjs", import.meta.url)
    );

    /** Commits one baseline on main and a second one on a branch, then runs the guard. */
    function guardBranch(onMain: object | undefined, onBranch: object) {
      const directory = mkdtempSync(join(tmpdir(), "catalyst-baseline-guard-"));
      const git = (...args: string[]) => {
        const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test"];
        const result = spawnSync("git", [...identity, ...args], { cwd: directory });
        expect(result.status).toBe(0);
      };
      const commit = (content: object | undefined, message: string) => {
        if (content)
          writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(content));
        git("add", "--all");
        git("commit", "--quiet", "--allow-empty", "--message", message);
      };
      try {
        git("init", "--quiet", "--initial-branch", "main");
        commit(onMain, "main");
        git("checkout", "--quiet", "-b", "change");
        commit(onBranch, "change");
        // Main moves on after the branch left it; the guard compares with the merge base.
        git("checkout", "--quiet", "main");
        commit({ version: 1, entries: [] }, "later main");
        git("checkout", "--quiet", "change");
        return spawnSync(process.execPath, [guard, "main"], { cwd: directory, encoding: "utf8" });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("passes on the merge with a base that gained an entry the branch never touched", () => {
      const directory = mkdtempSync(join(tmpdir(), "catalyst-baseline-guard-"));
      const git = (...args: string[]) => {
        const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test"];
        expect(spawnSync("git", [...identity, ...args], { cwd: directory }).status).toBe(0);
      };
      const commit = (file: string, content: object) => {
        writeFileSync(join(directory, file), JSON.stringify(content));
        git("add", "--all");
        git("commit", "--quiet", "--message", file);
      };
      try {
        git("init", "--quiet", "--initial-branch", "main");
        commit("quality-baseline.json", baseline);
        git("checkout", "--quiet", "-b", "change");
        commit("unrelated.json", {});
        git("checkout", "--quiet", "main");
        commit("quality-baseline.json", {
          version: 1,
          entries: [entry, { ...entry, scope: "packages/other" }]
        });
        // A hosted runner checks out the merge of the pull request into its base.
        git("checkout", "--quiet", "--detach");
        git("merge", "--quiet", "--no-ff", "--message", "merge", "change");
        const result = spawnSync(process.execPath, [guard, "main", "change"], {
          cwd: directory,
          encoding: "utf8"
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("passes when counts fall or stay and when the base has no baseline yet", () => {
      expect(guardBranch(baseline, { version: 1, entries: [{ ...entry, count: 1 }] }).status).toBe(
        0
      );
      expect(guardBranch(baseline, baseline).status).toBe(0);
      expect(guardBranch(undefined, baseline).status).toBe(0);
    });

    it("fails when a count rises or an entry is added, and says that counts may only fall", () => {
      const raised = guardBranch(baseline, { version: 1, entries: [{ ...entry, count: 3 }] });
      expect(raised.status).toBe(1);
      expect(raised.stderr).toContain("Counts may only fall");
      expect(raised.stderr).toContain("lint|test/rule|packages/example: count raised from 2 to 3");

      const added = guardBranch(baseline, {
        version: 1,
        entries: [entry, { ...entry, scope: "packages/other" }]
      });
      expect(added.status).toBe(1);
      expect(added.stderr).toContain("lint|test/rule|packages/other: entry added with count 2");
    });
  });

  it("holds a recorded test type error count in both directions", () => {
    const errors = {
      target: "types:tests",
      rule: "typescript/test-errors",
      scope: "tests",
      count: 2,
      owner: "CB-2b"
    };
    const measured = { target: errors.target, rule: errors.rule, scope: errors.scope };
    const recorded = { version: 1, entries: [entry, errors] };
    expect(compareBaseline([measured, measured], recorded, "types:tests")).toEqual([]);
    expect(compareBaseline([measured, measured, measured], recorded, "types:tests")).toEqual([
      "types:tests|typescript/test-errors|tests: measured 3, baseline 2; repair the increase"
    ]);
    expect(compareBaseline([measured], recorded, "types:tests")).toEqual([
      "types:tests|typescript/test-errors|tests: measured 1, baseline 2; lower the baseline"
    ]);
  });

  it("records no exception for test type errors", async () => {
    const recorded: unknown = JSON.parse(
      await readFile(new URL("../quality-baseline.json", import.meta.url), "utf8")
    );
    const { entries } = z
      .object({ entries: z.array(z.object({ rule: z.string(), owner: z.string().min(1) })) })
      .parse(recorded);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((item) => item.rule === "typescript/test-errors")).toEqual([]);
  });
});
