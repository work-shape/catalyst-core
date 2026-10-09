import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compareBaseline } from "@vivd-catalyst/quality-config/baseline";

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

  it("holds test type errors to the count that CB-2b owns", () => {
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

  it("names CB-2b as the owner of every recorded test type error", async () => {
    const recorded: unknown = JSON.parse(
      await readFile(new URL("../quality-baseline.json", import.meta.url), "utf8")
    );
    const { entries } = z
      .object({ entries: z.array(z.object({ rule: z.string(), owner: z.string().min(1) })) })
      .parse(recorded);
    const owners = entries
      .filter((item) => item.rule === "typescript/test-errors")
      .map((item) => item.owner);
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set(["CB-2b"]));
  });
});
